# fetch-mcp — Claude Code instructions

This is the `@yawlabs/fetch-mcp` server. Stdio MCP server. HTTP fetch with SSRF protection, HTML-to-markdown, reader-mode, metadata / link / sitemap / RSS-Atom extraction, robots.txt awareness. Node ≥20, ESM, TypeScript, tsup, vitest, biome.

## Layout

- `src/index.ts` — CLI entrypoint; calls `startServer()`.
- `src/server.ts` — MCP server factory, registers tool modules.
- `src/security.ts` — SSRF block list + URL validator. Security-critical.
- `src/http.ts` — core request client: redirects, retries, size cap, auth, timeouts.
- `src/format.ts` — `formatJson` / `formatError` helpers for MCP `content` arrays.
- `src/tools/http.ts` — 7 HTTP method tools.
- `src/tools/content.ts` — `fetch_html_to_markdown`, `fetch_html_to_text`.
- `src/tools/reader.ts` — `fetch_reader` — main-content isolation + markdown.
- `src/tools/meta.ts` — `fetch_meta` — head metadata: OG, Twitter, JSON-LD, canonical, feeds, icons.
- `src/tools/links.ts` — `fetch_links` — absolute URL extraction with `<base>` support.
- `src/tools/sitemap.ts` — `fetch_sitemap` — XML sitemap parsing + sitemap-index chaining + gzip.
- `src/tools/feed.ts` — `fetch_feed` — RSS 2.0 + Atom 1.0 parser via fast-xml-parser.
- `src/tools/robots.ts` — `fetch_robots` + `parseRobots` + `isAllowed`.
- `src/tests/` — vitest suites. `http.test.ts` binds a real loopback server (no mocks).

## Launch-critical things you must not break

1. **SSRF defaults.** `validateUrl()` rejects private IPs, loopback, link-local, cloud metadata, CGNAT, non-`http(s)` schemes, and `localhost*` by default. Tests in `src/tests/security.test.ts` + `src/tests/http.test.ts` pin this. A regression here is a P0.
2. **Per-hop redirect re-validation.** The manual redirect loop in `src/http.ts` MUST resolve DNS and re-run `checkIpAddress()` for every `Location` it follows. Dropping this re-enables the classic DNS-rebinding → SSRF attack.
3. **Response size cap is streaming.** `httpRequest()` reads the body as a stream and aborts with an `AbortController` when `max_bytes` is hit. Don't buffer the full body and then truncate — that defeats the cap. Upper-bound `ABSOLUTE_MAX_BYTES` is 100 MiB; callers can request less, not more.
4. **JSON auto-parse only on matching Content-Type.** The client only sets `response.json` when `content-type` starts with `application/json` (or `+json`). Don't probe-parse arbitrary bodies — an XSS-laced HTML page containing a JSON fragment shouldn't end up in `.json`.
5. **Default `User-Agent` includes the repo URL.** Required by common anti-bot gatekeepers to know who to contact. If you ever rename the package, update `defaultUserAgent()` accordingly.
6. **Sitemap gzip detection is on the raw bytes, not Content-Encoding.** Many sitemaps are served as `.xml.gz` with `application/x-gzip` and no `Content-Encoding`, so node fetch does not decompress. `decodeSitemapPayload()` sniffs the gzip magic (`1f 8b`) on the raw buffer; don't switch sitemap to `decodeText: true` or gzip detection breaks.
7. **JSON-LD parsing is best-effort.** `parseHtmlMeta()` swallows JSON.parse errors on malformed `<script type="application/ld+json">` blocks rather than failing the entire meta request — sites frequently ship invalid JSON-LD.
8. **Atom link picking prefers `rel="alternate"` over `rel="self"`.** The self link points to the feed XML itself, not the article — see `extractAtomLink()` in `src/tools/feed.ts`.

## Convention quick-list

- Use npm, keep the lockfile committed.
- Run `npm run lint:fix` + `npm run typecheck` + `npm test` before every commit. CI also runs these on push/PR (`.github/workflows/ci.yml`, Node 20 + 22 matrix), but the pre-commit local pass is still the primary gate.
- zod schemas describe tool input; the exported TypeScript type is derived from the zod shape, not hand-written.
- Tool callbacks always return a `formatX()` result — never throw. Upstream errors get caught and returned as `formatError(...)`.

## Release

CI publish via `.github/workflows/release.yml`, fired on `v*` tag push. Uses the org-level `NPM_TOKEN` secret (no local `npm login` needed). The workflow runs the same `release.sh` with `CI=true` set; release.sh detects CI mode, skips the local-only steps (npm whoami check, dirty-tree check, interactive prompt, commit/tag/push), and goes straight to publish + GitHub release.

**To cut a release** (preferred path — matches every other CI-publish YawLabs MCP repo):

```bash
npm version X.Y.Z         # bumps package.json + package-lock.json
git add package.json package-lock.json
git commit -m "vX.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
gh run watch              # CI fires on the tag push, publishes within ~40s
```

**Local fallback** (when you need to bypass CI -- debugging the release script, intentionally publishing without going through the workflow, or just iterating on release.sh itself): `release.sh X.Y.Z` from a clean tree with an active `npm login --auth-type=web` session. Pre-flight aborts if `npm whoami` 401s. Same script, just runs every step locally instead of letting CI handle steps 4-6. Note that "GitHub outage" is NOT the canonical use case -- the local fallback's own `git push origin main --follow-tags` step also fails when GitHub is down, so it doesn't actually rescue you in that scenario; you'd need to wait for GitHub or manually invoke just the publish + verify steps. Tag-meaning shifts here from "shipped" to "intent to ship" -- the CI flow tags BEFORE publish (the tag triggers the publish), so don't rely on tag-existence as proof of registry presence; check `npm view "@yawlabs/fetch-mcp@X.Y.Z"` instead.

**Known gap:** `src/index.ts` has no `--version` handling, so the post-publish smoke test in `release.yml` is intentionally absent (`npx @yawlabs/fetch-mcp@VERSION --version` would block on stdin). Add a `--version` subcommand and re-add the smoke step matching `~/yaw/mcp_servers/aws-mcp/.github/workflows/release.yml` -- worth doing the next time someone touches the entrypoint.

## Sibling repos

- `@yawlabs/mcph` — the CLI that installs/orchestrates MCP servers. This server should show up in its catalog once we release.
- `@yawlabs/mcp-compliance` — runs the 88-test compliance suite. Goal: A grade.
