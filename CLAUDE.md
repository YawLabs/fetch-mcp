# fetch-mcp — Claude Code instructions

This is the `@yawlabs/fetch-mcp` server. Stdio MCP server. HTTP fetch with SSRF protection, HTML-to-markdown, robots.txt awareness. Node ≥20, ESM, TypeScript, tsup, vitest, biome.

## Layout

- `src/index.ts` — CLI entrypoint; calls `startServer()`.
- `src/server.ts` — MCP server factory, registers tool modules.
- `src/security.ts` — SSRF block list + URL validator. Security-critical.
- `src/http.ts` — core request client: redirects, retries, size cap, auth, timeouts.
- `src/format.ts` — `formatJson` / `formatError` helpers for MCP `content` arrays.
- `src/tools/http.ts` — 7 HTTP method tools.
- `src/tools/content.ts` — `fetch_html_to_markdown`, `fetch_html_to_text`.
- `src/tools/robots.ts` — `fetch_robots` + `parseRobots` + `isAllowed`.
- `src/tests/` — vitest suites. `http.test.ts` binds a real loopback server (no mocks).

## Launch-critical things you must not break

1. **SSRF defaults.** `validateUrl()` rejects private IPs, loopback, link-local, cloud metadata, CGNAT, non-`http(s)` schemes, and `localhost*` by default. Tests in `src/tests/security.test.ts` + `src/tests/http.test.ts` pin this. A regression here is a P0.
2. **Per-hop redirect re-validation.** The manual redirect loop in `src/http.ts` MUST resolve DNS and re-run `checkIpAddress()` for every `Location` it follows. Dropping this re-enables the classic DNS-rebinding → SSRF attack.
3. **Response size cap is streaming.** `httpRequest()` reads the body as a stream and aborts with an `AbortController` when `max_bytes` is hit. Don't buffer the full body and then truncate — that defeats the cap. Upper-bound `ABSOLUTE_MAX_BYTES` is 100 MiB; callers can request less, not more.
4. **JSON auto-parse only on matching Content-Type.** The client only sets `response.json` when `content-type` starts with `application/json` (or `+json`). Don't probe-parse arbitrary bodies — an XSS-laced HTML page containing a JSON fragment shouldn't end up in `.json`.
5. **Default `User-Agent` includes the repo URL.** Required by common anti-bot gatekeepers to know who to contact. If you ever rename the package, update `defaultUserAgent()` accordingly.

## Convention quick-list

- Use npm, keep the lockfile committed.
- Run `npm run lint:fix` + `npm run typecheck` + `npm test` before every commit (CI enforces the same).
- zod schemas describe tool input; the exported TypeScript type is derived from the zod shape, not hand-written.
- Tool callbacks always return a `formatX()` result — never throw. Upstream errors get caught and returned as `formatError(...)`.

## Release

`release.sh X.Y.Z` from a clean tree. It:

1. lints + typechecks + builds + tests
2. bumps `package.json`, commits `vX.Y.Z`
3. pushes `main`, **waits for ci.yml green on that SHA**, then tags
4. pushes the tag — `.github/workflows/release.yml` runs with `secrets.NPM_TOKEN` (YawLabs org-level secret) and publishes

Do **not** run `npm publish` or `npm login` locally — the YawLabs-global hook blocks it.

## Sibling repos

- `@yawlabs/mcph` — the CLI that installs/orchestrates MCP servers. This server should show up in its catalog once we release.
- `@yawlabs/mcp-compliance` — runs the 88-test compliance suite. Goal: A grade.
