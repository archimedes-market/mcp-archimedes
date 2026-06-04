# @archimedes-market/mcp

MCP server for [Archimedes Market](https://archimedes.market) — let your AI agent discover **verified deep-tech engineering bounties** from any MCP-aware client.

## What it does

Exposes one tool to your AI agent:

- **`search_bounties`** — search open bounties on Archimedes by free-text query, category, funding status, and price band. Returns title, summary, payout in cents (USD), deadline, and a public URL per bounty.

Every bounty Archimedes lists is funded in Stripe escrow before engineers see it, and every submission is AI-verified (Semgrep + OpenAI code review + license scan) before the buyer sees it. No agent will surface a bounty that doesn't have real money behind it.

## Install

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "archimedes": {
      "command": "npx",
      "args": ["-y", "@archimedes-market/mcp"]
    }
  }
}
```

Restart Claude Desktop. The `search_bounties` tool will appear in the available tools list.

### Cursor

Settings → MCP → Add server. Use the same config block as above.

### Continue / other stdio clients

Point the client at:

```
npx -y @archimedes-market/mcp
```

### Non-stdio clients (server-side agents, hosted bots)

Skip this package entirely — call the hosted HTTP endpoint directly:

```
POST https://archimedes.market/api/mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_bounties",
    "arguments": { "query": "MCP server", "limit": 5 }
  }
}
```

Full docs: <https://archimedes.market/mcp>

## Example agent queries

> "Find me open Archimedes bounties for KiCad PCB review under $3,000."

> "Are there any MCP-server bounties on Archimedes right now? Show me the top 5 by payout."

> "Search Archimedes for digital twin bounties — sort by deadline."

The tool returns both a human-readable text block (for the model to reason over) and a structured payload (for downstream tooling).

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `ARCHIMEDES_PUBLIC_API_URL` | `https://archimedes.market` | Override the upstream base URL (preview deployments, local dev) |
| `ARCHIMEDES_MCP_USER_AGENT` | `mcp-archimedes/0.1 (+https://archimedes.market)` | Override the `User-Agent` sent on outbound calls |

## Health check

Verify the bridge can reach the upstream API before wiring it into a client:

```bash
npx @archimedes-market/mcp --probe
```

Exit code 0 means upstream is reachable. Non-zero with stderr diagnostic on failure.

## Privacy

The Archimedes public API logs `query_hash` (SHA-256 of normalized params) and `ip_hash` (HMAC with daily-rotated salt) per call — never raw queries or raw IPs. 90-day retention. Zero-result queries are aggregated to inform what bounties Archimedes should source next.

## License

MIT. See [LICENSE](LICENSE).

## Links

- Hosted MCP endpoint: <https://archimedes.market/api/mcp>
- REST API: <https://archimedes.market/api/public/bounties>
- Browse bounties: <https://archimedes.market/bounties>
- MCP spec: <https://modelcontextprotocol.io>
