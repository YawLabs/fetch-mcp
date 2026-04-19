# @yawlabs/fetch-mcp

A comprehensive HTTP fetch MCP server for AI assistants. Bring-your-own client: runs as a stdio MCP server so any MCP-compatible client (Claude Code, Claude Desktop, Cursor, `mcph`, …) can fetch web content safely.

## What it gives the model

| Tool | What it does |
|------|--------------|
| `http_get` / `http_head` / `http_options` | Bare HTTP requests with headers, auth, timeout, size cap, retry |
| `http_post` / `http_put` / `http_patch` / `http_delete` | Write-method HTTP with JSON or raw body |
| `fetch_html_to_markdown` | GET a page and convert to clean markdown (3–8× smaller than raw HTML) |
| `fetch_html_to_text` | GET a page and convert to plain text with block structure preserved |
| `fetch_robots` | Parse a site's `robots.txt`, return the verdict for a given path & user-agent |

## Safety

SSRF protection is on by default. The server refuses requests to:

- Loopback (`127.0.0.0/8`, `::1`)
- RFC1918 private ranges (`10/8`, `172.16/12`, `192.168/16`)
- Link-local (`169.254/16`, `fe80::/10`) — including the cloud metadata endpoint `169.254.169.254`
- CGNAT (`100.64/10`)
- Unique-local IPv6 (`fc00::/7`)
- Multicast / broadcast
- IPv4-mapped IPv6 (`::ffff:0:0/96`) re-checked against the IPv4 rules
- Non-`http`/`https` schemes (`file://`, `gopher://`, `javascript:`, …)
- Hostname `localhost` and any `*.localhost`

DNS is resolved once per redirect hop and the same check runs on every hop, so a 302 to `http://127.0.0.1` through a public host gets caught. Set `allow_private_hosts: true` per-request when you really do need internal access (e.g. development).

## Install & run

```bash
# One-off
npx -y @yawlabs/fetch-mcp

# Or globally
npm i -g @yawlabs/fetch-mcp
fetch-mcp
```

Requires Node ≥20.

## Configure in Claude Code / Claude Desktop

Add to your client's MCP config (usually `claude_desktop_config.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@yawlabs/fetch-mcp"]
    }
  }
}
```

Or via `mcph`:

```bash
mcph add fetch
```

## Tool reference

### `http_get`, `http_post`, `http_put`, `http_patch`, `http_delete`, `http_head`, `http_options`

Common parameters:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `url` | string | — | Absolute URL |
| `headers` | object | — | Custom request headers |
| `timeout_ms` | int | `10000` | Request timeout |
| `max_bytes` | int | `5242880` (5 MiB) | Truncate body if larger |
| `max_redirects` | int | `5` | Redirect hops allowed |
| `retries` | int | `0` | Retry count on 408/425/429/5xx with backoff (honors `Retry-After`) |
| `user_agent` | string | `@yawlabs/fetch-mcp/<v>` | `User-Agent` override |
| `basic_auth` | `{username,password}` | — | Injects `Authorization: Basic …` |
| `bearer_token` | string | — | Injects `Authorization: Bearer …` |
| `allow_private_hosts` | bool | `false` | Bypass SSRF block |
| `decode_text` | bool | `true` | `false` returns `body_base64` instead of `body_text` |

Body-capable tools (POST/PUT/PATCH/DELETE) also take:

| Field | Type | Meaning |
|-------|------|---------|
| `body` | string | Raw request body |
| `body_json` | any | Structured body — encoded as JSON, `Content-Type: application/json` set automatically |
| `content_type` | string | Overrides `Content-Type` |

Response shape:

```ts
{
  ok: boolean;
  status: number;
  statusText: string;
  url: string;              // final URL after redirects
  headers: Record<string,string>;
  body_text?: string;
  body_base64?: string;     // when decode_text=false
  json?: unknown;           // auto-parsed when response is application/json
  truncated?: boolean;      // set when max_bytes hit
  redirects?: string[];     // chain of intermediate URLs
  duration_ms: number;
  error?: string;
}
```

### `fetch_html_to_markdown`

GET the URL, strip scripts/styles/iframes/svg/canvas plus `<nav>`, `<footer>`, `<aside>`, convert to atx-headed markdown with fenced code blocks and dash bullets. Intended for feeding pages into an LLM without blowing the context budget.

### `fetch_html_to_text`

Same fetch, but emits plain text with block-level structure preserved as newlines. Useful when the model doesn't need markdown formatting.

### `fetch_robots`

Fetches `<origin>/robots.txt`, parses it, and returns:

```ts
{
  origin: string;
  allowed: boolean;
  matchedRule?: string;     // the longest-match Allow/Disallow that decided it
  crawlDelay?: number;      // from the matched group
  sitemaps: string[];       // top-level Sitemap: declarations
  rawRobotsText: string;    // first 512KB
}
```

The parser follows Google's rules: longest match wins, `*` is a wildcard segment, `$` anchors the end of the path, specific user-agent group beats the `*` wildcard group when the UA matches.

## Development

```bash
npm install
npm run build
npm test         # vitest
npm run lint     # biome
npm run typecheck
```

Tests spin up a local loopback HTTP server on `127.0.0.1:0` to exercise the real request/response path — no mocking of HTTP. SSRF tests verify that the default-deny still applies to that local server unless the request opts into `allow_private_hosts`.

## License

MIT © Yaw Labs

## Links

- npm: https://www.npmjs.com/package/@yawlabs/fetch-mcp
- issues: https://github.com/YawLabs/fetch-mcp/issues
- Yaw Labs: https://mcp.hosting
