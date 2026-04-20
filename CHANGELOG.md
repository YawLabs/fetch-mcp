# Changelog

All notable changes to `@yawlabs/fetch-mcp` are documented here. This project uses [semantic versioning](https://semver.org) and a CI-gated release flow: pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which publishes to npm with OIDC provenance.

## 0.2.0 — 2026-04-19

Fifteen tools total (up from ten). The five new tools make this a full "web understanding" server rather than just an HTTP client — agents can read pages, extract structure, and discover content with per-tool-bounded responses that don't blow the context budget.

- **`fetch_reader`** — Reader-mode article extraction. Isolates the main article body via `<article>` / `<main>` / `itemprop="articleBody"` / common CMS class names (`post-content`, `entry-content`, `article-body`, `markdown-body`, …) and returns `{ title, byline, wordCount, markdown }`. A 200-character minimum on candidate blocks keeps a short decoy `<article>` from winning over the real content.
- **`fetch_meta`** — Head metadata extractor. Returns title, description, canonical, language, robots, and every `og:*` / `twitter:*` / `article:*` property, plus icons, RSS/Atom feed discovery, and parsed JSON-LD blocks. Caps body at 2 MiB by default since only `<head>` is needed. JSON-LD parse errors are swallowed per-block — sites frequently ship invalid JSON-LD and a single bad block shouldn't take down the whole meta request.
- **`fetch_links`** — Every `<a href>` on the page, absolute-URL-resolved (respects `<base href>`), classified `internal` vs `external` vs the page host. Skips `#` / `javascript:` / `mailto:` / `tel:` / `data:` / `file:`. Optional `dedupe`, `filter`, and `limit`.
- **`fetch_sitemap`** — Parses `sitemap.xml` and chained sitemap-index files (default `max_depth: 1`). Gzip detection is on the raw bytes (0x1f 0x8b magic), not `Content-Encoding` — many `.xml.gz` sitemaps are served as `application/x-gzip` with no encoding header, so node fetch doesn't decompress.
- **`fetch_feed`** — RSS 2.0 + Atom 1.0 parser via `fast-xml-parser`. Atom link picking prefers `rel="alternate"` over `rel="self"` (self points at the feed XML itself, not the article).

### Release plumbing

- **`release.sh` Step 4** — push commit, wait for `ci.yml` green on the SHA, then tag. Broken commits never burn a version slot.
- **`release.sh` Step 5** — wait for `release.yml` to publish from the tag instead of shelling `npm publish` locally. Local sessions are 2FA/WebAuthn-bound and 404 in headless mode; CI publishes with OIDC provenance to sigstore.

## 0.1.0 — 2026-04-19

Initial release. Ten HTTP + content tools, SSRF-protected by default, A/100 on `@yawlabs/mcp-compliance`.

- **Seven HTTP verb tools** — `http_get`, `http_post`, `http_put`, `http_patch`, `http_delete`, `http_head`, `http_options`. Headers, auth (basic / bearer), timeout, size cap, redirect control, retry (honors `Retry-After`).
- **`fetch_html_to_markdown`** / **`fetch_html_to_text`** — page → clean markdown or plain text, with `<nav>` / `<footer>` / `<aside>` / scripts / styles stripped. 3–8× smaller than raw HTML for LLM context.
- **`fetch_robots`** — parses robots.txt, returns `{ allowed, matchedRule, crawlDelay, sitemaps }` for a given path + user-agent. Longest-match Google rules.
- **SSRF protection on by default** — blocks loopback, RFC1918 private ranges, link-local (incl. `169.254.169.254` cloud metadata), CGNAT, unique-local IPv6, multicast, IPv4-mapped IPv6 (re-checked), non-http(s) schemes, and `localhost*`. DNS resolves once per redirect hop and re-checks on every hop, so a 302 to `http://127.0.0.1` through a public host gets caught.
- **Streaming size cap** — `httpRequest` reads body as a stream and aborts via `AbortController` when `max_bytes` is hit. Doesn't buffer-then-truncate (which would defeat the cap). Upper bound `ABSOLUTE_MAX_BYTES` is 100 MiB.
- **JSON auto-parse gated on content-type** — only sets `response.json` when `content-type` starts with `application/json` (or `+json`). An XSS-laced HTML page containing a JSON fragment shouldn't end up in `.json`.
