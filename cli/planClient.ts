/**
 * @fileoverview Thin HTTP client to the Ref plan server for the `ref` CLI.
 *
 * Deliberately dumb: it forwards the API key and returns parsed JSON. All
 * tunable behavior (the guidance text, the review verdict semantics) lives
 * server-side so an installed CLI rarely needs to change.
 */

import axios, { type AxiosError } from 'axios'

/** Subset of the plan-server review-status response the watch needs. */
export interface ReviewStatusResponse {
  planId: string
  status: string | null
  settled: boolean
  pending: boolean
  reviewRequestCount: number
  latestReview: {
    status: string
    reviewerEmail: string
    overallComment?: string
    commentCount: number
    submittedAt: string
  } | null
  planTitle?: string
  timedOut: boolean
}

export interface GuidanceResponse {
  enabled: boolean
  version: string
  /** The pulled guidance text, or empty when guidance is killed/disabled. */
  guidance: string
}

export interface WhoamiResponse {
  ok: boolean
  uid: string
  email: string
  teamId: string | null
  authType: string
}

/** Raised for an authenticated request that the server rejected with 401/403. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/** Raised for a 404 — a permanent condition the watch should not retry. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return { 'x-ref-api-key': apiKey, 'X-Ref-Api-Key': apiKey }
}

function isAuthStatus(error: AxiosError): boolean {
  return error.response?.status === 401 || error.response?.status === 403
}

/**
 * GET /api/plans/:planId/review-status. When `waitMs > 0`, requests the
 * server-side long-poll (`?wait=1`) and gives the socket headroom past the
 * server window so the wait resolves server-side, not by a client timeout.
 */
export async function fetchReviewStatus(
  baseUrl: string,
  apiKey: string,
  planId: string,
  waitMs: number,
): Promise<ReviewStatusResponse> {
  const wait = waitMs > 0
  const url = `${baseUrl}/api/plans/${encodeURIComponent(planId)}/review-status`
  try {
    const response = await axios.get<ReviewStatusResponse>(url, {
      headers: authHeaders(apiKey),
      params: wait ? { wait: 1 } : {},
      // Let the held long-poll resolve server-side; only bail well past it.
      timeout: wait ? waitMs + 15_000 : 15_000,
    })
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error) && isAuthStatus(error)) {
      throw new AuthError('Authentication failed')
    }
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new NotFoundError(`Plan not found: ${planId}`)
    }
    throw error
  }
}

/** GET /api/guidance — short timeout; auth failures surface as AuthError. */
export async function fetchGuidance(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<GuidanceResponse> {
  const url = `${baseUrl}/api/guidance`
  try {
    const response = await axios.get<GuidanceResponse>(url, {
      headers: authHeaders(apiKey),
      timeout: timeoutMs,
    })
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error) && isAuthStatus(error)) {
      throw new AuthError('Authentication failed')
    }
    throw error
  }
}

/** GET /plugins/whoami — validates a key and returns the resolved identity. */
export async function fetchWhoami(baseUrl: string, apiKey: string): Promise<WhoamiResponse> {
  const url = `${baseUrl}/plugins/whoami`
  try {
    const response = await axios.get<WhoamiResponse>(url, {
      headers: authHeaders(apiKey),
      timeout: 15_000,
    })
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error) && isAuthStatus(error)) {
      throw new AuthError('Authentication failed')
    }
    throw error
  }
}
