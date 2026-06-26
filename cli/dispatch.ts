/**
 * @fileoverview Subcommand dispatch for the `ref` CLI.
 *
 * The package grew from "an MCP server" into "the `ref` CLI": a bare invocation
 * (how MCP clients launch it) still boots the stdio server, while explicit
 * subcommands — `reviews`, `guidance`, `login` — drive the local-agent loop.
 * Keep this surface deliberately small: it's a thin agent-invoked footprint,
 * not a CLI product.
 */

import pkg from '../package.json'
import { runGuidance } from './guidance.js'
import { runLogin } from './login.js'
import { runReviews } from './reviews.js'

const CLI_COMMANDS = new Set(['reviews', 'guidance', 'login', 'help', '--help', '-h', '--version'])

/**
 * True when argv[2] is a CLI subcommand. A bare invocation or `mcp` is NOT a CLI
 * command — those fall through to the MCP server for backward compatibility.
 */
export function isCliCommand(command: string | undefined): boolean {
  return command != null && CLI_COMMANDS.has(command)
}

const HELP = `ref ${pkg.version} — Ref CLI

Usage: ref <command> [options]

Commands:
  mcp                       Run the Ref documentation-search MCP server (default)
  reviews <planId> --watch  Block until a plan's review settles, then print the verdict
  guidance                  Print the server-authored planning guidance (cached, fail-safe)
  login                     Sign in and store your API key in ~/.ref/config.json
  help                      Show this help

Run with no command to start the MCP server (how MCP clients launch it).
`

export async function runCliCommand(command: string | undefined, rest: string[]): Promise<number> {
  switch (command) {
    case 'reviews':
      return runReviews(rest)
    case 'guidance':
      return runGuidance(rest)
    case 'login':
      return runLogin(rest)
    case '--version':
      process.stdout.write(`${pkg.version}\n`)
      return 0
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return 0
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
      return 1
  }
}
