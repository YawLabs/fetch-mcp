# fetch-mcp — Claude Code instructions

This is the `@yawlabs/fetch-mcp` server. Stdio MCP server. HTTP fetch with SSRF protection, HTML-to-markdown, reader-mode, metadata / link / sitemap / RSS-Atom extraction, robots.txt awareness. Node ≥22.19 (undici 8's floor; enforced by the launcher, see #16), ESM, TypeScript, tsup, vitest, biome.

## Layout

- `bin/fetch-mcp.mjs` — the npm `bin`. Runtime launcher: prefers the newest oam at or above `OAM_MIN` (0.15.2, the latest oam release), falls back to Node. Imports `dist/index.js` in-process, spawns `oam [--permission --allow-net --allow-env=FETCH_MCP_ALLOW_PRIVATE_HOSTS] run <entry> -- <argv>`, or — from an oam host below the floor, or under `FETCH_MCP_RUNTIME=node` on any oam host — hands off to `node <entry> <argv>` with piped stdio. It never serves on an oam below the floor.
- `src/index.ts` — CLI entrypoint: handles `version` / `--version`, rejects any other argument, otherwise calls `startServer()`.
- `src/server.ts` — MCP server factory, registers tool modules.
- `src/security.ts` — SSRF block list + URL validator. Security-critical.
- `src/policy.ts` — operator policy: the `FETCH_MCP_ALLOW_PRIVATE_HOSTS` parser, its stderr warning, and the gate's messages. Security-critical.
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
2. **Per-hop redirect re-validation.** `sendHop()` in `src/http.ts` MUST run `validateUrl()` on every URL it dials (scheme allow-list, literal-IP block list, `localhost*`) AND resolve DNS + re-run `checkIpAddress()` for every hostname `Location` it follows. Dropping the DNS step re-enables the classic DNS-rebinding → SSRF attack; dropping the `validateUrl()` step re-opens the 0.7.0-and-earlier bug where a public URL that 302'd to `http://169.254.169.254/...` (or any literal blocked IP, or `ftp://`) was fetched with the guard on -- the initial-URL check in `httpRequest()` never sees redirect targets. `src/tests/http.redirect-ssrf.test.ts` pins this; 30 of its original 35 redirect cases fail without the per-hop `validateUrl()`.
3. **Response size cap is streaming.** `httpRequest()` reads the body as a stream and aborts with an `AbortController` when `max_bytes` is hit. Don't buffer the full body and then truncate — that defeats the cap. Upper-bound `ABSOLUTE_MAX_BYTES` is 100 MiB; callers can request less, not more.
4. **JSON auto-parse only on matching Content-Type.** The client only sets `response.json` when `content-type` starts with `application/json` (or `+json`). Don't probe-parse arbitrary bodies — an XSS-laced HTML page containing a JSON fragment shouldn't end up in `.json`.
5. **Default `User-Agent` includes the repo URL.** Required by common anti-bot gatekeepers to know who to contact. If you ever rename the package, update `defaultUserAgent()` accordingly.
6. **Sitemap gzip detection is on the raw bytes, not Content-Encoding.** Many sitemaps are served as `.xml.gz` with `application/x-gzip` and no `Content-Encoding`, so node fetch does not decompress. `decodeSitemapPayload()` sniffs the gzip magic (`1f 8b`) on the raw buffer; don't switch sitemap to `decodeText: true` or gzip detection breaks.
7. **JSON-LD parsing is best-effort.** `parseHtmlMeta()` swallows JSON.parse errors on malformed `<script type="application/ld+json">` blocks rather than failing the entire meta request — sites frequently ship invalid JSON-LD.
8. **Atom link picking prefers `rel="alternate"` over `rel="self"`.** The self link points to the feed XML itself, not the article — see `extractAtomLink()` in `src/tools/feed.ts`.
9. **Argument handling in `src/index.ts` runs before `startServer()`.** `version` / `--version` prints the version and exits 0 (the release smoke test depends on it); any other argument prints `Unknown subcommand` plus usage to **stderr** and exits 1; only a launch with no argument starts the server. `startServer()` binds stdio and blocks on stdin, so an argument that reaches it looks like a hang (#33). Never write diagnostics to stdout — it is the MCP channel. Every `bin/fetch-mcp.mjs` path (in-process under Node or a host oam, the spawned `oam run <entry> -- …`, or the Node handoff `node <entry> …`) reaches `src/index.ts` with no argument when the launcher itself got none; `src/tests/version.test.ts` pins all three outcomes.
10. **The `FETCH_MCP_SANDBOX` and `FETCH_MCP_RUNTIME` parsers are security-sensitive.** `parseSandboxSetting` reads `1`/`true`/`yes`/`on` (trimmed, case-insensitive) as on, `0`/`false`/`no`/`off`/unset as off, anything else as off AND named on stderr -- a security opt-in that fails OPEN on `true` or a trailing space, with nothing on stderr, is the silent downgrade this launcher promises never to make. `parseRuntimeSetting` reads `auto`/`oam`/`node` (trimmed, case-insensitive), anything else as `auto` AND named on stderr -- the same class of downgrade would let the fail-closed pairing (sandbox on + `RUNTIME=oam`) fall open on `"oam "`. The unit tests in `src/tests/launcher.test.ts` pin every accepted spelling; the integration tests pin that unrecognised values produce the on-stderr line and never serve with the wrong setting.
11. **The "runs WITHOUT `--permission`" note is printed ONLY once a serving path is committed to.** `noteSandboxNotApplied()` returns early when there is no sandbox; it is called by `fallBack` (after `fallbackInProcess` decides) and by `handOffToNode` (after `findNodeOnPath()` succeeds). A fatal exit (no Node on PATH, `RUNTIME=oam` with nothing to spawn) must never claim the server runs without the sandbox -- the line would sit above an exit that served nothing. `src/tests/launcher.test.ts` pins both sides: the line fires when the path serves, and never fires above a fatal exit.
12. **`hostOamCandidate()` puts the running process's own `process.execPath` first in discovery**, gated on its `--version` agreeing with `process.versions.oam`. A host whose oam is bundled inside the app (Yaw MCP) is the most common reason to reach discovery at all -- the sandbox needs a fresh oam, and the host's binary is the one guaranteed to exist. The version-agreement check keeps a wrapper, a `shim`, or a Node posing as oam (the suite's own preload) from masquerading as one. The integration test "spawns a fresh copy of the host's OWN oam for the sandbox when nothing else is installed" covers the new path, and "does not mistake a host whose binary reports a different version for its own oam" covers the guard.
13. **`allow_private_hosts` is gated by the operator, in `httpRequest()`.** The model chooses tool arguments, so the per-call flag alone must never widen reach: `httpRequest()` refuses `allowPrivateHosts` unless `setHttpContext` carries `allowPrivateHosts: true`, which only `createFetchServer({ allowPrivateHosts: true })` sets and only `startServer()` derives from `FETCH_MCP_ALLOW_PRIVATE_HOSTS` (parsed like `FETCH_MCP_SANDBOX`, fail-closed, unrecognised values named on stderr). Keep the check in `httpRequest()` -- the single path to the network -- not in individual tools. `src/tests/policy.test.ts` and the operator-gate block in `http.redirect-ssrf.test.ts` pin it; suites that reach a loopback fixture opt in explicitly.
14. **`fetch` and the pinned `Agent` come from the same `undici` import.** Never switch `sendHop()` back to the runtime's global `fetch`: Node's bundled undici (6.x on 22, 7.x on 24) drives dispatchers through the legacy handler API and undici 8's `Agent` rejects it, so every guarded hostname request fails with `fetch failed` on plain Node (0.4.0-0.7.0 shipped that way; Node 20 could not load undici 8 at all). `src/tests/http.pinned-dispatch.test.ts` is a real-socket test that catches it; the mock-based suites mock `undici`'s `fetch` and cannot.
15. **The sandbox's `--allow-env` grant must list every env var `src/` reads.** Under oam `--permission` an ungranted variable is ABSENT, not an error. Today that is exactly `FETCH_MCP_ALLOW_PRIVATE_HOSTS` (`sandboxFlags()` in `bin/fetch-mcp.mjs`, pinned by the launcher test); add any new `process.env` read under `src/` there too, or it silently reads as unset under the sandbox.
16. **The launcher refuses to serve on a Node below `NODE_MIN` (22.19.0) -- on every serve-on-Node path, before any sandbox note.** undici 8's floor is 22.19.0; below it Node 20 dies at import and Node 22 < 22.15 dies mid-session on the first `content-encoding: zstd` response (no `zlib.createZstdDecompress`). `refuseOldNodeInProcess()` guards the in-process and fallback paths, `handOffToNode()` probes the found `node --version`, and `fallbackSuffix()` drops "; using Node instead" when the refusal is coming. Keep `NODE_MIN` and `package.json` `engines.node` in step; `launcher.test.ts` pins both, and fakes `process.versions.node` to drive the refusal.
17. **The sitemap gzip cap is counted by hand on a streaming gunzip, never via zlib's `maxOutputLength`.** oam accepts that option and ignores it, so under the launcher's preferred runtime a `maxOutputLength`-only cap is no cap (a 200 KB `.xml.gz` OOM-killed the server at 4 GB). `gunzipCapped()` feeds 1 KiB input slices and destroys the stream once the output count passes the cap; the slice size bounds the overshoot on oam (~1 MiB), where each written slice inflates into one chunk.

## Convention quick-list

- Use npm, keep the lockfile committed.
- Run `npm run lint:fix` + `npm run typecheck` + `npm test` before every commit. Nothing runs checks for you -- no GitHub Actions, no git hooks -- so this local pass and `release.sh` steps 1-2 are the only checks. (A PR is still required to land on `main`; see below. It gates the merge, not the code.)
- Record user-facing changes under `## [Unreleased]` in `CHANGELOG.md` as you land them; `release.sh` promotes that heading to the release version.
- zod schemas describe tool input; the exported TypeScript type is derived from the zod shape, not hand-written.
- Tool callbacks always return a `formatX()` result — never throw. Upstream errors get caught and returned as `formatError(...)`.

## Landing changes: `main` requires a pull request

`main` and the release tags are guarded by three repository **rulesets**. They are not classic branch protection, so `gh api repos/YawLabs/fetch-mcp/branches/main/protection` answers 404 "Branch not protected" -- that answer is WRONG for this repo. Read `gh api repos/YawLabs/fetch-mcp/rules/branches/main` instead.

| Ruleset | Target | Rules | Who can bypass |
|---|---|---|---|
| Protect default branch | `main` | pull request required; 0 approvals; merge, squash or rebase | org admins |
| Protect release tags | `refs/tags/v*` | creation, deletion, non-fast-forward | org admins |
| Block force-push and deletion | `main` | deletion, non-fast-forward | nobody |

Jeff is an org admin, so a direct `git push origin main` from his account **succeeds**. The only sign is a line in the push output: `remote: Bypassed rule violations for refs/heads/main: - Changes must be made through a pull request.` That is a bypass of his protection, which his global rules forbid without asking first. On 2026-09-21 two non-release commits (`12363b4`, `ac4cccf`) went in that way before anyone noticed.

- **Every non-release change:** branch -> commit -> push the branch (with `GIT_SSH_COMMAND`) -> `gh pr create` -> `gh pr merge <N> --squash`. Zero approvals are required, so the merge needs no `--admin`.
- **The one sanctioned direct push is `release.sh` step 4:** the `vX.Y.Z` commit and its annotated tag, both through the org-admin bypass (creating a `v*` tag is admin-only). So land the changes by PR first, `git pull` on `main`, then run `./release.sh` from the clean, up-to-date `main`.
- **After any push, read the remote output.** "Bypassed rule violations" on anything other than a `release.sh` push means stop and tell Jeff.
- Force-push and deletion on `main` are blocked for everyone, admins included. There is no bypass to reach for.

## Release

**`./release.sh X.Y.Z` from a clean `main` on the workstation is the whole pipeline**, once the changes have landed by PR (above). The repo has no GitHub Actions workflows and Actions is disabled on it (workflows removed 2026-07-21), so nothing fires on tag push and nothing re-checks the tree after you. Don't hand-roll `npm version` + tag + push: that tags a version nobody publishes.

The script runs eight steps. Each is idempotent, so after an interruption re-run with the same version to resume:

1. Lint + typecheck -- the only lint gate this repo has.
2. Build + test.
3. Bump `package.json` / `package-lock.json`, sync `server.json`, and promote `## [Unreleased]` in `CHANGELOG.md` to the version. Aborts if the release would ship with unpromoted `[Unreleased]` content.
4. Commit `vX.Y.Z`, create an annotated tag, `git push origin main --follow-tags`. This direct push, and the `v*` tag creation, go through the org-admin ruleset bypass; the output shows "Bypassed rule violations" for both refs. It is the only sanctioned bypass.
5. `npm publish`, with EOTP retry.
6. GitHub release. Its notes are the CHANGELOG section for the version (passed by file), so the `[Unreleased]` block is what people read on the release page.
7. Smoke test (below), then MCP Registry publish via `mcp-publisher` (token: `MCP_REGISTRY_TOKEN`, else `gh auth token`).
8. Verify: the npm version, `package.json` and the git tag. Mismatches only warn.

**Auth:** an npm automation token in `~/.npmrc`; pre-flight aborts if `npm whoami` fails. Never `npm login --auth-type=web` -- it overwrites the automation token with a 2FA-bound session and the next publish EOTPs. The tag lands in step 4, before publish, so a tag is not proof of registry presence; check `npm view "@yawlabs/fetch-mcp@X.Y.Z" version`.

`release.sh` still carries a `CI=true` mode and a hand-off-to-`release.yml` branch from the Actions era. Both stay dormant while no workflow exists.

**Smoke test:** step 7 installs the just-published version with `npx` from a temp dir (retrying for up to ~5 min while the registry propagates), runs it with `--version`, and fails the release unless the output equals the version. It catches packaging regressions: a missing bin shebang, a bad `"files"` entry, broken tsup output. It depends on the argument handling in `src/index.ts` (Launch-critical #9).

## Sibling repos

- `@yawlabs/mcph` — the CLI that installs/orchestrates MCP servers. This server should show up in its catalog once we release.
- `@yawlabs/mcp-compliance` — runs the 88-test compliance suite. Goal: A grade.
