/**
 * MCP tool: search-bounties
 *
 * Thin HTTP client over GET https://archimedes.market/api/public/bounties.
 * The tool is intentionally stateless — every call hits the upstream endpoint,
 * which is cached at the edge (s-maxage=60, swr=120). No local DB, no auth.
 *
 * Contract stays in sync with lib/public-api/schemas.ts in the archimedes-market
 * repo. Input fields here mirror BountyQuerySchema; output mirrors
 * PublicBountyListSchema. If the upstream schema changes, this file must change.
 */

import { z } from 'zod'

// ── Endpoint ──────────────────────────────────────────────────
// Allow override via env so we can point a local MCP build at a
// preview deployment, but default to production.
const BOUNTIES_ENDPOINT =
  process.env.ARCHIMEDES_PUBLIC_API_URL?.replace(/\/$/, '') ??
  'https://archimedes.market'

const USER_AGENT =
  process.env.ARCHIMEDES_MCP_USER_AGENT ??
  'mcp-archimedes/0.1 (+https://archimedes.market)'

// ── Input schema ──────────────────────────────────────────────
// Mirrors BountyQuerySchema in the upstream repo. Kept loose on
// the client (no transform) so we forward the caller's literal
// input — the server has its own canonical validator.

export const SearchBountiesInput = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Free-text search across bounty title and description. ' +
        'Use plain English — no SQL, no wildcards.'
    ),
  category: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Mission type filter. Common values: "software", "hardware", ' +
        '"creative", "research", "mcp". Omit to include all categories.'
    ),
  status: z
    .enum(['open', 'funded', 'all'])
    .optional()
    .default('open')
    .describe(
      '"open" = biddable now (escrow locked). ' +
        '"funded" = any bounty that touched real money (locked OR released). ' +
        '"all" = no status filter, includes unfunded drafts.'
    ),
  min_price_cents: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .describe('Minimum bounty payout in cents (USD).'),
  max_price_cents: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .describe('Maximum bounty payout in cents (USD).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Page size, 1–50.'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .default(0)
    .describe('Pagination offset.'),
})

export type SearchBountiesInputType = z.infer<typeof SearchBountiesInput>

// ── Output schema (mirrors PublicBountyListSchema) ────────────

const PublicBounty = z.object({
  id: z.string().uuid(),
  display_id: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  category: z.string().nullable(),
  complexity: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  escrow_status: z.enum(['unfunded', 'locked', 'released']),
  is_funded: z.boolean(),
  price_cents: z.number().int().nonnegative(),
  currency: z.literal('USD'),
  deadline_iso: z.string(),
  created_at_iso: z.string(),
  cover_image_url: z.string().url().nullable(),
  requirements_summary: z.array(z.string()),
  deliverables_summary: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
    })
  ),
  url: z.string().url(),
})

const PublicBountyList = z.object({
  items: z.array(PublicBounty),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  query_echo: z.object({
    query: z.string().nullable(),
    category: z.string().nullable(),
    status: z.enum(['open', 'funded', 'all']),
    min_price_cents: z.number().nullable(),
    max_price_cents: z.number().nullable(),
  }),
})

export type PublicBountyType = z.infer<typeof PublicBounty>
export type PublicBountyListType = z.infer<typeof PublicBountyList>

// ── MCP tool definition ───────────────────────────────────────

export const searchBountiesToolDefinition = {
  name: 'search_bounties',
  description:
    'Search open bounties on Archimedes Market — a marketplace for ' +
    'verified engineering work (software, hardware, MCP servers, CAD, EDA). ' +
    'Returns a paginated list with bounty title, summary, payout in cents, ' +
    'deadline, and a public URL. Use this to discover paid work that ' +
    'matches an agent\'s capabilities, or to surface engineering tasks ' +
    'a user can post a submission to.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: SearchBountiesInput.shape.query.description,
        maxLength: 200,
      },
      category: {
        type: 'string',
        description: SearchBountiesInput.shape.category.description,
        maxLength: 64,
      },
      status: {
        type: 'string',
        enum: ['open', 'funded', 'all'],
        default: 'open',
        description: SearchBountiesInput.shape.status.description,
      },
      min_price_cents: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000_000,
        description: SearchBountiesInput.shape.min_price_cents.description,
      },
      max_price_cents: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000_000,
        description: SearchBountiesInput.shape.max_price_cents.description,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        description: SearchBountiesInput.shape.limit.description,
      },
      offset: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000,
        default: 0,
        description: SearchBountiesInput.shape.offset.description,
      },
    },
    additionalProperties: false,
  },
} as const

// ── Handler ──────────────────────────────────────────────────

export interface SearchBountiesError {
  ok: false
  error: string
  status?: number
}

export interface SearchBountiesSuccess {
  ok: true
  data: PublicBountyListType
}

export type SearchBountiesResult = SearchBountiesSuccess | SearchBountiesError

function buildQueryString(input: SearchBountiesInputType): string {
  const params = new URLSearchParams()
  if (input.query) params.set('query', input.query)
  if (input.category) params.set('category', input.category)
  if (input.status) params.set('status', input.status)
  if (input.min_price_cents !== undefined)
    params.set('min_price_cents', String(input.min_price_cents))
  if (input.max_price_cents !== undefined)
    params.set('max_price_cents', String(input.max_price_cents))
  params.set('limit', String(input.limit))
  params.set('offset', String(input.offset))
  return params.toString()
}

export async function searchBounties(
  rawInput: unknown
): Promise<SearchBountiesResult> {
  const parsed = SearchBountiesInput.safeParse(rawInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    }
  }

  const url = `${BOUNTIES_ENDPOINT}/api/public/bounties?${buildQueryString(
    parsed.data
  )}`

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

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After')
    return {
      ok: false,
      status: 429,
      error: `Rate limited by Archimedes public API. Retry after ${
        retryAfter ?? '60'
      }s.`,
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

  const validated = PublicBountyList.safeParse(json)
  if (!validated.success) {
    return {
      ok: false,
      error:
        'Archimedes response did not match expected schema. ' +
        'The MCP tool may be out of date with the upstream API.',
    }
  }

  return { ok: true, data: validated.data }
}

// ── MCP wire-format helpers ──────────────────────────────────
// The MCP CallToolResult shape is { content: [{ type: 'text', text }], ... }.
// We render a compact human-readable summary AND attach the full
// structured payload so downstream agents can pick either form.

function formatPriceCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}

function renderBountyLine(b: PublicBountyType): string {
  const price = formatPriceCents(b.price_cents)
  const cat = b.category ? ` [${b.category}]` : ''
  const funded = b.is_funded ? '' : ' (unfunded)'
  return `• ${b.title}${cat} — ${price}${funded}\n  ${b.url}\n  ${b.summary}`
}

export async function searchBountiesAsMcpResult(
  rawInput: unknown
): Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredContent?: unknown
}> {
  const result = await searchBounties(rawInput)

  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.error }],
    }
  }

  const { items, total, limit, offset } = result.data
  if (items.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            'No bounties matched. ' +
            'Try broadening the query, removing the category filter, ' +
            'or setting status="all".',
        },
      ],
      structuredContent: result.data,
    }
  }

  const header = `Found ${items.length} of ${total} matching bounties (offset ${offset}, limit ${limit}):`
  const body = items.map(renderBountyLine).join('\n\n')

  return {
    content: [{ type: 'text', text: `${header}\n\n${body}` }],
    structuredContent: result.data,
  }
}
