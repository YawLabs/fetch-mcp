# fetch-mcp — Claude Code instructions

This is the `@yawlabs/fetch-mcp` server. Stdio MCP server. HTTP fetch with SSRF protection, HTML-to-markdown, reader-mode, metadata / link / sitemap / RSS-Atom extraction, robots.txt awareness. Node ≥20, ESM, TypeScript, tsup, vitest, biome.

## Layout

- `bin/fetch-mcp.mjs` — the npm `bin`. Runtime launcher: prefers oam, falls back to the Node process already running it; imports `dist/index.js` in-process or spawns `oam run <entry> -- <argv>`.
- `src/index.ts` — CLI entrypoint: handles `version` / `--version`, rejects any other argument, otherwise calls `startServer()`.
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
9. **Argument handling in `src/index.ts` runs before `startServer()`.** `version` / `--version` prints the version and exits 0 (the release smoke test depends on it); any other argument prints `Unknown subcommand` plus usage to **stderr** and exits 1; only a launch with no argument starts the server. `startServer()` binds stdio and blocks on stdin, so an argument that reaches it looks like a hang (#33). Never write diagnostics to stdout — it is the MCP channel. Every `bin/fetch-mcp.mjs` path (in-process under Node or a host oam, or the spawned `oam run <entry> -- …`) reaches `src/index.ts` with no argument when the launcher itself got none; `src/tests/version.test.ts` pins all three outcomes.

## Convention quick-list

- Use npm, keep the lockfile committed.
- Run `npm run lint:fix` + `npm run typecheck` + `npm test` before every commit -- there is no push/PR CI gate, so the pre-commit local pass and `release.sh`'s own lint/test steps are the only checks.
- Record user-facing changes under `## [Unreleased]` in `CHANGELOG.md` as you land them; `release.sh` promotes that heading to the release version.
- zod schemas describe tool input; the exported TypeScript type is derived from the zod shape, not hand-written.
- Tool callbacks always return a `formatX()` result — never throw. Upstream errors get caught and returned as `formatError(...)`.

## Release

**`./release.sh X.Y.Z` from a clean `main` on the workstation is the whole pipeline.** The repo has no GitHub Actions workflows and Actions is disabled on it (workflows removed 2026-07-21), so nothing fires on tag push and nothing re-checks the tree after you. Don't hand-roll `npm version` + tag + push: that tags a version nobody publishes.

The script runs eight steps. Each is idempotent, so after an interruption re-run with the same version to resume:

1. Lint + typecheck -- the only lint gate this repo has.
2. Build + test.
3. Bump `package.json` / `package-lock.json`, sync `server.json`, and promote `## [Unreleased]` in `CHANGELOG.md` to the version. Aborts if the release would ship with unpromoted `[Unreleased]` content.
4. Commit `vX.Y.Z`, create an annotated tag, `git push origin main --follow-tags`.
5. `npm publish`, with EOTP retry.
6. GitHub release. Its notes are the commit subjects since the previous tag, not the CHANGELOG, so write subjects that read as release notes.
7. Smoke test (below), then MCP Registry publish via `mcp-publisher` (token: `MCP_REGISTRY_TOKEN`, else `gh auth token`).
8. Verify: the npm version, `package.json` and the git tag. Mismatches only warn.

**Auth:** an npm automation token in `~/.npmrc`; pre-flight aborts if `npm whoami` fails. Never `npm login --auth-type=web` -- it overwrites the automation token with a 2FA-bound session and the next publish EOTPs. The tag lands in step 4, before publish, so a tag is not proof of registry presence; check `npm view "@yawlabs/fetch-mcp@X.Y.Z" version`.

`release.sh` still carries a `CI=true` mode and a hand-off-to-`release.yml` branch from the Actions era. Both stay dormant while no workflow exists.

**Smoke test:** step 7 installs the just-published version with `npx` from a temp dir (retrying for up to ~5 min while the registry propagates), runs it with `--version`, and fails the release unless the output equals the version. It catches packaging regressions: a missing bin shebang, a bad `"files"` entry, broken tsup output. It depends on the argument handling in `src/index.ts` (Launch-critical #9).

## Sibling repos

- `@yawlabs/mcph` — the CLI that installs/orchestrates MCP servers. This server should show up in its catalog once we release.
- `@yawlabs/mcp-compliance` — runs the 88-test compliance suite. Goal: A grade.
