#!/usr/bin/env node
/**
 * @archimedes-market/mcp — stdio MCP server for Archimedes Market.
 *
 * For local MCP clients that only speak stdio (Claude Desktop,
 * Cursor, Continue, etc.). Forwards tool calls to the hosted
 * REST endpoint at https://archimedes.market/api/public/bounties
 * — single source of truth for data, sanitization, and rate limiting.
 *
 * Non-stdio clients should connect directly to:
 *   https://archimedes.market/api/mcp
 * which speaks JSON-RPC 2.0 over HTTP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  searchBounties,
  searchBountiesAsMcpResult,
  searchBountiesToolDefinition,
} from './tools/search-bounties.js'

const SERVER_INFO = {
  name: 'archimedes-market',
  version: '0.1.0',
}

const SERVER_INSTRUCTIONS =
  'Archimedes Market hosts verified deep-tech engineering bounties. ' +
  'Use search_bounties to discover paid engineering work. Every bounty ' +
  'is funded in Stripe escrow and every submission is AI-verified ' +
  'before the buyer sees it.'

async function main() {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  })

  // ── tools/list ──────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [searchBountiesToolDefinition],
    }
  })

  // ── tools/call ──────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'search_bounties': {
        const result = await searchBountiesAsMcpResult(args ?? {})
        return result
      }
      default:
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unknown tool: ${name}. Available: search_bounties.`,
            },
          ],
        }
    }
  })

  // Health probe — exposed so `archimedes-mcp --probe` or similar
  // tooling can verify the bridge can reach the upstream API
  // before being wired into a client config.
  if (process.argv.includes('--probe')) {
    const probe = await searchBounties({ limit: 1, status: 'all' })
    if (probe.ok) {
      console.error(
        `[archimedes-mcp] probe ok — upstream reachable, ${probe.data.total} bounties indexed`
      )
      process.exit(0)
    }
    console.error(`[archimedes-mcp] probe failed: ${probe.error}`)
    process.exit(1)
  }

  // Use stderr for diagnostics — stdout is the JSON-RPC channel.
  console.error('[archimedes-mcp] starting stdio server…')

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error('[archimedes-mcp] connected.')
}

main().catch((err) => {
  console.error('[archimedes-mcp] fatal:', err)
  process.exit(1)
})
