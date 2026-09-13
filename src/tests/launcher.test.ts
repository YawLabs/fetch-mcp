import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const LAUNCHER = resolve(REPO_ROOT, "bin", "fetch-mcp.mjs");
const DIST_BIN = resolve(REPO_ROOT, "dist", "index.js");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")).version;

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined; sandbox: boolean }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match) throw new Error(`could not extract ${pattern} from bin/fetch-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const PARSE_VERSION_DECL = /function parseVersion\(text\) \{[\s\S]*?\n\}/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Making it importable would mean gating that body
 * behind an entry-point check -- a behaviour change to a shipped runtime
 * artifact whose failure mode (the guard reads false under an npm shim, and the
 * launcher silently does nothing) is worse than the gap this closes. This is
 * the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const pieces = extract([
    OAM_MIN_DECL,
    PARSE_VERSION_DECL,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

function loadFallbackInProcess(): (hostOam: string | undefined) => boolean {
  const pieces = extract([
    OAM_MIN_DECL,
    PARSE_VERSION_DECL,
    ATLEAST_DECL,
    /function fallbackInProcess\(hostOam\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn fallbackInProcess;`)() as (hostOam: string | undefined) => boolean;
}

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/fetch-mcp.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.15.2 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.15.2 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "0.16.0", "0.100.0", "1.0.0", "0.16.0-dev"]) {
        expect(runtimePlan({ mode, hostOam, sandbox: false }), `mode=${mode} hostOam=${hostOam}`).toBe("in-process");
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the user asked
    // for -- a security downgrade that no other symptom would reveal.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "0.15.2", "1.0.0"]) {
        expect(runtimePlan({ mode, hostOam, sandbox: true }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    // Below the floor the host must hand off. Serving there was the bug: an oam
    // older than 0.9.0 runs child_process arguments through a shell, and
    // anything older than the latest release is not what the server is
    // verified on.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "0.0.1"]) {
        for (const sandbox of [false, true]) {
          expect(runtimePlan({ mode, hostOam, sandbox }), `mode=${mode} hostOam=${hostOam} sandbox=${sandbox}`).toBe(
            "discover",
          );
        }
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        expect(runtimePlan({ mode, hostOam, sandbox: false }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("runs FETCH_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    // The sandbox is moot here: Node has no `--permission` to apply.
    for (const sandbox of [false, true]) {
      expect(runtimePlan({ mode: "node", hostOam: undefined, sandbox }), `sandbox=${sandbox}`).toBe("in-process");
      for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
        expect(runtimePlan({ mode: "node", hostOam, sandbox }), `hostOam=${hostOam} sandbox=${sandbox}`).toBe(
          "handoff-node",
        );
      }
    }
  });
});

describe("launcher pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    expect(floor).toEqual([0, 15, 2]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 15, 2]), at("path-a", [0, 16, 0]), at("path-b", [0, 15, 9])]);
    expect(chosen?.path).toBe("path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    expect(pickNewest([at("a", [0, 16, 0]), at("b", [0, 100, 0])])?.path).toBe("b");
    expect(pickNewest([at("first", [0, 15, 2]), at("second", [0, 15, 2])])?.path).toBe("first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    expect(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 15, 2])])?.path).toBe("good");
    expect(pickNewest([at("old", [0, 15, 1]), at("broken", null)])).toBeNull();
    expect(pickNewest([])).toBeNull();
  });
});

describe("launcher fallbackInProcess()", () => {
  const fallbackInProcess = loadFallbackInProcess();

  it("serves a fallback in-process on Node, and on an oam host at the floor", () => {
    // The oam case is the sandbox one: a host at the floor only reaches a
    // fallback because FETCH_MCP_SANDBOX=1 sent it to discovery.
    for (const hostOam of [undefined, "0.15.2", "1.0.0"]) {
      expect(fallbackInProcess(hostOam), `hostOam=${hostOam}`).toBe(true);
    }
  });

  it("never serves a fallback in-process on an oam host below the floor, or one with no readable version", () => {
    for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "", "dev"]) {
      expect(fallbackInProcess(hostOam), `hostOam=${hostOam}`).toBe(false);
    }
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

/**
 * Run the REAL bin under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key, and return what it wrote.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` and the sandbox
 * grant list -- which no amount of testing `runtimePlan` in isolation can. A
 * real oam cannot be assumed on every box this suite runs on, and the preload
 * changes exactly the one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `--version` reaches
 * dist/index.js and prints the package version with exit 0. On the discovery
 * path, the pinned Node answers `--version` with v20 or newer, which clears
 * the floor, so it is chosen and the launcher spawns `node [flags] run <entry>`
 * -- which has no `run` subcommand, prints no version and exits non-zero. A
 * usable OAM_BIN is taken before discovery runs, so a real oam on the
 * developer's box is never reached either.
 *
 * Env is a whitelist so a FETCH_MCP_* var exported by the developer's shell
 * cannot change what is being asserted.
 */
function runLauncher(hostOam: string | undefined, extraEnv: Record<string, string> = {}): Promise<LauncherRun> {
  // Every run also reports, at exit, what the LAUNCHER process's argv[1] ended
  // up as. runInProcess points it at dist/index.js; a handoff leaves it on the
  // launcher. That is the only way to tell "served in-process" from "handed
  // off to a child that printed the same version".
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  const preload = ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}`)}`];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...preload, LAUNCHER, "--version"], {
      env: { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

// The in-process path imports dist/index.js, so the spawn-based suites need a
// build. Skip rather than fail when a developer runs `vitest` directly without
// one, matching version.test.ts; release.sh always builds before `npm test`.
const buildAvailable = existsSync(DIST_BIN);
// Each case boots one to three Node processes, and a bare Node start was
// measured at ~11s on a contended Windows box (see version.test.ts).
const TIMEOUT_MS = 45_000;

const servedInProcess = (run: LauncherRun) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;
const IN_LAUNCHER_PROCESS = /LAUNCHER_ARGV1=.*dist[\\/]index\.js/;
const IN_CHILD = /LAUNCHER_ARGV1=.*fetch-mcp\.mjs/;

describe("launcher on an oam host", () => {
  it.skipIf(!buildAvailable)(
    "control: on plain Node the launcher still discovers and spawns",
    async () => {
      // Without this, the in-process cases below would also pass for a launcher
      // that ALWAYS runs in-process and never uses oam at all.
      const run = await runLauncher(undefined);
      expect(servedInProcess(run), `expected a spawn, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "serves in-process instead of spawning a nested oam",
    async () => {
      const envs: Record<string, string>[] = [{}, { FETCH_MCP_RUNTIME: "oam" }];
      for (const extraEnv of envs) {
        const run = await runLauncher("0.15.2", extraEnv);
        expect(servedInProcess(run), `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`).toBe(true);
        expect(run.stderr).toMatch(IN_LAUNCHER_PROCESS);
      }
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "still spawns under FETCH_MCP_SANDBOX=1, so --permission is not dropped",
    async () => {
      const run = await runLauncher("0.15.2", { FETCH_MCP_SANDBOX: "1" });
      expect(servedInProcess(run), `the sandbox must force a spawn, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
      // A spawned child failing, not the launcher diagnosing: every launcher
      // message starts with `fetch-mcp: `.
      expect(run.stderr).not.toMatch(/^fetch-mcp: /m);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "still discovers when the host oam is below the floor",
    async () => {
      const run = await runLauncher("0.15.1");
      expect(servedInProcess(run), `a below-floor host must not shortcut, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
      expect(run.stderr).not.toMatch(/^fetch-mcp: /m);
    },
    TIMEOUT_MS,
  );
});

describe("launcher with no usable oam", () => {
  /**
   * An environment with no oam anywhere: HOME and LOCALAPPDATA point at an
   * empty directory, so the installed locations are empty, and PATH holds only
   * the directory of the Node running this test. Keeps a real oam on the
   * developer's box out of reach.
   */
  function isolated(extra: Record<string, string> = {}): Record<string, string> {
    const empty = mkdtempSync(join(tmpdir(), "fetch-mcp-launcher-home-"));
    return {
      PATH: dirname(process.execPath),
      USERPROFILE: empty,
      HOME: empty,
      LOCALAPPDATA: empty,
      ...extra,
    };
  }
  const MISSING_OAM = join(tmpdir(), "no-such-dir", "oam.exe");

  it.skipIf(!buildAvailable)(
    "names an OAM_BIN that does not exist instead of falling back silently",
    async () => {
      const run = await runLauncher(undefined, isolated({ OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(/^fetch-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "hands a below-floor oam host off to Node rather than serving on it",
    async () => {
      const run = await runLauncher("0.9.0", isolated({ OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim(), "the Node child must still serve").toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(
        /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on .*node/,
      );
      // Served by the child, not in the launcher process: argv[1] was never
      // pointed at dist/index.js.
      expect(run.stderr).toMatch(IN_CHILD);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "refuses to serve on a below-floor oam host when there is no Node either",
    async () => {
      const noNode = mkdtempSync(join(tmpdir(), "fetch-mcp-launcher-nopath-"));
      const run = await runLauncher("0.9.0", { ...isolated(), PATH: noNode, OAM_BIN: join(noNode, "oam.exe") });
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may be served").toBe("");
      expect(run.stderr).toMatch(/no Node was found on PATH/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "hands FETCH_MCP_RUNTIME=node off to Node even on a supported oam host",
    async () => {
      const run = await runLauncher("0.15.2", isolated({ FETCH_MCP_RUNTIME: "node" }));
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(IN_CHILD);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1, a supported oam host with nothing to spawn serves in-process, as it always has",
    async () => {
      const run = await runLauncher("0.15.2", isolated({ FETCH_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(IN_LAUNCHER_PROCESS);
      expect(run.stderr).toMatch(/^fetch-mcp: OAM_BIN=.*does not exist; using this oam 0\.15\.2 process instead\.$/m);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1 and FETCH_MCP_RUNTIME=oam, nothing to spawn is fatal even on a supported oam host",
    async () => {
      const run = await runLauncher(
        "0.15.2",
        isolated({ FETCH_MCP_SANDBOX: "1", FETCH_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }),
      );
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may be served").toBe("");
      expect(run.stderr).toMatch(/FETCH_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found/);
    },
    TIMEOUT_MS,
  );
});
