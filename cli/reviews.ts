/**
 * @fileoverview `ref reviews <planId> --watch` — block on a plan's review verdict.
 *
 * Mirrors the `gh pr checks --watch` mental model the model already knows: it
 * re-issues the server long-poll until the review settles, then prints the
 * verdict. The verdict goes to stdout (pipeable); human status + comments go to
 * stderr. Crucially it survives a harness shell/tool timeout — each server poll
 * returns within a bounded window, so a killed `--watch` just needs re-running,
 * and the agent is told exactly that.
 */

import {
  AuthError,
  NotFoundError,
  fetchReviewStatus,
  type ReviewStatusResponse,
} from './planClient.js'
import { readConfig, resolveApiKey, resolvePlanBaseUrl } from './config.js'

/** Server holds its long-poll for ~25s; give the socket headroom past that. */
const SERVER_WAIT_WINDOW_MS = 25_000
const DEFAULT_INTERVAL_MS = 2_000
const MAX_CONSECUTIVE_ERRORS = 5
/** Floor for error-path backoff so `--interval 0` can't busy-loop on failures. */
const ERROR_BACKOFF_BASE_MS = 1_000

interface ReviewsArgs {
  planId?: string
  watch: boolean
  intervalMs: number
  json: boolean
}

function parseArgs(argv: string[]): ReviewsArgs {
  const args: ReviewsArgs = { watch: false, intervalMs: DEFAULT_INTERVAL_MS, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--watch' || arg === '-w') {
      args.watch = true
    } else if (arg === '--json') {
      args.json = true
    } else if (arg === '--interval') {
      // Only consume the next token as the value if it's a valid number;
      // otherwise leave it (it may be the planId) and ignore the bad flag.
      const next = argv[i + 1]
      const seconds = Number(next)
      if (next !== undefined && Number.isFinite(seconds) && seconds >= 0) {
        args.intervalMs = seconds * 1000
        i++
      }
    } else if (arg && !arg.startsWith('-') && !args.planId) {
      args.planId = arg
    }
  }
  return args
}

function verdictLabel(status: string | null): string {
  switch (status) {
    case 'plan_approved':
      return '✓ Approved'
    case 'changes_requested':
      return '✗ Changes requested'
    case 'commented':
      return '✱ Commented'
    case 'declined':
      return '⊘ Review declined'
    default:
      return status ?? 'unknown'
  }
}

function printSettled(snapshot: ReviewStatusResponse, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`)
  } else {
    // stdout: the raw verdict, for piping / programmatic reads.
    process.stdout.write(`${snapshot.status}\n`)
  }

  // stderr: human-facing status + the denormalized overall comment.
  process.stderr.write(`\n${verdictLabel(snapshot.status)}\n`)
  const review = snapshot.latestReview
  if (review) {
    if (review.overallComment) {
      process.stderr.write(`\n${review.reviewerEmail} wrote:\n${review.overallComment}\n`)
    }
    if (review.commentCount > 0) {
      process.stderr.write(
        `\n${review.commentCount} inline comment${review.commentCount === 1 ? '' : 's'} — ` +
          `read them with the Plan MCP Comments tool (action: "list").\n`,
      )
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runReviews(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const config = readConfig()
  const apiKey = resolveApiKey(config)
  const baseUrl = resolvePlanBaseUrl(config)

  if (!args.planId) {
    process.stderr.write('Usage: ref reviews <planId> [--watch] [--interval <seconds>] [--json]\n')
    return 1
  }
  if (!apiKey) {
    process.stderr.write('Not authenticated. Run `ref login` to sign in.\n')
    return 1
  }

  // Single read: report current status and exit.
  if (!args.watch) {
    try {
      const snapshot = await fetchReviewStatus(baseUrl, apiKey, args.planId, 0)
      if (args.json) {
        process.stdout.write(`${JSON.stringify(snapshot)}\n`)
      } else {
        process.stdout.write(`${snapshot.status ?? 'none'}\n`)
        process.stderr.write(
          `${snapshot.settled ? verdictLabel(snapshot.status) : 'Not settled'}\n`,
        )
      }
      return 0
    } catch (error) {
      return reportError(error)
    }
  }

  process.stderr.write(`Waiting for a review verdict on ${args.planId}…\n`)
  let consecutiveErrors = 0

  for (;;) {
    let snapshot: ReviewStatusResponse
    try {
      snapshot = await fetchReviewStatus(baseUrl, apiKey, args.planId, SERVER_WAIT_WINDOW_MS)
      consecutiveErrors = 0
    } catch (error) {
      if (error instanceof AuthError) {
        process.stderr.write(
          'Authentication failed — run `ref login` to re-authenticate, then retry.\n',
        )
        return 1
      }
      // A 404 is permanent (wrong/deleted planId) — fail fast, don't retry.
      if (error instanceof NotFoundError) {
        process.stderr.write(`${error.message} — check the plan ID.\n`)
        return 1
      }
      consecutiveErrors++
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return reportError(error)
      }
      // Transient network error: back off and keep waiting.
      process.stderr.write(
        `Network error reaching Ref (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), retrying…\n`,
      )
      await sleep(
        Math.min(Math.max(args.intervalMs, ERROR_BACKOFF_BASE_MS) * consecutiveErrors, 15_000),
      )
      continue
    }

    if (snapshot.settled) {
      printSettled(snapshot, args.json)
      return 0
    }

    // No review was ever requested for this plan — nothing to wait on.
    if (snapshot.reviewRequestCount === 0 && !snapshot.pending) {
      process.stderr.write(
        'No review has been requested for this plan. Request a review first, then watch.\n',
      )
      return 0
    }

    // Window elapsed without settling — re-issue so an arbitrarily long human
    // review survives even if the harness kills any single `--watch` call.
    if (args.intervalMs > 0) await sleep(args.intervalMs)
  }
}

function reportError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Error: ${message}\n`)
  return 1
}
