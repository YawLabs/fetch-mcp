# Changelog

All notable changes to `@yawlabs/fetch-mcp` are documented here. This project uses [semantic versioning](https://semver.org) and a CI-gated release flow: pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which publishes to npm with OIDC provenance.

## 0.3.0 — 2026-04-21

Hardens the HTTP client, fixes several parser correctness bugs, and rounds out tool-parameter consistency. 155 tests pass; 37 new tests were added to lock in the fixes.

### Security

- **Cross-origin Authorization stripping.** `bearer_token`, `basic_auth`, and any explicit `Authorization` header are now dropped when a redirect crosses origins. Previously a 302 from a trusted host to an attacker-controlled one would resend the bearer token.
- **DNS-rebinding TOCTOU closed.** Hosts are resolved once via `dns.lookup`, every address is checked, and the verified IP is pinned into an undici dispatcher so the subsequent TCP connection dials that exact IP. Previous behavior let `fetch` do its own lookup that a low-TTL rebinding attack could race.
- **Request-method downgrade on redirect.** 303 always downgrades to GET and drops the body. 301/302 from POST downgrade to GET per the WHATWG fetch standard. 307/308 preserve method and body.
- **Retry-loop state reset.** Each retry attempt starts fresh (original URL, original method, empty redirect chain). Previously a retry after N hops would retry against the final URL and append new hops to the old chain, potentially blowing past `max_redirects`.

### Correctness

- **HTML tag parsing tolerates `>` inside quoted attribute values.** `meta`, `link`, `a`, `base`, and article-isolation tags no longer break on `<meta content="reviews > 4 stars">` or `<a href="/search?q=a>b">`.
- **Nested `<article>` tags.** Reader-mode extraction walks balanced tag pairs with a depth-aware scanner instead of a non-greedy regex, so an inner article card no longer truncates the outer article at the inner's closing tag. When multiple article candidates exist, the longest one wins.
- **Multiple `og:*` / `twitter:*` / `article:*` values.** Keys that appear more than once (e.g. several `og:image` tags) are now returned under `ogAll` / `twitterAll` / `articleAll` arrays. The single-value `og` / `twitter` / `article` objects retain first-wins semantics.
- **Robots longest-match across groups.** The agent-specificity comparison now uses the length of the actually-matched agent token, not the group's first-agent length. `googlebot-news` in a multi-agent group no longer loses to a less-specific match. Allow beats Disallow on equal-length ties.
- **Empty `Disallow:` no longer silently dropped.** Per RFC 9309 an empty Disallow is an explicit no-op marker; the parser now records it even though it doesn't match any path.
- **Sitemap partial-failure returns warnings.** When a sitemap-index contains one child that 500s and others that succeed, the tool returns what it could parse plus a `warnings` array, instead of aborting the whole request. The top-level fetch still errors as before.
- **Sitemap `max_depth: 0` exposes `childSitemaps`.** Calling the tool against an index with `max_depth: 0` now returns the list of children it won't fetch, so callers can discover structure without committing to a full crawl.
- **`www.` vs bare host link classification.** `extractLinks` normalizes away a leading `www.` before the internal/external comparison, so `https://site.com/x` and `https://www.site.com/y` classify as internal when the page host is either form.

### Ergonomics

- **`decode_text` auto-detection.** When unset, the client now inspects the response `Content-Type`: text/* / JSON / XML / form-urlencoded return `body_text`, everything else returns `body_base64`. The README's "auto" behavior is real now. Explicit `true` / `false` still force a specific mode.
- **Charset-aware text decoding.** Bodies declared as `charset=iso-8859-1` (or any other TextDecoder-supported label) are decoded with that encoding. Falls back to UTF-8 when the label is missing or unrecognized.
- **`Retry-After` HTTP-date form accepted.** Previously only delta-seconds worked; HTTP-date values silently fell back to exponential backoff. Both now work and are clamped to ≤60s.
- **Atom entries expose `contentType`.** `<content type="html">` / `text` / `xhtml` is preserved on each entry so consumers can tell markup from plain text.
- **Uniform tool parameters.** `fetch_meta`, `fetch_feed`, `fetch_sitemap`, `fetch_robots` all accept `max_redirects` and (where applicable) `max_bytes` + `allow_private_hosts`. Previously an LLM that learned the parameter from `http_get` would get a zod error when using it on a different tool.

### Performance

- **Response body drain on HEAD and redirect.** HEAD responses and 3xx bodies are now cancelled via `body.cancel()` instead of buffered into memory. A hostile 302 with a giant body can no longer balloon the process.

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
