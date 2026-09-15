# Changelog

All notable changes to `@yawlabs/fetch-mcp` are documented here. This project uses [semantic versioning](https://semver.org). Releases ship via `release.sh`, run from the workstation: this repo has no GitHub Actions workflows (removed 2026-07-21), so `release.sh` is the sole pipeline and publishes to npm, GitHub Releases, and the MCP Registry itself.

## [Unreleased]

## [0.6.2] — 2026-09-15

### Security
- **`undici` is now `^8.9.0` (was `^8.5.0`) and `@modelcontextprotocol/sdk` is `^1.30.0` (was `^1.29.0`); `npm audit` goes from 10 findings (4 high) to 0.** Both are runtime dependencies that tsup leaves external, so none of this is bundled into the published `dist/` — a user's copies come from their own install, and a fresh install of 0.6.1 already resolves every patched version below. The `undici` floor is the one change that reaches users with an existing lockfile or npx cache: `^8.5.0` still admitted 8.5.0, inside the advised range (`8.0.0 - 8.8.0`) of five advisories against the cache and retry interceptors, the cookie helpers and blob-like request bodies — none of which this server uses; `src/http.ts` takes only `Agent`, as a DNS-pinned dispatcher for global `fetch`, with string bodies. The refreshed lockfile resolves `undici` 8.10.2 and moves the SDK's transitive packages past their advisories: `fast-uri` 3.1.2 -> 3.1.7 (via `ajv`, the only one of these the stdio server loads, and only on its own tool schemas, never on fetched URLs), `hono` 4.12.30 -> 4.13.7, `@hono/node-server` 1.19.14 -> 2.1.1, `ip-address` 10.2.0 -> 10.7.0 and `qs` 6.15.3 -> 6.16.0 — the last four belong to the SDK's HTTP transport, which this stdio-only server never imports. Raising the SDK floor forces none of that on its own, since 1.30.0 keeps the same transitive ranges; it is parity with the sibling servers.
- **The unused `fast-uri`, `hono`, `ip-address` and `qs` devDependency pins are gone.** They were added in June as hoisting pins for an earlier round of alerts; nothing in `src/`, `bin/` or `scripts/` imports them, and the `fast-uri` `^4.0.0` pin never covered the copy `ajv` requires (`^3.0.1`) — it only kept a second, itself-alerted 4.0.0 copy in the tree. With the pins removed, `fast-uri` 3.1.7 is the single copy and the lockfile drops from 282 to 275 entries.

### Internal
- Dev toolchain: `vitest` `^4.1.4` -> `^4.1.11` (the `@vitest/mocker` advisory), which also carries `vite` 8.1.5 -> 8.3.0, `postcss` 8.5.19 -> 8.5.28 and `nanoid` 3.3.12 -> 3.3.19 past theirs. None of it is in the published package.

## [0.6.1] — 2026-09-14

### Changed
- npm and MCP Registry listing metadata: bugs URL, core keywords, and server.json title/repository/websiteUrl
- `release.sh` writes a `## [x.y.z]` changelog entry for every release — promoting `[Unreleased]` when it has content, otherwise generating one from the commit subjects since the previous tag — keeps the Keep-a-Changelog link references current when the file has them, and takes the GitHub release notes from that entry instead of from `git log` subjects. Before this, a release with nothing under `[Unreleased]` got no entry at all (0.6.0 below is backfilled), and every GitHub release page showed raw commit subjects.
- package.json keywords: the core discoverability terms (mcp, mcp-server, model-context-protocol, claude-code, cursor, ai-agents, ai) now follow the product names, and `ssrf` moves ahead of the generic content keywords, so the terms that matter most survive GitHub's 20-topic cap when topics are synced from keywords. `atom` and `robots-txt` are the two that fall past it.

## [0.6.0] — 2026-09-13

Release tooling and documentation only; no change to the published package's behavior.

### Changed
- README: the X follow badge moved from the top of the page to the bottom, so the description leads on npm and GitHub (#42).

### Internal
- **`release.sh` waits for npm to serve the new version before the MCP Registry step.** `npm publish` returns as soon as the registry accepts the tarball, but the version is not yet readable from npm's CDN-backed read path, and the MCP Registry validates a publish by reading it — ssh-mcp v0.15.3's registry step failed with `version '0.15.3' was not found (status: 404)` and needed a re-run, and aws-mcp hit the same failure on three consecutive releases. The script now polls the exact per-version URL the registry's npm validator requests (`@yawlabs%2Ffetch-mcp/<version>`, the scope slash escaped the way Go's `url.PathEscape` does it) with `curl` rather than `npm view`, whose 5-minute metadata cache can outlast the condition it is waiting on. A timeout warns rather than fails, so `mcp-publisher` still reports its own precise error. `SKIP_NPM_WAIT=1` bypasses the wait, `NPM_WAIT_TIMEOUT_S` retunes the 300s default, and a host without curl skips it with a warning (#41).

## [0.5.7] — 2026-09-13

### Fixed
- **The launcher always uses the newest oam, and the minimum is now the latest release, 0.15.2.** It used to take the FIRST oam binary it found and only then check its version, so a stale copy in an earlier location hid a current one: with oam 0.9.0 in `~/.oam/bin` and 0.15.2 on `PATH`, it ran 0.9.0. Every oam binary it can see is now asked for its version, and the newest at or above 0.15.2 wins; on a tie the installed copy is kept.
- **An oam host older than the floor no longer serves the server itself.** When a client ran `oam run bin/fetch-mcp.mjs` with an old oam and discovery came up empty, the server ran on that old oam. It now hands off, with piped stdio, to the newest usable oam, or to Node on `PATH`, or exits with an error when there is neither. Piping matters: an oam older than 0.9.0 treats `stdio: 'inherit'` as `'pipe'`, so an inherited handoff never completes the MCP handshake (measured on a real oam 0.8.2 host with aws-mcp's copy of this launcher). The pipes, signal forwarding and the exit mirror all wait for the child's `spawn` event: a chosen oam that passed its version check but then fails to spawn still emits `close`, and reacting to it would exit the launcher in the middle of its fallback. `FETCH_MCP_SANDBOX=1` is unchanged: it still spawns a fresh oam from a supported oam host so `--permission` applies, and with nothing to spawn `FETCH_MCP_RUNTIME=auto` still serves in that host process without it.
- **A bad `OAM_BIN` no longer stops discovery, and a missing one is no longer silent.** A path that does not exist, an oam below the floor, or a binary that will not run is named on stderr, and discovery carries on instead of dropping straight to Node.
- **`FETCH_MCP_RUNTIME=node` now always means Node.** Launched under `oam run`, it hands off to Node on `PATH` rather than staying on oam.
- Each `oam --version` probe is bounded at 5s, so a wedged binary on `PATH` cannot hang the launch.
- The `FETCH_MCP_RUNTIME=oam`-but-nothing-usable message now goes through the same synchronous stderr helper as every other diagnostic, and lists what was found and why each candidate was passed over.

## [0.5.6] — 2026-09-13

### Fixed
- **`fetch_robots` returns the documented shape when a site has no `robots.txt`.** A 404 used to return only `robotsUrl`, `status`, `allowed` and `note`, so a caller reading `sitemaps`, `path`, `userAgent`, `matchedRule`, `crawlDelay` or `rawRobotsText` off the README shape got `undefined` — on the most common case, not an edge case. The 404 response now carries every documented key (`matchedRule: null`, `crawlDelay: null`, `sitemaps: []`, `rawRobotsText: ""`) alongside the unchanged verdict (`status: 404`, `allowed: true`) and the `note`, which the README now lists as optional. A new end-to-end test reads the key list from the README itself, so docs and handler cannot drift apart silently again. ([#34](https://github.com/YawLabs/fetch-mcp/issues/34))

## [0.5.5] — 2026-09-12

### Fixed
- **A mistyped or unsupported argument no longer hangs with no output.** Anything other than `version` / `--version` fell through to `startServer()`, which connects stdio and blocks on stdin forever, so `fetch-mcp versoin` or `fetch-mcp --help` looked like a broken package. It now prints `Unknown subcommand: <arg>` and a usage line to stderr (never stdout, the MCP channel) and exits 1. Launching with no argument — how MCP hosts start the server, and how every launcher path arrives: in-process under Node or a host oam, and the spawned `oam run <entry> -- …` hop, since oam consumes the `--` separator — is unchanged. ([#33](https://github.com/YawLabs/fetch-mcp/issues/33))

## [0.5.4] — 2026-09-12

### Fixed
- **The launcher no longer boots a second, nested oam when it is already running on one.** A host that resolves this package's `bin` and launches `oam run bin/fetch-mcp.mjs` — Yaw MCP does, and so does oam's sidecar regression matrix — got the launcher discovering and spawning another oam without asking what it was already running on: one server, two runtime boots (measured on Windows as `oam.exe` with a nested `oam.exe` + `conhost.exe` underneath). When `process.versions.oam` clears the same 0.9.0 floor a discovered binary must, the server is now imported into the host process directly. A host oam below the floor keeps the discovery path, and so does `FETCH_MCP_SANDBOX=1`, because `--permission` only applies to a fresh oam. That is a request for a spawn, not a guarantee: if discovery then finds nothing runnable, `FETCH_MCP_RUNTIME=auto` falls back to in-process *without* `--permission`, as it always has; `FETCH_MCP_RUNTIME=oam` makes that fatal.

### Internal
- **`biome.json`'s `$schema` now matches the installed biome** (moved from 2.4.11 to 2.5.1), so editor validation checks against the schema of the binary that actually runs. No config keys needed migrating.

## [0.5.3] — 2026-09-11

### Fixed
- **The launcher no longer dies with a raw stack trace when `spawn` fails.** Node throws synchronously rather than emitting `error` for some unexecutable targets — notably a `.cmd`/`.bat` on Windows — and the `error` listener is registered *after* the `spawn` call, so it could never observe that throw. Both failure modes now route through one handler.
- **Windows `PATH` discovery accepts `oam.exe` only**, instead of walking every `PATHEXT` entry and returning an `oam.cmd` Node cannot execute. A skipped shim is still **named** in the diagnostic, so an npm-style install no longer reports as "no oam binary was found".
- **A failing in-process fallback no longer escapes as an unhandled rejection.** `void runInProcess()` discarded the promise, replacing the launcher's own diagnostic with a raw stack trace.
- **Diagnostics that precede `process.exit` are written synchronously.** stderr is async for TTYs and pipes on Windows, so the exit could truncate them. They route through one helper that also handles short writes and macOS `EAGAIN` on a non-blocking piped stderr.
- Removed a literal backspace byte (`U+0008`) from the runtime-discovery comment, which made git treat the file as binary so its diff could not be reviewed.
- **An oam that cannot be *run* is no longer reported as an *outdated* one.** The version probe returns null for several distinct causes — not executable, wrong architecture, a shim Node refuses, deleted since the stat, unparseable `--version` output — and every one produced "older than oam 0.9.0 … run `oam self-update`", pointing at the single cause it definitely was not. The two cases now carry separate wording and remedies, and the outdated message reports the version actually detected.
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.

## [0.5.2] — 2026-08-23

### Fixed
- **The launcher no longer dies with a raw stack trace when `spawn` fails.** Node throws synchronously rather than emitting `error` for some unexecutable targets — notably a `.cmd`/`.bat` on Windows — and the `error` listener is registered *after* the `spawn` call, so it could never observe that throw. Both failure modes now route through one handler.
- **Windows `PATH` discovery accepts `oam.exe` only**, instead of walking every `PATHEXT` entry and returning an `oam.cmd` Node cannot execute. An oam-named `.cmd`/`.bat` skipped on PATH is still **named** in the diagnostic, so a shim install no longer reports as "no oam binary was found" — and in `auto` mode, where the fallback to Node used to be silent, the skipped shim is now noted on stderr.
- **A failing in-process fallback no longer escapes as an unhandled rejection.** `void runInProcess()` discarded the promise, replacing the launcher's own diagnostic with a raw stack trace.
- **Diagnostics that precede `process.exit` are written synchronously.** stderr is async for TTYs and pipes on Windows, so the exit could truncate them. Most now route through one helper that also handles short writes and macOS `EAGAIN` on a non-blocking piped stderr; the `FETCH_MCP_RUNTIME=oam`-but-nothing-runnable message is the remaining exception and still writes with a bare `writeSync`.
- Repaired the runtime-discovery comment, which named `%LOCALAPPDATA%\oam\bin` as a literal backspace (`U+0008`) with the preceding `\o` swallowed — a path that does not exist, carrying a control character into every reader of the file.
- **An oam that cannot be *run* is no longer reported as an *outdated* one.** The version probe returns null for several distinct causes — not executable, wrong architecture, a shim Node refuses, deleted since the stat, unparseable `--version` output — and every one was labelled "older than oam 0.9.0", with `FETCH_MCP_RUNTIME=oam` additionally saying to run `oam self-update`: the single cause it definitely was not. The two cases now carry separate wording and remedies, and the outdated message reports the version actually detected.
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.

### Security
- **`.gitignore` now excludes `.npmrc`.** A project-local `.npmrc` is not something you have to create deliberately — `npm config set --location=project` writes one, and some publish tooling drops one in — and it carries a live automation token. Untracked and unignored, a single `git add -A` commits that token to a public repo. No such file exists here and git has never tracked one; this closes the hole before it opens.

### Internal
- **The changelog's account of how this repo publishes was corrected against git history.** The intro paragraph was orphaned in the middle of the file and claimed publishing happened "in CI on tag push (`.github/workflows/release.yml`, the canonical path)" — there is no `.github` directory at all, the workflows having been removed on 2026-07-21 and shipped in 0.4.0 without ever being recorded. A second, lowercase `## Unreleased` heading between 0.4.0 and 0.3.1 held the "CI publish flow re-added" notes, which had actually shipped in v0.3.2. The intro moved to the top and now describes the real flow (`release.sh` from the workstation), the stray heading is retitled 0.3.2 — restoring strict descending order — and 0.4.0 records the removal. A stale claim of this kind is the expensive one: it is exactly what leads a reader to propose a publish workflow for a repo whose tests forbid one.
- **Backfilled the missing 0.5.0 entry.** `release.sh` derives GitHub release notes from commit subjects and never promotes an `Unreleased` heading, so this file is maintained by hand and that release was missed.

## [0.5.1] — 2026-08-23

### Fixed
- **The `--version` spawn ceiling now matches vitest's `testTimeout`.** Both `execFileSync` calls in `src/tests/version.test.ts` bounded the spawn at 5s while `vitest.config.ts` sets `testTimeout` to 15s. These bound a spawn expected to SUCCEED, so the ceiling has to cover a real `node` start under load rather than a warm one — a bare `node -e "0"` was measured at ~11s on a contended Windows box, more than double the ceiling, which fails the test for machine load rather than for anything about the code. The hang contract the suite protects is unchanged (`--version` must not reach `startServer()`, which connects stdio and blocks forever); it is now enforced by the outer `testTimeout` instead of the inner one. Both sites share a named `SPAWN_TIMEOUT_MS` so they cannot drift from the config again.
- **npm auth failures in `release.sh` now point at restoring the automation token** rather than at a login flow that would overwrite it.

## [0.5.0] — 2026-08-08

### Added
- **Opt-in `oam --permission` sandbox via `FETCH_MCP_SANDBOX=1`.** Opt-in rather than default because a wrong grant does not fail loudly: oam denies a non-granted environment variable by making it ABSENT from `process.env` rather than throwing, so an under-granted secret reads as "unauthenticated" rather than "denied". The env allow-list is derived from what the shipped bundle actually reads, not hand-written. Net is granted in full — fetching a caller-supplied URL is this server's job, so restricting by host would break the tool rather than harden it. The value is in what stays denied: this server reads no file and spawns no process, so running without an fs or child grant turns both into a runtime refusal rather than a capability it merely happens not to use today.
- **`server.json` / `package.json` version-parity test** (`src/release-metadata.test.ts`). `server.json` is what the Official MCP Registry reads at publish time; it carries the version twice (top-level plus `packages[].version`) and `release.sh` bumps it separately from `package.json`, so an edit updating one and not the other ships a desynced registry entry — visible to users, invisible to the release. Three assertions: top-level version parity, per-package version parity, and `mcpName` == `server.json` name (a distinct drift mode: the registry keys on `name` while npm consumers read `mcpName`, and disagreement puts discovery and install on different identifiers). The `mcpName` check asserts both fields are non-empty first so it cannot pass vacuously if a refactor drops both. Ported from tailscale-mcp, where it caught a real version skew and aborted the 0.15.0 publish.

### Changed
- **The launcher now requires oam >= 0.9.0.** It probes `oam --version`; below the floor, `auto` falls back to Node with a note on stderr and `FETCH_MCP_RUNTIME=oam` becomes a hard error. Older oam ran `child_process.execFile` arguments through a shell, accepted an exec timeout and ignored it, truncated `spawnSync` at `maxBuffer` while reporting success, and treated stdio `inherit`/`ignore` as `pipe`.

## [0.4.0] — 2026-08-07

### Added
- Runtime launcher at `bin/fetch-mcp.mjs`: the published `fetch-mcp` command now prefers the [oam](https://oamjs.org) runtime and falls back to Node. `FETCH_MCP_RUNTIME` selects (`auto` / `oam` / `node`) and `OAM_BIN` overrides discovery. Both paths verified against the MCP surface — handshake plus all 15 tools — and behave identically. The fallback does **not** re-exec Node: npm has already started Node to run the launcher, so it is an in-process `import()` with no extra spawn.

### Changed
- `.gitignore` excludes `bin/*` rather than `bin/`, so the launcher can be re-included with a negation. A negation cannot undo a directory-level exclusion — that trap shipped a broken `bin` in postgres-mcp, where the launcher was untracked and absent from every fresh clone.
- **GitHub Actions removed** (`ci.yml`, `release.yml`, dependabot). `release.sh` became the sole pipeline again, reversing the CI migration recorded in 0.3.2. Publishing now runs from the workstation.
- `scripts/build-binary.mjs` pins the CLI source entry instead of deriving it from `bin`'s value, which would have resolved to `bin/fetch-mcp.ts` once `bin` moved to the launcher — the breakage postgres-mcp shipped in its 0.9.0.

## 0.3.2 — 2026-05-15

### Internal

- **CI publish flow re-added.** Re-introduced `.github/workflows/release.yml` (fires on `v*` tag push, runs `release.sh` with `CI=true`) and `.github/workflows/ci.yml` (lint + typecheck + build + test on Node 20 + 22 for every push to main and every PR). Reverses the deliberate removal noted in 0.3.1's "Internal" section -- alignment with the rest of the YawLabs MCP repos that publish via CI on tag push using the org-level `NPM_TOKEN`. Local `release.sh X.Y.Z` still works as a fallback path.
- `release.sh` now dual-mode: detects `CI=true` and skips local-only steps (npm whoami pre-flight, dirty-tree check, interactive prompt, commit/tag/push -- the tag push triggered the run, so commit/tag/push is already done). Local mode keeps the EOTP retry loop and the npm whoami gate from the previous version.
- Annotated tags (`git tag -a "v${VERSION}" -m "v${VERSION}"`) so `git push --follow-tags` actually picks them up. Lightweight tags are silently skipped by `--follow-tags` and the release commit lands but the tag never reaches origin -- closes a latent bug that would have wedged the next release.
- Idempotency check in release.sh queries the versioned form `npm view "@yawlabs/fetch-mcp@${VERSION}" version` instead of the bare `npm view @yawlabs/fetch-mcp version`. The bare query returns whichever version is `latest` on the registry; a higher out-of-band version would make the script try to re-publish the current one and abort with "cannot publish over previously published version". The versioned form returns `$VERSION` exactly when it exists and empty otherwise.

## 0.3.1 — 2026-04-24

Security patch. No API changes; existing callers can upgrade in place.

### Security

- **Closed `fe80::/10` IPv6 SSRF gap.** The IPv6 block list used a string-prefix check with `"fe80"`, which only catches `fe80::/16`. The full link-local range is `fe80::-febf::`, so addresses like `fe85::1`, `fe9*::1`, `fea0::1`, `febf::1` were not blocked. The check now parses IPv6 to its 16 raw bytes and applies bit-level range tests for all reserved prefixes.
- **Closed hex-form IPv4-mapped bypass.** `::ffff:127.0.0.1` was caught by a dotted-quad regex, but `::ffff:7f00:1` (the same address in hex form) was not -- a caller who knew the hex encoding could route around the v4 block list. IPv4-mapped detection now runs on the parsed bytes, so any textual form is normalized before the embedded v4 is re-checked.

### Internal

- Removed GitHub Actions (`ci.yml`, `release.yml`) and disabled Dependabot vulnerability alerts on the repo.
- `release.sh` rewritten for local publish: `npm whoami` pre-flight, `npm publish --access public` with EOTP retry, tag-after-publish.
- Hoisted `html.toLowerCase()` out of the per-anchor loop in `extractLinks` -- avoids O(N*K) string allocation on large pages.

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
