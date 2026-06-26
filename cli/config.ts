/**
 * @fileoverview Local config + credential resolution for the `ref` CLI.
 *
 * The CLI is a thin HTTP client to the Ref plan server. All it needs locally is
 * (1) an API key and (2) the plan-server base URL. Both are resolved with env
 * taking precedence over the on-disk `~/.ref/config.json` written by the
 * installer / `ref login`, so containers and CI can override without a file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Shape of `~/.ref/config.json` (shared with the install script). */
export interface RefConfig {
  apiKey?: string
  /** Plan-server base URL (e.g. https://api.plan.ref.tools). */
  apiBaseUrl?: string
  /** Legacy alias for apiBaseUrl, honored on read. */
  baseUrl?: string
  /** Plan web app origin (e.g. https://plan.ref.tools). */
  appUrl?: string
  /** Main Ref app origin (e.g. https://ref.tools), home of the keys page. */
  refAppUrl?: string
}

const DEFAULT_PLAN_BASE_URL = 'https://api.plan.ref.tools'
const DEFAULT_APP_URL = 'https://plan.ref.tools'
const DEFAULT_REF_APP_URL = 'https://ref.tools'

export function getConfigDir(): string {
  return join(homedir(), '.ref')
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export function getGuidanceCachePath(): string {
  return join(getConfigDir(), 'guidance-cache.json')
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Read `~/.ref/config.json`, returning an empty object if missing/unparseable. */
export function readConfig(): RefConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RefConfig
  } catch {
    return {}
  }
}

/** Merge updates into `~/.ref/config.json`, creating it `0600` if needed. */
export function writeConfig(updates: Partial<RefConfig>): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const merged = { ...readConfig(), ...updates }
  const path = getConfigPath()
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Resolve the API key. Env wins so CI / containers / a remote agent machine can
 * override a key written by `ref login` on a different host.
 */
export function resolveApiKey(config: RefConfig = readConfig()): string | undefined {
  return process.env.REF_API_KEY || process.env.REF_ALPHA || config.apiKey || undefined
}

/**
 * Resolve the plan-server base URL (where review-status + guidance live). This
 * is distinct from the doc-search API (`REF_URL` / api.ref.tools).
 */
export function resolvePlanBaseUrl(config: RefConfig = readConfig()): string {
  const fromEnv = process.env.REF_PLAN_URL || process.env.REF_API_BASE_URL
  const resolved = fromEnv || config.apiBaseUrl || config.baseUrl || DEFAULT_PLAN_BASE_URL
  return trimTrailingSlash(resolved)
}

/** Resolve the plan web app origin (used for plan links). */
export function resolveAppUrl(config: RefConfig = readConfig()): string {
  return trimTrailingSlash(process.env.REF_APP_PLAN_URL || config.appUrl || DEFAULT_APP_URL)
}

/** Resolve the main Ref app origin (home of the API-key page for `ref login`). */
export function resolveRefAppUrl(config: RefConfig = readConfig()): string {
  return trimTrailingSlash(process.env.REF_APP_URL || config.refAppUrl || DEFAULT_REF_APP_URL)
}

export { dirname, join }
