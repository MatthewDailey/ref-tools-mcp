/**
 * @fileoverview `ref login` — browser-delegated, guided API-key paste.
 *
 * The terminal never creates accounts: it opens the browser (whose existing
 * signup transparently handles first-timers) and receives a credential back via
 * a guided paste. The key is validated against the plan server, then written to
 * `~/.ref/config.json` (0600). Env `REF_API_KEY` still wins at read time, so a
 * key written here is a convenience, not a lock-in.
 *
 * Standalone + resumable: a dropped signup is never a dead end — just re-run.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { AuthError, fetchWhoami } from './planClient.js'
import {
  readConfig,
  resolveAppUrl,
  resolvePlanBaseUrl,
  resolveRefAppUrl,
  writeConfig,
} from './config.js'

interface LoginArgs {
  key?: string
  noBrowser: boolean
}

function parseArgs(argv: string[]): LoginArgs {
  const args: LoginArgs = { noBrowser: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--key') args.key = argv[++i]
    else if (arg === '--no-browser') args.noBrowser = true
  }
  return args
}

/** Best-effort: open a URL in the default browser; never fail the flow on it. */
function openBrowser(url: string): void {
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Headless / no browser — the printed URL is the fallback.
  }
}

export async function runLogin(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const config = readConfig()
  const baseUrl = resolvePlanBaseUrl(config)
  const refAppUrl = resolveRefAppUrl(config)
  const appUrl = resolveAppUrl(config)
  const keysUrl = `${refAppUrl}/keys?source=cli`

  let apiKey = args.key

  if (!apiKey) {
    process.stderr.write('\nRef sign-in\n===========\n\n')
    process.stderr.write(`Opening ${keysUrl} in your browser.\n`)
    process.stderr.write('Sign in (or sign up), create an API key, and copy it.\n\n')
    if (!args.noBrowser) openBrowser(keysUrl)

    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      apiKey = (await rl.question('Paste your Ref API key: ')).trim()
    } finally {
      rl.close()
    }
  }

  if (!apiKey) {
    process.stderr.write('No API key provided. Run `ref login` again when ready.\n')
    return 1
  }

  // Validate before persisting so we never write a dead key.
  process.stderr.write('\nValidating…\n')
  try {
    const whoami = await fetchWhoami(baseUrl, apiKey)
    writeConfig({
      apiKey,
      apiBaseUrl: baseUrl,
      appUrl,
      refAppUrl,
    })
    process.stderr.write(`\n✓ Signed in as ${whoami.email || whoami.uid}\n`)
    process.stderr.write(`  Config written to ~/.ref/config.json\n`)
    return 0
  } catch (error) {
    if (error instanceof AuthError) {
      process.stderr.write(
        '\n✗ That key was rejected. Double-check it and run `ref login` again.\n',
      )
      return 1
    }
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`\n✗ Could not reach Ref to validate the key: ${message}\n`)
    return 1
  }
}
