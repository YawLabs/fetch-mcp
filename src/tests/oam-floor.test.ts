import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Ported from aws-mcp's src/oam-floor.test.ts. The subject lives in scripts/,
// which tsconfig does not include, so it is run as a child process.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-oam-floor.mjs");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A synthetic repo carrying only the files the checker reads. */
function fixture(files: { launcher?: string; readme?: string; claude?: string; launcherTest?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "fetch-mcp-floor-"));
  dirs.push(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "tests"), { recursive: true });
  writeFileSync(join(root, "bin", "fetch-mcp.mjs"), files.launcher ?? "const OAM_MIN = [0, 18, 0];\n");
  if (files.readme !== undefined) writeFileSync(join(root, "README.md"), files.readme);
  if (files.claude !== undefined) writeFileSync(join(root, "CLAUDE.md"), files.claude);
  writeFileSync(
    join(root, "src", "tests", "launcher.test.ts"),
    files.launcherTest ?? "    expect(floor).toEqual([0, 18, 0]);\n",
  );
  return root;
}

/** Offline on purpose: these cases are about drift, and a unit test must not
 *  depend on GitHub being reachable. release.sh runs the online half. */
function runChecker(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CHECKER, "--offline", "--root", root], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const TIMEOUT_MS = 60_000;

describe("the oam floor is consistent across this repo", () => {
  // The half of the staleness check that needs no network runs on every
  // `npm test`, which is what makes it gate a release: release.sh runs the suite.
  it(
    "the real repo agrees with itself",
    () => {
      const r = runChecker(REPO_ROOT);
      expect(r.code, `check-oam-floor reported drift in this repo:\n${r.out}`).toBe(0);
      expect(r.out).toMatch(/no drift/);
    },
    TIMEOUT_MS,
  );
});

describe("check-oam-floor catches drift", () => {
  // A checker with no test that it FAILS is worse than none.
  it(
    "flags CLAUDE.md still claiming the previous floor",
    () => {
      const root = fixture({ claude: "Line one.\n\nThe launcher prefers an oam at or above `OAM_MIN` (0.17.1).\n" });
      const r = runChecker(root);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/DRIFT/);
      expect(r.out, "the message must name the file and line").toMatch(/CLAUDE\.md:3/);
      expect(r.out, "and the version it found").toMatch(/0\.17\.1/);
    },
    TIMEOUT_MS,
  );

  it(
    "flags a launcher test still pinning the previous floor",
    () => {
      const root = fixture({ launcherTest: "    expect(floor).toEqual([0, 17, 1]);\n" });
      const r = runChecker(root);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/pins the floor at 0\.17\.1, but OAM_MIN is 0\.18\.0/);
    },
    TIMEOUT_MS,
  );

  it(
    "flags the floor pin being deleted",
    () => {
      const root = fixture({ launcherTest: "    // the floor assertion was deleted\n" });
      const r = runChecker(root);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/no longer pins the floor/);
    },
    TIMEOUT_MS,
  );

  it(
    "flags a stale floor left in the launcher's own diagnostics",
    () => {
      const root = fixture({
        launcher: "const OAM_MIN = [0, 18, 0];\n// Run `oam self-update` to get oam 0.17.1 or newer.\n",
      });
      const r = runChecker(root);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/bin\/fetch-mcp\.mjs:2 +says 0\.17\.1/);
    },
    TIMEOUT_MS,
  );

  it(
    "does NOT flag a host version beside the floor, the Node floor, or a line about the past",
    () => {
      const root = fixture({
        launcherTest:
          "    expect(floor).toEqual([0, 18, 0]);\n" +
          "      /this process is oam 0\\.9\\.0, older than 0\\.18\\.0, and no newer oam was found/,\n",
        readme: "Requires Node 22.19.0 or newer when running on Node.\n",
        claude: "An aborted fetch left its socket open on oam 0.16.3 and 0.17.0; closed on 0.18.0, the floor.\n",
      });
      const r = runChecker(root);
      expect(r.code, r.out).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "fails loudly when OAM_MIN cannot be found at all",
    () => {
      const root = fixture({ launcher: "// somebody renamed the constant\n" });
      const r = runChecker(root);
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/OAM_MIN/);
    },
    TIMEOUT_MS,
  );
});
