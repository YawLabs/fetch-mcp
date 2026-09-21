# @yawlabs/fetch-mcp

A comprehensive HTTP fetch MCP server for AI assistants. Bring-your-own client: runs as a stdio MCP server so any MCP-compatible client (Claude Code, Claude Desktop, Cursor, `mcph`, …) can fetch web content safely.

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Fetch&command=npx&args=-y%2C%40yawlabs%2Ffetch-mcp&description=HTTP%20fetch%20for%20AI%20agents%20-%20HTML-to-markdown%2C%20reader%20mode%2C%20metadata%2C%20RSS%2C%20sitemaps&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Ffetch-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## What it gives the model

| Tool | What it does |
|------|--------------|
| `http_get` / `http_head` / `http_options` | Bare HTTP requests with headers, auth, timeout, size cap, retry |
| `http_post` / `http_put` / `http_patch` / `http_delete` | Write-method HTTP with JSON or raw body |
| `fetch_html_to_markdown` | GET a page and convert to clean markdown (3–8× smaller than raw HTML) |
| `fetch_html_to_text` | GET a page and convert to plain text with block structure preserved |
| `fetch_reader` | Reader-mode extraction — isolates the article body and returns title + markdown |
| `fetch_meta` | Extract `<head>` metadata: title, description, OpenGraph, Twitter cards, JSON-LD, feeds, icons |
| `fetch_links` | Extract every outbound link, resolved to absolute URLs, classified internal/external |
| `fetch_sitemap` | Parse `sitemap.xml` (including gzipped and sitemap-index chaining) |
| `fetch_feed` | Parse an RSS 2.0 or Atom 1.0 feed into entries |
| `fetch_robots` | Parse a site's `robots.txt`, return the verdict for a given path & user-agent |

## Safety

SSRF protection is on by default. The server refuses requests to:

- Loopback (`127.0.0.0/8`, `::1`)
- RFC1918 private ranges (`10/8`, `172.16/12`, `192.168/16`)
- Link-local (`169.254/16`, `fe80::/10`) — including the cloud metadata endpoint `169.254.169.254`
- CGNAT (`100.64/10`)
- Unique-local IPv6 (`fc00::/7`)
- Multicast / broadcast
- IPv4-mapped IPv6 (`::ffff:0:0/96`) re-checked against the IPv4 rules, and likewise the IPv4 embedded in IPv4-compatible (`::/96`), IPv4-translated (`::ffff:0:0:0/96`) and 6to4 (`2002::/16`) addresses
- Teredo (`2001::/32`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), site-local (`fec0::/10`) and discard-only (`100::/64`) IPv6
- The Azure WireServer address `168.63.129.16`
- Non-`http`/`https` schemes (`file://`, `gopher://`, `javascript:`, …)
- Hostname `localhost` and any `*.localhost`

Every redirect hop is re-validated against all of the above -- scheme, literal IP and `localhost*` -- before it is dialed, so a 302 from a public host to `http://127.0.0.1`, `http://169.254.169.254` or `ftp://…` is caught. For hostnames, DNS is resolved once per hop, every returned address is checked, and the verified IP is pinned into the HTTP dispatcher so the subsequent TCP connection dials that exact address — closing the DNS-rebinding TOCTOU window. `Authorization`, `Cookie` and `Proxy-Authorization` headers are stripped on cross-origin redirects.

### Reaching private hosts (development)

The model chooses tool arguments, and the model is not trusted: a prompt injected through a fetched page can ask for anything. So the per-call `allow_private_hosts: true` opt-in is **refused unless the operator enables it** by launching the server with `FETCH_MCP_ALLOW_PRIVATE_HOSTS=1` (`true`/`yes`/`on` also work; any unrecognised value is treated as off and named on stderr). With the variable set, a call still has to ask: requests without `allow_private_hosts` stay guarded.

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@yawlabs/fetch-mcp@latest"],
      "env": { "FETCH_MCP_ALLOW_PRIVATE_HOSTS": "1" }
    }
  }
}
```

Only set it where the model may legitimately reach your internal network -- a local dev box, not a cloud VM with a metadata endpoint.

## Install & run

```bash
# One-off (auto-updates each spawn via @latest)
npx -y @yawlabs/fetch-mcp@latest

# Or globally
npm i -g @yawlabs/fetch-mcp
fetch-mcp
```

Requires Node 22.19 or newer when running on Node (the floor of its HTTP client, undici 8; the launcher refuses older Nodes with a clear message instead of crashing). Under [oam](https://oamjs.org), which the launcher prefers when installed, the Node version does not matter.

## Configure in Claude Code / Claude Desktop

Add to your client's MCP config (usually `claude_desktop_config.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@yawlabs/fetch-mcp@latest"]
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
| `timeout_ms` | int | `10000` | Timeout for each attempt, covering DNS, every redirect hop and the body. Retries get a fresh budget; a whole call is capped at 5 minutes. Cancelling the tool call stops the request |
| `max_bytes` | int | `5242880` (5 MiB) | Truncate body if larger |
| `max_redirects` | int | `5` | Redirect hops allowed |
| `retries` | int | `0` | Retry count on 408/425/429/5xx with backoff (honors `Retry-After`) |
| `user_agent` | string | `@yawlabs/fetch-mcp/<v>` | `User-Agent` override |
| `basic_auth` | `{username,password}` | — | Injects `Authorization: Basic …` |
| `bearer_token` | string | — | Injects `Authorization: Bearer …` |
| `allow_private_hosts` | bool | `false` | Opt this call into loopback / private / link-local targets. Refused unless the operator set `FETCH_MCP_ALLOW_PRIVATE_HOSTS=1` ([details](#reaching-private-hosts-development)) |
| `decode_text` | bool | *auto* | When unset, auto-detects by response Content-Type (text for text/*, JSON, XML, JS, form-urlencoded; binary otherwise). Set explicitly `true` to force text decoding, `false` to force base64 in `body_base64`. |

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

### `fetch_reader`

Isolates the main article body using, in order: `<article>`, `<main>`, `itemprop="articleBody"`, common CMS class names (`post-content`, `entry-content`, etc.), then `<body>` as fallback. Returns:

```ts
{
  url: string;          // final URL after redirects
  title?: string;       // og:title, then <title>, then <h1>
  byline?: string;      // meta[name=author] / article:author
  wordCount: number;
  markdown: string;     // main content converted to markdown
}
```

### `fetch_meta`

GET a URL and return its head metadata without downloading the full body (caps at 2 MiB by default):

```ts
{
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  language?: string;
  robots?: string;
  og:      Record<string, string>;       // first value per key (og:title, og:image, og:type, ...)
  twitter: Record<string, string>;       // first value per key
  article: Record<string, string>;       // first value per key
  ogAll:      Record<string, string[]>;  // only keys that appear > once (e.g. multiple og:image)
  twitterAll: Record<string, string[]>;
  articleAll: Record<string, string[]>;
  icons:   Array<{ rel: string; href: string; sizes?: string }>;
  feeds:   Array<{ href: string; title?: string; type?: string }>;   // RSS/Atom
  jsonLd:  unknown[];                    // parsed application/ld+json blocks
}
```

### `fetch_links`

GET a page and return every `<a href>` with text, resolved to absolute URLs. Respects `<base href>`. Skips `#`, `javascript:`, `mailto:`, `tel:`, `data:`, `file:`. Each link is classified `internal` or `external` vs. the page host. Optional `filter`/`dedupe`/`limit`.

### `fetch_sitemap`

Fetch a `sitemap.xml` or sitemap-index and return the URL list:

```ts
{
  sitemaps: string[];       // indexes followed, in order
  urlCount: number;
  truncated: boolean;       // hit max_urls
  childSitemaps: string[];  // listed but not fetched (past max_depth or max_sitemaps)
  warnings: Array<{ url: string; error: string }>;
  urls: Array<{
    loc: string;
    lastmod?: string;
    changefreq?: string;
    priority?: number;
  }>;
}
```

Gzipped `.xml.gz` sitemaps are auto-decompressed. `max_depth` controls how many levels of sitemap-index to follow (default 1). Setting `max_depth: 0` on a sitemap-index returns the index's `childSitemaps` list without fetching any child (useful to discover structure cheaply). Partial failures — one child sitemap 500s while others succeed — are returned under `warnings` rather than aborting the whole call. `max_sitemaps` (default 50, max 1000) caps how many sitemap documents one call fetches, index included; children past it are listed under `childSitemaps` with a warning. `max_bytes` (default 20 MiB) applies to each sitemap, and to the decompressed size of a gzipped one; a sitemap larger than that is an error (a warning for a child) rather than a silently partial URL list.

### `fetch_feed`

Parse an RSS 2.0 or Atom 1.0 feed:

```ts
{
  kind: "rss" | "atom" | "unknown";
  title?: string;
  description?: string;
  link?: string;
  updated?: string;
  entryCount: number;
  truncated: boolean;       // hit limit
  entries: Array<{
    title?: string;
    link?: string;
    id?: string;
    published?: string;
    updated?: string;
    author?: string;
    summary?: string;
    content?: string;
    categories?: string[];
  }>;
}
```

### `fetch_robots`

Fetches `<origin>/robots.txt`, parses it, and returns:

```ts
{
  robotsUrl: string;
  status: number;
  userAgent: string;
  path: string;
  allowed: boolean;
  matchedRule: string | null;  // the longest-match Allow/Disallow that decided it
  crawlDelay: number | null;   // from the matched group
  sitemaps: string[];          // top-level Sitemap: declarations
  rawRobotsText: string;       // first 512KB
  note?: string;               // only when robots.txt 404s
}
```

A `/robots.txt` that returns 404 means there are no rules, so the verdict is `allowed: true`. The response keeps the same shape: `status: 404`, `matchedRule: null`, `crawlDelay: null`, `sitemaps: []`, `rawRobotsText: ""`, plus the `note`. Any other non-2xx status is returned as an error.

The parser follows Google's rules: longest match wins, `*` is a wildcard segment, `$` anchors the end of the path, specific user-agent group beats the `*` wildcard group when the UA matches (comparison uses the length of the actually-matched agent token, not the group's first agent). Allow beats Disallow on equal-length ties.

## Development

```bash
npm install
npm run build
npm test         # vitest
npm run lint     # biome
npm run typecheck
```

Tests spin up a local loopback HTTP server on `127.0.0.1:0` to exercise the real request/response path — no mocking of HTTP. SSRF tests verify that the default-deny still applies to that local server unless the operator gate is on and the request opts into `allow_private_hosts`.

## License

MIT © Yaw Labs

## Links

- npm: https://www.npmjs.com/package/@yawlabs/fetch-mcp
- issues: https://github.com/YawLabs/fetch-mcp/issues
- Yaw Labs: https://yaw.sh

[![Follow @TokenLimitNews on X](https://img.shields.io/badge/follow-%40TokenLimitNews-000000?logo=x&logoColor=white)](https://x.com/TokenLimitNews)
