import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const RELEASE_SH = resolve(REPO_ROOT, "release.sh");
const source = readFileSync(RELEASE_SH, "utf-8");

/**
 * Pull a top-level bash function definition out of release.sh by name. Throws
 * when the name is missing or the script was reformatted past the matching
 * pattern, so a silent skip is impossible -- the test fails loudly with the
 * same surface as a regression.
 */
function extractFunction(name: string): string {
  // Match `name() {` through the matching closing `}` at column 0. bash only
  // treats `}` as a function closer at column 0, so a body that contains
  // nested blocks (e.g. a `case` inside an `if`) is fine.
  const re = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m");
  const match = source.match(re);
  if (!match) throw new Error(`could not extract function ${name}() from release.sh -- renamed or reformatted?`);
  return match[0];
}

const SOURCED = ["changelog_section", "changelog_nonempty", "changelog_dash", "changelog_prev_tag"]
  .map(extractFunction)
  .join("\n");

/**
 * Run a chunk of bash that sources the extracted changelog functions and then
 * evaluates `body` in that environment. `cwd` is the working directory for
 * git invocations (the tests need a real git repo with a tag set); the
 * function references are inlined into the command so the test never depends
 * on release.sh's own working directory.
 */
function runBash(
  body: string,
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  const full = `set -e\n${SOURCED}\n${body}`;
  // bash reads the script from a file, not as `bash -c` text: on Windows that
  // text crosses a command line msys re-parses, and a double quote inside
  // single quotes -- as in the MCP Registry block's patterns -- comes back
  // with its escaping backslash, or ends the parse early.
  const dir = mkdtempSync(join(tmpdir(), "release-sh-run-"));
  const script = join(dir, "run.sh");
  writeFileSync(script, full);
  // release.sh's MCP Registry time limit reads these. release.sh runs this
  // suite before it publishes, so an operator's own setting must not reach it.
  const inherited = { ...process.env };
  for (const name of ["MCP_PUBLISH_TIMEOUT_S", "MCP_PUBLISH_KILL_AFTER_S", "MCP_TIMEOUT_READY"]) {
    delete inherited[name];
  }
  try {
    const result = spawnSync("bash", [script.split("\\").join("/")], {
      encoding: "utf-8",
      cwd: opts.cwd,
      env: { ...inherited, ...opts.env, LC_ALL: "C" },
      input: opts.stdin,
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// These tests build a real git repo, one spawn per step: the longest makes
// ~20 `git` calls plus a bash. On a contended Windows box a single `git`
// spawn was measured at ~1.4s, so vitest's 15s default failed the test for
// machine load rather than for anything release.sh does. Same reasoning as
// TIMEOUT_MS in launcher.test.ts.
const GIT_SPAWN_TIMEOUT_MS = 60_000;

describe("changelog_prev_tag", { timeout: GIT_SPAWN_TIMEOUT_MS }, () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "clprev-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a"), "a");
    execFileSync("git", ["add", "a"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "a"], { cwd: repo });
  }, GIT_SPAWN_TIMEOUT_MS);

  it("returns empty when the version is the only v* tag (true first release)", () => {
    execFileSync("git", ["tag", "-a", "v0.1.0", "-m", "v0.1.0"], { cwd: repo });
    const r = runBash("VERSION=0.1.0\nchangelog_prev_tag", { cwd: repo });
    expect(r.stdout.trim()).toBe("");
  });

  it("returns empty when the version is not yet a tag (pre-publish)", () => {
    // release.sh calls changelog_prev_tag BEFORE step 4 creates the new tag.
    // The version is therefore not in the tag list at all; the function must
    // not return some unrelated recent tag.
    execFileSync("git", ["tag", "-a", "v0.0.9", "-m", "v0.0.9"], { cwd: repo });
    const r = runBash("VERSION=0.1.0\nchangelog_prev_tag", { cwd: repo });
    expect(r.stdout.trim()).toBe("");
  });

  it("returns the immediate semver predecessor, not the most-recently-reachable tag", () => {
    // The motivating bug: a re-run on a tagged version (v0.0.4) with commits
    // added since v0.0.3 was tagged. `git describe --exclude v0.0.4` returns
    // the most recent tag REACHABLE from HEAD, which can be v0.0.0 -- an
    // unrelated ancestor -- and the generated changelog then pulls the wrong
    // commits. The fix uses `git tag --sort`; this test pins that.
    writeFileSync(join(repo, "b"), "b");
    execFileSync("git", ["add", "b"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "b"], { cwd: repo });
    execFileSync("git", ["tag", "-a", "v0.0.0", "-m", "v0.0.0"], { cwd: repo });
    writeFileSync(join(repo, "c"), "c");
    execFileSync("git", ["add", "c"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "c"], { cwd: repo });
    execFileSync("git", ["tag", "-a", "v0.0.1", "-m", "v0.0.1"], { cwd: repo });
    writeFileSync(join(repo, "d"), "d");
    execFileSync("git", ["add", "d"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "d"], { cwd: repo });
    execFileSync("git", ["tag", "-a", "v0.0.2", "-m", "v0.0.2"], { cwd: repo });
    writeFileSync(join(repo, "e"), "e");
    execFileSync("git", ["add", "e"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "e"], { cwd: repo });
    execFileSync("git", ["tag", "-a", "v0.0.3", "-m", "v0.0.3"], { cwd: repo });
    writeFileSync(join(repo, "f"), "f");
    execFileSync("git", ["add", "f"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "f"], { cwd: repo });
    execFileSync("git", ["tag", "-a", "v0.0.4", "-m", "v0.0.4"], { cwd: repo });

    const r = runBash("VERSION=0.0.4\nchangelog_prev_tag", { cwd: repo });
    expect(r.stdout.trim()).toBe("v0.0.3");
  });
});

describe("changelog_section", () => {
  it("returns the body of a single section, stopping at the next ## [...] heading", () => {
    const cl = [
      "## [Unreleased]",
      "",
      "## [0.6.2] -- 2026-09-15",
      "",
      "### Security",
      "- undici floor raised",
      "",
      "## [0.6.1] -- 2026-09-14",
      "",
      "### Changed",
      "- npm and MCP Registry listing metadata",
      "",
    ].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "clsec-"));
    writeFileSync(join(dir, "CHANGELOG.md"), cl);
    const r = runBash(`VERSION=0.6.2\nchangelog_section "$VERSION"`, { cwd: dir });
    expect(r.stdout).toContain("### Security");
    expect(r.stdout).toContain("undici floor raised");
    expect(r.stdout).not.toContain("### Changed");
    expect(r.stdout).not.toContain("npm and MCP Registry listing metadata");
  });

  it("returns empty when the section has no body before the next heading", () => {
    const cl = ["## [Unreleased]", "", "## [0.6.2] -- 2026-09-15", "", "### Security", "- x", ""].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "clsec-"));
    writeFileSync(join(dir, "CHANGELOG.md"), cl);
    const r = runBash(`VERSION=Unreleased\nchangelog_section "$VERSION"`, { cwd: dir });
    expect(r.stdout.trim()).toBe("");
  });
});

describe("changelog_dash", () => {
  it("reuses the file's existing separator", () => {
    // The fleet mixes em-dash and `--`; promoting with a hardcoded one would
    // introduce a third style into whichever repos do not use it.
    const cl = ["## [0.6.2] -- 2026-09-15", "", "## [0.6.1] -- 2026-09-14", ""].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "cldash-"));
    writeFileSync(join(dir, "CHANGELOG.md"), cl);
    const r = runBash("changelog_dash", { cwd: dir });
    expect(r.stdout).toBe("--");
  });

  it("falls back to '--' when no version heading matches the pattern", () => {
    const cl = ["# Changelog", "", "Some preamble without a version heading.", ""].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "cldash-"));
    writeFileSync(join(dir, "CHANGELOG.md"), cl);
    const r = runBash("changelog_dash", { cwd: dir });
    expect(r.stdout).toBe("--");
  });
});

describe("release prompt block", () => {
  /**
   * The release.sh prompt block has two branches:
   *   - interactive: prints the prompt, then `step 1`
   *   - non-interactive: prints the "Non-interactive shell" info, then `step 1`
   * Earlier the `else` was bound to the OUTER `if` and only `step 1` ran in
   * both cases; the info message was dead code. This test pins both branches
   * by sourcing the literal prompt block (lines 272-292) and feeding it a
   * controlled stdin. The `step` and `info` functions are stubbed so we
   * observe what the block emitted without running the rest of release.sh.
   */
  let promptBlock: string;
  beforeEach(() => {
    const lines = source.split("\n");
    // Lines are 0-indexed in the array; release.sh is 1-indexed in editors.
    // Extract lines 272..292 inclusive (the outer if through its closing fi).
    promptBlock = lines.slice(271, 292).join("\n");
  });

  function runPromptBlock(
    stdin: string,
    isTerminal: boolean,
    opts: { isCi?: boolean; resuming?: boolean } = {},
  ): string {
    const isCi = opts.isCi ?? false;
    const resuming = opts.resuming ?? false;
    // bash's `[[ -t 0 ]]` is a special builtin and cannot be stubbed. The
    // portable workaround: rewrite the script's `[ -t 0 ]` to read a flag
    // we control, leaving every other `[` test unchanged. The block-under-
    // test still exercises the real `read`, the regex match, the `else` for
    // the non-interactive branch, and the closing `fi` -- the only thing
    // synthesized is the test that selects between them.
    const stubbed = promptBlock
      .replace(/step 1 "Lint \+ typecheck"/, "echo STEP_RAN")
      .replace(/info "Non-interactive shell -- proceeding without confirmation"/, "echo INFO_RAN")
      .replace(/if \[ -t 0 \]; then/, `if [ "${isTerminal ? "0" : "1"}" = "0" ]; then`);
    return runBash(`IS_CI=${isCi}\nRESUMING=${resuming}\nVERSION=0.0.1\n${stubbed}`, { stdin }).stdout;
  }

  it("prints the Non-interactive shell message when stdin is not a tty", () => {
    const out = runPromptBlock("", false);
    expect(out).toContain("INFO_RAN");
    expect(out).toContain("STEP_RAN");
  });

  it("aborts on 'n' to the interactive prompt", () => {
    const out = runPromptBlock("n\n", true);
    expect(out).toContain("Aborted.");
    expect(out).not.toContain("STEP_RAN");
  });

  it("proceeds to step 1 on 'y' to the interactive prompt", () => {
    const out = runPromptBlock("y\n", true);
    expect(out).not.toContain("Aborted.");
    expect(out).toContain("STEP_RAN");
    expect(out).not.toContain("INFO_RAN");
  });

  it("skips the entire block in CI mode (IS_CI=true)", () => {
    const out = runPromptBlock("", false, { isCi: true });
    expect(out).not.toContain("INFO_RAN");
    expect(out).not.toContain("STEP_RAN");
  });

  it("skips the entire block when resuming an interrupted release", () => {
    const out = runPromptBlock("", false, { resuming: true });
    expect(out).not.toContain("INFO_RAN");
    expect(out).not.toContain("STEP_RAN");
  });
});

/**
 * Slice release.sh from the line equal to `start` through the first later line
 * equal to `end`, inclusive. Anchored on text rather than line numbers, and
 * throws when either anchor is gone, so a rewritten block fails the suite
 * instead of testing nothing.
 */
function extractBlock(start: string, end: string): string {
  const lines = source.split("\n");
  const from = lines.indexOf(start);
  if (from === -1) throw new Error(`release.sh block start not found: ${start}`);
  const to = lines.findIndex((line, i) => i > from && line === end);
  if (to === -1) throw new Error(`release.sh block end not found after ${start}: ${end}`);
  return lines.slice(from, to + 1).join("\n");
}

// Tagged stand-ins for release.sh's helpers. fail() exits like the real one;
// sleep() only records its argument, so the 30/60/90 s waits cost nothing.
const HELPER_STUBS = [
  'info() { echo "INFO: $1"; }',
  'warn() { echo "WARN: $1"; }',
  'fail() { echo "FAIL: $1"; exit 1; }',
  'sleep() { echo "SLEEP: $1"; }',
].join("\n");

// Each case is one bash that forks a few dozen short processes (grep, tee,
// mktemp, wc) -- the same load headroom as the git-spawning suite above.
const BASH_BLOCK_TIMEOUT_MS = 60_000;

describe("step 5 workstation npm publish loop", { timeout: BASH_BLOCK_TIMEOUT_MS }, () => {
  // From the attempt counter through the closing `fi` of the success line.
  const block = extractBlock("  ATTEMPT=1", "  fi");

  const NPM_STUB = [
    "npm() {",
    '  echo "NPM_CALL $*"',
    '  case "$NPM_SCENARIO" in',
    "    ok) return 0 ;;",
    "    e403) echo 'npm error code E403' >&2",
    "      echo 'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@yawlabs%2ffetch-mcp - You cannot publish over the previously published versions: 0.8.2.' >&2 ;;",
    "    eotp) echo 'npm error code EOTP' >&2",
    "      echo 'npm error This operation requires a one-time password from your authenticator.' >&2 ;;",
    "    e404) echo 'npm error code E404' >&2",
    "      echo 'npm error 404 Not Found - PUT https://registry.npmjs.org/@yawlabs%2ffetch-mcp - Not found' >&2 ;;",
    "  esac",
    "  return 1",
    "}",
  ].join("\n");

  function runPublish(scenario: string): { out: string; status: number | null; calls: number } {
    const body = ["set -o pipefail", HELPER_STUBS, NPM_STUB, "VERSION=0.8.2", block, 'echo "BLOCK_DONE"'].join("\n");
    const r = runBash(body, { env: { NPM_SCENARIO: scenario } });
    return { out: r.stdout, status: r.status, calls: (r.stdout.match(/NPM_CALL/g) ?? []).length };
  }

  it("treats npm's E403 'cannot publish over' as already published: a warn, no fail, no retry", () => {
    // The resume case: the skip check read a stale answer, so npm publish ran
    // for a version npm already holds. That used to die as a "non-OTP error".
    const r = runPublish("e403");
    expect(r.status).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.out).toContain("WARN: npm already holds @yawlabs/fetch-mcp@0.8.2 (its E403 said so)");
    expect(r.out).not.toContain("INFO: Published");
    expect(r.out).not.toContain("FAIL:");
    expect(r.out).toContain("BLOCK_DONE");
  });

  it("reports a real publish with the info line", () => {
    const r = runPublish("ok");
    expect(r.status).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.out).toContain("INFO: Published @yawlabs/fetch-mcp@0.8.2 to npm (workstation)");
    expect(r.out).not.toContain("WARN:");
  });

  it("still retries an EOTP up to MAX_ATTEMPTS, then fails", () => {
    const r = runPublish("eotp");
    expect(r.status).toBe(1);
    expect(r.calls).toBe(3);
    expect(r.out).toContain("FAIL: npm publish failed after 3 OTP-class attempts");
    expect(r.out).not.toContain("npm already holds");
  });

  it("still fails at once on any other npm error", () => {
    const r = runPublish("e404");
    expect(r.status).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.out).toContain("FAIL: npm publish failed (non-OTP error");
    expect(r.out).not.toContain("npm already holds");
  });
});

describe("step 7 MCP Registry publish retry", { timeout: BASH_BLOCK_TIMEOUT_MS }, () => {
  // From the log's mktemp through the closing `fi` of the done/fail decision.
  const block = extractBlock("  MCP_PUBLISH_LOG=$(mktemp)", "  fi");
  // release.sh's own time-limit helpers, which the block calls.
  const TIME_LIMIT = ["mcp_timeout_setup", "mcp_bounded", "mcp_login_fail"].map(extractFunction).join("\n");

  const PKG = "@yawlabs/fetch-mcp";
  const V = "0.8.2";
  const FAIL_LINE =
    "FAIL: mcp-publisher publish failed -- npm + GitHub release succeeded, but the MCP Registry did not.";
  // mcp-publisher's envelope around the registry's validator message.
  const wrap = (message: string) =>
    `Error: publish failed: server returned status 400: {"title":"Bad Request","status":400,"detail":"Failed to publish server","errors":[{"message":"registry validation failed for package 0 (${PKG}): ${message}"}]}`;

  // The stub answers attempt N with response N (the last one repeats) and
  // never echoes the version itself, so only the response text can match.
  const MP_STUB = [
    "MP_CALLS=$(mktemp)",
    "MP_REPLIES=$(mktemp)",
    'printf \'%s\\n\' "$MP_RESPONSES_TEXT" > "$MP_REPLIES"',
    "mp_stub() {",
    '  echo x >> "$MP_CALLS"',
    "  local n last reply",
    '  n=$(wc -l < "$MP_CALLS")',
    '  echo "MP_CALL $n"',
    '  last=$(wc -l < "$MP_REPLIES")',
    '  [ "$n" -le "$last" ] || n=$last',
    '  reply=$(sed -n "$n"p "$MP_REPLIES")',
    // What timeout(1) returns for an attempt it stopped, and, on newer
    // coreutils, for one that only the KILL ended.
    '  if [ "$reply" = "timeout" ]; then return 124; fi',
    '  if [ "$reply" = "killed" ]; then return 137; fi',
    '  if [ "$reply" = "ok" ]; then echo "published"; return 0; fi',
    "  printf '%s\\n' \"$reply\" >&2",
    "  return 1",
    "}",
    "MP=mp_stub",
    // GNU timeout cannot run a shell function like mp_stub. This stand-in says
    // it is coreutils, so the block wraps each call in it, skips the options
    // and the duration it is given, and runs the rest.
    "timeout() {",
    '  if [ "$1" = --version ]; then echo "timeout (GNU coreutils) 9.1"; return 0; fi',
    '  while case "$1" in -*) true ;; *) false ;; esac; do [ "$1" = -k ] && shift; shift; done',
    "  shift",
    '  "$@"',
    "}",
  ].join("\n");

  function runRegistry(
    responses: string[],
    preamble = "",
  ): { out: string; status: number | null; calls: number; sleeps: string[] } {
    const body = [
      "set -o pipefail",
      HELPER_STUBS,
      MP_STUB,
      preamble,
      TIME_LIMIT,
      `VERSION=${V}`,
      block,
      'echo "BLOCK_DONE"',
    ].join("\n");
    const r = runBash(body, { env: { MP_RESPONSES_TEXT: responses.join("\n") } });
    return {
      // The time limit's notes and warnings go to stderr.
      out: r.stdout + r.stderr,
      status: r.status,
      calls: (r.stdout.match(/MP_CALL/g) ?? []).length,
      sleeps: [...r.stdout.matchAll(/^SLEEP: (\d+)$/gm)].map((m) => m[1]),
    };
  }

  // The live registry's (v1.8.1) npm-validator answers that waiting cures.
  const TRANSIENT: [string, string][] = [
    [
      "404, package exists but not the version",
      wrap(
        `NPM package '${PKG}' exists, but version '${V}' was not found (status: 404). A newly published release can take a moment to appear on the registry. Wait and retry, ...`,
      ),
    ],
    ["404, version not found", wrap(`NPM package '${PKG}' version '${V}' not found (status: 404)`)],
    [
      "404, package check inconclusive",
      wrap(
        `NPM could not confirm package '${PKG}' version '${V}' (version status: 404, package check inconclusive). Likely transient, retry later`,
      ),
    ],
    [
      "429",
      wrap(`NPM rate-limited the metadata request for package '${PKG}' (status: 429). Likely transient, retry later`),
    ],
    [
      "5xx",
      wrap(`NPM upstream error fetching metadata for package '${PKG}' (status: 503). Likely transient, retry later`),
    ],
    [
      "network error",
      wrap(`failed to fetch package metadata from NPM: Get "https://registry.npmjs.org/": dial tcp: i/o timeout`),
    ],
  ];

  it.each(TRANSIENT)("retries a %s answer, then publishes", (_name, text) => {
    const r = runRegistry([text, "ok"]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.sleeps).toEqual(["30"]);
    expect(r.out).toContain(`WARN: MCP Registry cannot see ${PKG}@${V} on npm yet -- waiting 30s, then attempt 2 of 4`);
    expect(r.out).toContain("INFO: Published to MCP Registry");
    expect(r.out).not.toContain("FAIL:");
  });

  it("treats a duplicate version as already registered", () => {
    const r = runRegistry([
      `Error: publish failed: server returned status 400: {"title":"Bad Request","status":400,"detail":"invalid version: cannot publish duplicate version: io.github.YawLabs/fetch-mcp@${V} already exists"}`,
    ]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.out).toContain(`INFO: MCP Registry already has ${V} -- nothing to publish`);
    expect(r.out).not.toContain("FAIL:");
  });

  const DUPLICATE = `Error: publish failed: server returned status 400: {"title":"Bad Request","status":400,"detail":"invalid version: cannot publish duplicate version: io.github.YawLabs/fetch-mcp@${V} already exists"}`;

  // No answer at all: mcp-publisher v1.7.9's own words for a dropped
  // connection, captured against a local registry, and the time limit's exit
  // code for an attempt it stopped.
  it.each([
    [
      "dropped before any answer",
      'Error: publish failed: error sending request: Post "http://127.0.0.1:58812/v0/publish": EOF',
    ],
    ["cut off mid-answer", "Error: publish failed: error reading response: unexpected EOF"],
    // Go quotes a malformed header line the server sent; a phrase inside those
    // quotes must not pass for a proxy's refusal, with a colon after it or not.
    [
      "dropped with the server's own bytes echoed back",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": net/http: HTTP/1.x transport connection broken: malformed MIME header line: X": Bad thing',
    ],
    [
      "dropped with the server's own bytes, and a colon, echoed back",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": net/http: HTTP/1.x transport connection broken: malformed MIME header line: X": Bad: thing',
    ],
  ])("retries a connection %s, then publishes", (_name, text) => {
    const r = runRegistry([text, "ok"]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.sleeps).toEqual(["30"]);
    expect(r.out).toContain(
      "WARN: MCP Registry dropped the connection without an answer -- waiting 30s, then attempt 2 of 4",
    );
    expect(r.out).toContain("INFO: Published to MCP Registry");
  });

  // A connection mcp-publisher v1.7.9 reports as never opened: a failed DNS
  // lookup, a TLS handshake Go's default transport gave up on after 10 s, and
  // a proxy that refused the CONNECT tunnel (Go reports only the proxy's
  // reason phrase, "unknown status code" when it gives none, and nothing when
  // it ends its status line at the code's space). The TLS and proxy texts are
  // the real binary's, captured against a local listener that never answers
  // the handshake and a local proxy that refused CONNECT with "502 Bad
  // Gateway", "502 Proxy Error", a bare "502", "502 " and "505 HTTP Version
  // Not Supported".
  it.each([
    [
      "a failed lookup",
      'Error: publish failed: error sending request: Post "https://registry.modelcontextprotocol.io/v0/publish": dial tcp: lookup registry.modelcontextprotocol.io: no such host',
    ],
    [
      "a TLS handshake timeout",
      'Error: publish failed: error sending request: Post "https://127.0.0.1:57912/v0/publish": net/http: TLS handshake timeout',
    ],
    [
      "a proxy that refused the tunnel",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": Bad Gateway',
    ],
    [
      "a proxy that refused it in its own words",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": Proxy Error',
    ],
    [
      "a proxy that refused it with no reason phrase",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": unknown status code',
    ],
    [
      "a proxy that refused it with an empty reason phrase",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": ',
    ],
    [
      "a proxy whose reason phrase has a colon",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": Blocked by policy: category gambling',
    ],
    [
      "a proxy whose reason phrase starts with an all-capitals word",
      'Error: publish failed: error sending request: Post "https://registry.example.com/v0/publish": HTTP Version Not Supported',
    ],
  ])("retries a registry it could not reach (%s), and does not read a later duplicate as this run's", (_name, text) => {
    const r = runRegistry([text, DUPLICATE]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.out).toContain("WARN: MCP Registry could not be reached -- waiting 30s, then attempt 2 of 4");
    expect(r.out).toContain(`INFO: MCP Registry already has ${V} -- nothing to publish`);
    expect(r.out).not.toContain("got no clear answer landed");
  });

  it("does not read a duplicate after a 429 as this run's attempt having landed", () => {
    const r = runRegistry([
      'Error: publish failed: server returned status 429: {"title":"Too Many Requests","status":429}',
      DUPLICATE,
    ]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.out).toContain(`INFO: MCP Registry already has ${V} -- nothing to publish`);
    expect(r.out).not.toContain("got no clear answer landed");
  });

  it("retries an attempt the time limit stopped, then publishes", () => {
    const r = runRegistry(["timeout", "ok"]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.out).toContain("mcp-publisher did not answer within 90s -- stopped it");
    expect(r.out).toContain("WARN: MCP Registry did not answer within 90s -- waiting 30s, then attempt 2 of 4");
    expect(r.out).toContain("INFO: Published to MCP Registry");
  });

  it.each(["abc", "0"])("falls back to a 10 s KILL grace for MCP_PUBLISH_KILL_AFTER_S=%s", (value) => {
    // 0 too: timeout(1) reads a KILL grace of 0 as never sending the KILL.
    const r = runRegistry(["ok"], `MCP_PUBLISH_KILL_AFTER_S=${value}`);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`WARN: MCP_PUBLISH_KILL_AFTER_S='${value}' is not whole seconds above 0 -- using 10`);
    expect(r.out).toContain("INFO: Published to MCP Registry");
  });

  it("retries an attempt that only the KILL ended (137), then publishes", () => {
    const r = runRegistry(["killed", "ok"]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.out).toContain("mcp-publisher did not answer within 90s -- stopped it");
    expect(r.out).toContain("WARN: MCP Registry did not answer within 90s -- waiting 30s, then attempt 2 of 4");
    expect(r.out).toContain("INFO: Published to MCP Registry");
  });

  it("reads a duplicate after an attempt that got no answer as that attempt having landed", () => {
    const r = runRegistry(["timeout", DUPLICATE]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.out).toContain(
      `INFO: MCP Registry refused the retry of ${V} as a duplicate: an attempt of this run that got no clear answer landed`,
    );
    expect(r.out).not.toContain("FAIL:");
  });

  it("retries the registry's own 504, then publishes", () => {
    const r = runRegistry([
      "Error: publish failed: server returned status 504: <html><title>504 Gateway Time-out</title></html>",
      "ok",
    ]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.out).toContain(
      "WARN: MCP Registry answered HTTP 504 itself -- busy or timing out, not a verdict -- waiting 30s, then attempt 2 of 4",
    );
  });

  it("without a coreutils timeout, runs unbounded, says so, and does not read an exit of 124 as no answer", () => {
    // Windows' own timeout.exe, asked for --version, prints this and exits 1.
    const r = runRegistry(
      ["timeout", "ok"],
      [
        'timeout() { echo "ERROR: Invalid value for timeout (/T) specified. Valid range is -1 to 99999."; return 1; }',
        // A real gtimeout (Homebrew coreutils) could not run mp_stub either.
        "gtimeout() { return 127; }",
      ].join("\n"),
    );
    expect(r.out).toContain("WARN: Neither timeout nor gtimeout on PATH is the coreutils one");
    expect(r.status).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.out).toContain(FAIL_LINE);
  });

  // The step's first login, as release.sh writes it.
  const LOGIN_START = '  mcp_bounded "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null \\';
  const sourceLines = source.split("\n");
  const LOGIN_END = sourceLines[sourceLines.indexOf(LOGIN_START) + 1] ?? "";
  if (!LOGIN_END.startsWith('    || mcp_login_fail "')) {
    throw new Error("release.sh: the first login no longer fails through mcp_login_fail on its next line");
  }
  const LOGIN = extractBlock(LOGIN_START, LOGIN_END);
  function runLogin(reply: string): { out: string; status: number | null } {
    const body = [HELPER_STUBS, MP_STUB, TIME_LIMIT, "MCP_REGISTRY_TOKEN=fixture", LOGIN, 'echo "LOGGED_IN"'].join(
      "\n",
    );
    const r = runBash(body, { env: { MP_RESPONSES_TEXT: reply } });
    return { out: r.stdout + r.stderr, status: r.status };
  }

  it("fails a first login the time limit stopped as the registry not answering, not a bad token", () => {
    const r = runLogin("timeout");
    expect(r.status).toBe(1);
    expect(r.out).toContain("mcp-publisher did not answer within 90s -- stopped it");
    expect(r.out).toContain(
      "FAIL: The MCP Registry did not answer the mcp-publisher login within 90s -- npm + GitHub release succeeded, but the MCP Registry step did not.",
    );
    expect(r.out).not.toContain("A 401 there is");
    expect(r.out).not.toContain("LOGGED_IN");
  });

  it("says how to read the output of a first login that failed any other way", () => {
    // mcp-publisher v1.7.9's line for the v1.8.1 registry's 401, which it gives
    // for a bad token and for GitHub's own API failing alike.
    const r = runLogin(
      'Error: failed to get token: failed to exchange token: token exchange failed with status 401: {"title":"Unauthorized","status":401,"detail":"Token exchange failed"}',
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      "FAIL: mcp-publisher login failed -- its output is above. A 401 there is the registry refusing the token exchange",
    );
    expect(r.out).toContain("A 429, a 5xx or a connection error is the registry or the network.");
    expect(r.out).not.toContain("did not answer");
    // The registry checks namespace rights only at publish.
    expect(r.out).not.toContain("read:org");
  });

  // Failures no wait cures: each must stop on the first attempt.
  const PERMANENT: [string, string][] = [
    [
      "422 schema failure",
      'Error: publish failed: server returned status 422: {"title":"Unprocessable Entity","status":422,"detail":"validation failed","errors":[{"message":"expected string, got number","location":"body.packages[0].identifier"}]}',
    ],
    [
      "401",
      'Error: publish failed: server returned status 401: {"title":"Unauthorized","status":401,"detail":"Invalid or expired Registry JWT token"}',
    ],
    [
      "400 mcpName mismatch",
      wrap(
        `NPM package '${PKG}' ownership validation failed. Expected mcpName 'io.github.YawLabs/fetch-mcp', got 'io.github.someone/fetch-mcp'`,
      ),
    ],
    ["404 for a missing package, without the version", wrap(`NPM package '${PKG}' not found (status: 404)`)],
  ];

  it.each(PERMANENT)("fails a %s on the first attempt", (_name, text) => {
    const r = runRegistry([text, "ok"]);
    expect(r.status).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.sleeps).toEqual([]);
    expect(r.out).toContain(FAIL_LINE);
    expect(r.out).not.toContain("BLOCK_DONE");
    expect(r.out).not.toContain("A 403 on publish");
  });

  it("says what the namespace takes when the registry refuses the publish with a 403", () => {
    // The v1.8.1 registry's refusal, its advice trimmed.
    const r = runRegistry([
      'Error: publish failed: server returned status 403: {"title":"Forbidden","status":403,"detail":"You do not have permission to publish this server. You have permission to publish: io.github.jeffyaw/*. Attempting to publish: io.github.YawLabs/fetch-mcp."}',
      "ok",
    ]);
    expect(r.status).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.out).toContain("WARN: A 403 on publish is the registry refusing the io.github.YawLabs namespace.");
    expect(r.out).toContain("a YawLabs org Owner whose token can read org roles");
    expect(r.out).toContain(FAIL_LINE);
  });

  it("gives up after four attempts, 30, 60 and 90 s apart", () => {
    const r = runRegistry([TRANSIENT[0][1]]);
    expect(r.status).toBe(1);
    expect(r.calls).toBe(4);
    expect(r.sleeps).toEqual(["30", "60", "90"]);
    expect(r.out).toContain(FAIL_LINE);
  });
});
