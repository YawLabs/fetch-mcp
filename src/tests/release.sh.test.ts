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

describe("changelog_prev_tag", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "clprev-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a"), "a");
    execFileSync("git", ["add", "a"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "a"], { cwd: repo });
  });

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
