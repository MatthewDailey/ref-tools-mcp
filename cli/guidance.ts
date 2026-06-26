/**
 * @fileoverview `ref guidance` — pull the server-authored planning guidance.
 *
 * The load-bearing requirement here is fail-safe: this runs on a hot path with
 * an unbounded public install base, so it must NEVER hang or hard-fail. It
 * bounds the fetch with a short timeout, degrades to the last cache, then to a
 * baseline line, and always exits 0. A fresh cache (< TTL) is served without
 * any network call, so steady-state adds zero latency.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { AuthError, fetchGuidance } from './planClient.js'
import {
  getConfigDir,
  getGuidanceCachePath,
  readConfig,
  resolveApiKey,
  resolvePlanBaseUrl,
} from './config.js'

/** Serve a fresh cache without a network call; refetch past this age. */
const CACHE_TTL_MS = 60 * 60 * 1000 // ~1h: edits propagate within an hour
const FETCH_TIMEOUT_MS = 5_000

/**
 * The never-worse-than-baseline fallback when there is no cache and the fetch
 * fails. Intentionally featherweight — it must never read as a hard gate.
 */
const BASELINE_GUIDANCE =
  'Use your judgment. For a substantial or multi-step change, consider drafting a Ref plan ' +
  'and requesting a review before implementing.'

interface GuidanceCache {
  version: string
  enabled: boolean
  guidance: string
  fetchedAt: string
}

interface GuidanceArgs {
  json: boolean
  refresh: boolean
}

function parseArgs(argv: string[]): GuidanceArgs {
  const args: GuidanceArgs = { json: false, refresh: false }
  for (const arg of argv) {
    if (arg === '--json') args.json = true
    else if (arg === '--refresh' || arg === '--no-cache') args.refresh = true
  }
  return args
}

function readCache(): GuidanceCache | undefined {
  const path = getGuidanceCachePath()
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GuidanceCache
  } catch {
    return undefined
  }
}

function writeCache(cache: GuidanceCache): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(getGuidanceCachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // A read-only home shouldn't break the loop — degrade silently.
  }
}

function cacheAgeMs(cache: GuidanceCache): number {
  const fetched = Date.parse(cache.fetchedAt)
  if (!Number.isFinite(fetched)) return Number.POSITIVE_INFINITY
  const age = Date.now() - fetched
  // A negative age means a backward clock (or bad timestamp); treat it as stale
  // so it can't pin the cache as permanently-fresh and suppress refetch.
  return age < 0 ? Number.POSITIVE_INFINITY : age
}

function emit(
  args: GuidanceArgs,
  payload: { version: string; enabled: boolean; guidance: string },
  source: 'cache' | 'network' | 'baseline',
): number {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...payload, source })}\n`)
  } else if (payload.guidance) {
    process.stdout.write(`${payload.guidance}\n`)
  }
  // Always succeed: the loop must never break because guidance was unavailable.
  return 0
}

export async function runGuidance(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const config = readConfig()
  const apiKey = resolveApiKey(config)
  const baseUrl = resolvePlanBaseUrl(config)

  const cache = readCache()

  // Fresh cache: serve without touching the network.
  if (!args.refresh && cache && cacheAgeMs(cache) < CACHE_TTL_MS) {
    return emit(args, cache, 'cache')
  }

  // No key: can't fetch. Degrade to cache, else baseline.
  if (!apiKey) {
    if (cache) return emit(args, cache, 'cache')
    return emit(
      args,
      { version: 'baseline', enabled: false, guidance: BASELINE_GUIDANCE },
      'baseline',
    )
  }

  try {
    const payload = await fetchGuidance(baseUrl, apiKey, FETCH_TIMEOUT_MS)
    const fresh: GuidanceCache = {
      version: payload.version,
      enabled: payload.enabled,
      guidance: payload.guidance,
      fetchedAt: new Date().toISOString(),
    }
    writeCache(fresh)
    return emit(args, fresh, 'network')
  } catch (error) {
    // AuthError, timeout, non-200, network — all fail safe. Never throw.
    if (cache) return emit(args, cache, 'cache')
    const stale = error instanceof AuthError ? 'auth' : 'unreachable'
    return emit(
      args,
      { version: `baseline-${stale}`, enabled: false, guidance: BASELINE_GUIDANCE },
      'baseline',
    )
  }
}
