import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const result = spawnSync("bash", ["-c", full], {
    encoding: "utf-8",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, LC_ALL: "C" },
    input: opts.stdin,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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
    '  if [ "$reply" = "ok" ]; then echo "published"; return 0; fi',
    "  printf '%s\\n' \"$reply\" >&2",
    "  return 1",
    "}",
    "MP=mp_stub",
  ].join("\n");

  function runRegistry(responses: string[]): { out: string; status: number | null; calls: number; sleeps: string[] } {
    const body = ["set -o pipefail", HELPER_STUBS, MP_STUB, `VERSION=${V}`, block, 'echo "BLOCK_DONE"'].join("\n");
    const r = runBash(body, { env: { MP_RESPONSES_TEXT: responses.join("\n") } });
    return {
      out: r.stdout,
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
  });

  it("gives up after four attempts, 30, 60 and 90 s apart", () => {
    const r = runRegistry([TRANSIENT[0][1]]);
    expect(r.status).toBe(1);
    expect(r.calls).toBe(4);
    expect(r.sleeps).toEqual(["30", "60", "90"]);
    expect(r.out).toContain(FAIL_LINE);
  });
});
