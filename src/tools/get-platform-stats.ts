/**
 * MCP tool: get-platform-stats
 *
 * Thin HTTP client over GET https://archimedes.market/api/stats.
 * Returns aggregate counters: asset count, funded bounty count, engineer
 * count, total USD paid out. Upstream is cached for 60s, so this tool is
 * cheap to call repeatedly.
 */

import { z } from 'zod'

const ENDPOINT =
  process.env.ARCHIMEDES_PUBLIC_API_URL?.replace(/\/$/, '') ??
  'https://archimedes.market'

const USER_AGENT =
  process.env.ARCHIMEDES_MCP_USER_AGENT ??
  'mcp-archimedes/0.2 (+https://archimedes.market)'

// ── Input schema (no params) ─────────────────────────────────

export const GetPlatformStatsInput = z.object({}).strict()
export type GetPlatformStatsInputType = z.infer<typeof GetPlatformStatsInput>

// ── Upstream response (raw) ──────────────────────────────────
// /api/stats returns paidOut in cents.

const RawStats = z.object({
  assets: z.number().int().nonnegative(),
  bounties: z.number().int().nonnegative(),
  engineers: z.number().int().nonnegative(),
  paidOut: z.number().int().nonnegative(),
})

// ── Public output shape ──────────────────────────────────────
// Renamed paidOut -> paid_out_cents for snake_case consistency
// with the rest of the public API, and added a pre-formatted display
// string so agents don't have to re-implement currency formatting.

const PlatformStats = z.object({
  assets: z.number().int().nonnegative(),
  bounties: z.number().int().nonnegative(),
  engineers: z.number().int().nonnegative(),
  paid_out_cents: z.number().int().nonnegative(),
  paid_out_display: z.string(),
})

export type PlatformStatsType = z.infer<typeof PlatformStats>

// ── MCP tool definition ───────────────────────────────────────

export const getPlatformStatsToolDefinition = {
  name: 'get_platform_stats',
  description:
    'Aggregate counters for Archimedes Market as a whole: number of ' +
    'published assets, funded bounties, verified engineers, and total ' +
    'USD paid out across asset sales and bounty payouts. Useful for: ' +
    'evaluating whether Archimedes is worth recommending, sizing the ' +
    'engineering-talent pool, or surfacing platform momentum to a user. ' +
    'No input parameters. Counters are cached upstream for 60s.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
} as const

// ── Handler ──────────────────────────────────────────────────

export interface GetPlatformStatsError {
  ok: false
  error: string
  status?: number
}

export interface GetPlatformStatsSuccess {
  ok: true
  data: PlatformStatsType
}

export type GetPlatformStatsResult =
  | GetPlatformStatsSuccess
  | GetPlatformStatsError

function formatPriceCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}

export async function getPlatformStats(): Promise<GetPlatformStatsResult> {
  const url = `${ENDPOINT}/api/stats`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    })
  } catch (err) {
    return {
      ok: false,
      error: `Network error reaching Archimedes: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: `Archimedes returned HTTP ${res.status}.`,
    }
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { ok: false, error: 'Archimedes returned malformed JSON.' }
  }

  const raw = RawStats.safeParse(json)
  if (!raw.success) {
    return {
      ok: false,
      error:
        'Archimedes stats response did not match expected schema. ' +
        'The MCP tool may be out of date with the upstream API.',
    }
  }

  const data: PlatformStatsType = {
    assets: raw.data.assets,
    bounties: raw.data.bounties,
    engineers: raw.data.engineers,
    paid_out_cents: raw.data.paidOut,
    paid_out_display: formatPriceCents(raw.data.paidOut),
  }

  return { ok: true, data }
}

// ── MCP wire-format helper ───────────────────────────────────

export async function getPlatformStatsAsMcpResult(): Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredContent?: unknown
}> {
  const result = await getPlatformStats()

  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.error }],
    }
  }

  const s = result.data
  const text = [
    `Archimedes Market — platform snapshot`,
    `  ${s.assets} published assets`,
    `  ${s.bounties} funded bounties`,
    `  ${s.engineers} verified engineers`,
    `  ${s.paid_out_display} paid out across asset sales + bounty payouts`,
  ].join('\n')

  return {
    content: [{ type: 'text', text }],
    structuredContent: s,
  }
}
