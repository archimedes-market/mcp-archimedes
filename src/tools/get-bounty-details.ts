/**
 * MCP tool: get-bounty-details
 *
 * Thin HTTP client over GET https://archimedes.market/api/public/bounties/{id}.
 * Used after search_bounties to evaluate fit on a specific bounty —
 * returns full requirements, deliverables, and acceptance tests.
 */

import { z } from 'zod'

const BOUNTIES_ENDPOINT =
  process.env.ARCHIMEDES_PUBLIC_API_URL?.replace(/\/$/, '') ??
  'https://archimedes.market'

const USER_AGENT =
  process.env.ARCHIMEDES_MCP_USER_AGENT ??
  'mcp-archimedes/0.2 (+https://archimedes.market)'

// ── Input schema ──────────────────────────────────────────────

export const GetBountyDetailsInput = z.object({
  id: z
    .string()
    .uuid()
    .describe(
      'Bounty UUID from search_bounties results (the `id` field). ' +
        'Display IDs like "MSN-00001" are not accepted — use the UUID.'
    ),
})

export type GetBountyDetailsInputType = z.infer<typeof GetBountyDetailsInput>

// ── Output schema (mirrors PublicBountyDetailSchema upstream) ─

const BountyDetail = z.object({
  id: z.string().uuid(),
  display_id: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  description: z.string(),
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
  requirements: z.array(
    z.object({
      description: z.string(),
      category: z.string().nullable(),
      priority: z.string().nullable(),
    })
  ),
  deliverables: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      description: z.string().nullable(),
      accepted_formats: z.array(z.string()),
    })
  ),
  acceptance_tests: z.array(
    z.object({
      name: z.string(),
      test_type: z.string(),
      required: z.boolean(),
      description: z.string().nullable(),
    })
  ),
})

export type BountyDetailType = z.infer<typeof BountyDetail>

// ── MCP tool definition ───────────────────────────────────────

export const getBountyDetailsToolDefinition = {
  name: 'get_bounty_details',
  description:
    'Fetch the full record for a specific Archimedes Market bounty. ' +
    'Returns title, summary, full description, payout in cents, deadline, ' +
    'all requirements (with category + priority), all deliverables (with ' +
    'accepted file formats), and acceptance tests. Use after search_bounties ' +
    'when the user (or agent) wants to evaluate fit, plan a submission, ' +
    'or quote a timeline.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: GetBountyDetailsInput.shape.id.description,
      },
    },
  },
} as const

// ── Handler ──────────────────────────────────────────────────

export interface GetBountyDetailsError {
  ok: false
  error: string
  status?: number
}

export interface GetBountyDetailsSuccess {
  ok: true
  data: BountyDetailType
}

export type GetBountyDetailsResult =
  | GetBountyDetailsSuccess
  | GetBountyDetailsError

export async function getBountyDetails(
  rawInput: unknown
): Promise<GetBountyDetailsResult> {
  const parsed = GetBountyDetailsInput.safeParse(rawInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    }
  }

  const url = `${BOUNTIES_ENDPOINT}/api/public/bounties/${encodeURIComponent(
    parsed.data.id
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

  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      error: `Bounty ${parsed.data.id} not found.`,
    }
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After')
    return {
      ok: false,
      status: 429,
      error: `Rate limited. Retry after ${retryAfter ?? '60'}s.`,
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

  const validated = BountyDetail.safeParse(json)
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

// ── MCP wire-format helper ───────────────────────────────────

function formatPriceCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}

export async function getBountyDetailsAsMcpResult(
  rawInput: unknown
): Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredContent?: unknown
}> {
  const result = await getBountyDetails(rawInput)

  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.error }],
    }
  }

  const b = result.data
  const price = formatPriceCents(b.price_cents)
  const fundedTag = b.is_funded ? '' : ' (unfunded — escrow not locked)'
  const cat = b.category ? ` [${b.category}]` : ''

  const reqLines =
    b.requirements.length > 0
      ? b.requirements
          .map((r) => {
            const tag = [r.priority, r.category].filter(Boolean).join(' / ')
            return `  - ${tag ? `(${tag}) ` : ''}${r.description}`
          })
          .join('\n')
      : '  (none specified)'

  const delLines =
    b.deliverables.length > 0
      ? b.deliverables
          .map((d) => {
            const req = d.required ? 'required' : 'optional'
            const fmts =
              d.accepted_formats.length > 0
                ? ` — formats: ${d.accepted_formats.join(', ')}`
                : ''
            return `  - [${d.type}, ${req}] ${d.name}${fmts}`
          })
          .join('\n')
      : '  (none specified)'

  const testLines =
    b.acceptance_tests.length > 0
      ? b.acceptance_tests
          .map((t) => {
            const req = t.required ? 'required' : 'optional'
            return `  - [${t.test_type}, ${req}] ${t.name}`
          })
          .join('\n')
      : '  (none specified)'

  const text = [
    `${b.title}${cat} — ${price}${fundedTag}`,
    b.url,
    '',
    `Description:`,
    `  ${b.summary}`,
    '',
    `Deadline: ${b.deadline_iso}`,
    `Status: ${b.status} / escrow ${b.escrow_status}`,
    '',
    `Requirements (${b.requirements.length}):`,
    reqLines,
    '',
    `Deliverables (${b.deliverables.length}):`,
    delLines,
    '',
    `Acceptance tests (${b.acceptance_tests.length}):`,
    testLines,
  ].join('\n')

  return {
    content: [{ type: 'text', text }],
    structuredContent: b,
  }
}
