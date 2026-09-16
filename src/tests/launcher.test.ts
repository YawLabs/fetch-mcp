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
type SandboxSetting = "on" | "off" | "unrecognised";
type ParseSandboxSetting = (value: string | undefined) => SandboxSetting;
type ParseRuntimeSetting = (value: string | undefined) => {
  mode: "auto" | "oam" | "node";
  recognised: boolean;
};

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

describe("launcher parseSandboxSetting()", () => {
  const parse = new Function(
    `${extract([/function parseSandboxSetting\(value\) \{[\s\S]*?\n\}/])}\nreturn parseSandboxSetting;`,
  )() as ParseSandboxSetting;

  it("enables on the common truthy spellings, case-insensitively and trimmed", () => {
    // A security opt-in that fails OPEN on `true` -- the natural spelling in a
    // JSON env block -- with nothing on stderr is a silent downgrade.
    for (const value of ["1", "true", "TRUE", "Yes", "on", " 1", "1 ", "\ton\n"]) {
      expect(parse(value), JSON.stringify(value)).toBe("on");
    }
  });

  it("disables on unset, empty, and the common falsy spellings", () => {
    for (const value of [undefined, "", "0", "false", "False", "no", "OFF", "  "]) {
      expect(parse(value), JSON.stringify(value)).toBe("off");
    }
  });

  it("reports anything else as unrecognised rather than guessing", () => {
    // Off is the safe reading of an unknown value; the launcher names it on
    // stderr so it is never a silent no-op either.
    for (const value of ["maybe", "01", "enable", "2", "yes please"]) {
      expect(parse(value), JSON.stringify(value)).toBe("unrecognised");
    }
  });
});

describe("launcher parseRuntimeSetting()", () => {
  const parse = new Function(
    `${extract([/function parseRuntimeSetting\(value\) \{[\s\S]*?\n\}/])}\nreturn parseRuntimeSetting;`,
  )() as ParseRuntimeSetting;

  it("reads auto / oam / node case-insensitively and trimmed, and defaults to auto", () => {
    // `"oam "` in a JSON env block used to fall through to auto in silence,
    // which turned the fail-closed pairing (sandbox + RUNTIME=oam) into a
    // fail-open one on a stray space.
    for (const [value, mode] of [
      [undefined, "auto"],
      ["", "auto"],
      ["  ", "auto"],
      ["oam", "oam"],
      ["OAM", "oam"],
      [" oam ", "oam"],
      ["Node", "node"],
      ["auto\n", "auto"],
    ] as const) {
      expect(parse(value), JSON.stringify(value)).toEqual({ mode, recognised: true });
    }
  });

  it("reports anything else as unrecognised, reading it as auto", () => {
    for (const value of ["oam.", "yes", "oam;node", "1", "nodejs"]) {
      expect(parse(value), JSON.stringify(value)).toEqual({ mode: "auto", recognised: false });
    }
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

/**
 * The `--import` preload every spawned launcher runs with: the argv[1] exit
 * marker, the optional oam pose, and any test-specific source appended.
 */
function preloadFor(hostOam: string | undefined, extraPreload: string): string[] {
  // Every run also reports, at exit, what the LAUNCHER process's argv[1] ended
  // up as. runInProcess points it at dist/index.js; a handoff leaves it on the
  // launcher. That is the only way to tell "served in-process" from "handed
  // off to a child that printed the same version".
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  return ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}\n${extraPreload}`)}`];
}

/**
 * Preload source that makes the launcher's FIRST spawn target a path that does
 * not exist, and lets every later spawn through. That is the shape of a chosen
 * oam that passed its `--version` probe and then could not be spawned (deleted
 * or replaced in between). The version probe uses execFileSync, not spawn, so
 * it is untouched.
 */
const FAIL_FIRST_SPAWN = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const realSpawn = childProcess.spawn;",
  "let failed = false;",
  "childProcess.spawn = function (cmd, args, opts) {",
  "  if (failed) return realSpawn.call(this, cmd, args, opts);",
  "  failed = true;",
  '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
  "};",
  "syncBuiltinESMExports();",
].join("\n");

/**
 * Preload source that reports every spawn's argv on stderr, as one
 * `SPAWN_ARGS=<json>` line, and lets the spawn through. This is how a test
 * sees the exact flags the launcher hands the runtime -- `--permission` and
 * where it sits relative to `run` -- rather than inferring them from the
 * child's exit code.
 */
const RECORD_SPAWN_ARGS = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  // The exit marker in preloadFor already imports `writeSync`; alias it here.
  'import { writeSync as writeStderr } from "node:fs";',
  "const realSpawn = childProcess.spawn;",
  "childProcess.spawn = function (cmd, args, opts) {",
  '  writeStderr(2, "SPAWN_ARGS=" + JSON.stringify(args) + "\\n");',
  "  return realSpawn.call(this, cmd, args, opts);",
  "};",
  "syncBuiltinESMExports();",
].join("\n");

/** The argv of the first spawn a RECORD_SPAWN_ARGS run reported, or null. */
function recordedSpawnArgs(run: { stderr: string }): string[] | null {
  const line = run.stderr.split("\n").find((l) => l.startsWith("SPAWN_ARGS="));
  return line ? JSON.parse(line.slice("SPAWN_ARGS=".length)) : null;
}

/**
 * Preload source that records the spawn argv like RECORD_SPAWN_ARGS and then
 * rewrites oam's `[...flags, "run", <entry>, "--", ...argv]` into the Node form
 * `[<entry>, ...argv]` before spawning. OAM_BIN is the Node running the suite,
 * so the "oam" the launcher chose is a Node that can actually SERVE: this is
 * how the suite exercises a successful sandboxed spawn end to end -- the
 * launcher's piped stdio, the MCP handshake through it, and the child's exit
 * mirrored -- without a real oam on the box. The recorded argv still shows
 * exactly what a real oam would have received.
 */
const SERVE_AS_OAM = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  'import { writeSync as writeStderr } from "node:fs";',
  "const realSpawn = childProcess.spawn;",
  "childProcess.spawn = function (cmd, args, opts) {",
  '  writeStderr(2, "SPAWN_ARGS=" + JSON.stringify(args) + "\\n");',
  '  writeStderr(2, "SPAWN_STDIO=" + JSON.stringify(opts && opts.stdio) + "\\n");',
  '  const run = args.indexOf("run");',
  '  const dashdash = args.indexOf("--");',
  "  const nodeArgs = run === -1 ? args : [args[run + 1], ...args.slice(dashdash + 1)];",
  "  return realSpawn.call(this, cmd, nodeArgs, opts);",
  "};",
  "syncBuiltinESMExports();",
].join("\n");

/** The `stdio` option of the first spawn a SERVE_AS_OAM run reported, or null. */
function recordedSpawnStdio(run: { stderr: string }): unknown {
  const line = run.stderr.split("\n").find((l) => l.startsWith("SPAWN_STDIO="));
  return line ? JSON.parse(line.slice("SPAWN_STDIO=".length)) : null;
}

/**
 * The version string a host has to claim for the Node running this suite to
 * pass as that host's own oam: hostOamCandidate probes `process.execPath
 * --version` and accepts it only when it agrees with `process.versions.oam`.
 * Posing "0.15.2" on a Node execPath is therefore NOT a candidate (Node says
 * v22.x), which keeps every other test's "nothing to spawn" premise intact;
 * posing Node's own version IS one.
 */
const NODE_AS_HOST_OAM = process.version.replace(/^v/, "");

type ServeSession = { answered: number[]; stderr: string; exitedOnItsOwn: boolean; code: number | null };

/**
 * Launch the REAL bin with no argument, so it serves MCP over stdio, and hold a
 * short session: `initialize`, then -- only once that is answered -- a
 * `tools/list`. Resolves with the ids answered and whether the launcher exited
 * before the session was ended here.
 *
 * `--version` cannot see two failures this exists for, because it prints and
 * exits before either shows up. A launcher killed a moment after it answered
 * the first request still passes `--version`, and so does a server whose stdin
 * stopped delivering after the first chunk. The second request, sent only after
 * the first answer, catches both.
 */
function serveLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string>,
  extraPreload = "",
): Promise<ServeSession> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...preloadFor(hostOam, extraPreload), LAUNCHER], {
      env: { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const answered: number[] = [];
    let buffered = "";
    let stderr = "";
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      child.kill();
    };
    // Well inside TIMEOUT_MS. A launcher that keeps running without answering
    // is reported by what it answered, not by a vitest timeout.
    const deadline = setTimeout(stop, 30_000);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    // The launcher may die with requests unsent; that EPIPE is the finding, not a crash.
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let id: unknown;
        try {
          id = JSON.parse(line).id;
        } catch {
          continue;
        }
        if (typeof id !== "number") continue;
        answered.push(id);
        if (id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (id === 2) {
          stop();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolvePromise({ answered, stderr, exitedOnItsOwn: !stopped, code });
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "launcher-test", version: "0.0.0" },
      },
    });
  });
}

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
function runLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string> = {},
  extraPreload = "",
): Promise<LauncherRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...preloadFor(hostOam, extraPreload), LAUNCHER, "--version"], {
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
const SANDBOX_DROPPED =
  /^fetch-mcp: FETCH_MCP_SANDBOX=\S+ was not applied -- .*so the server runs WITHOUT --permission\.$/m;
const SANDBOX_REMEDY =
  /^To apply it, install or update oam \(0\.15\.2 or newer\) from https:\/\/oamjs\.org or set OAM_BIN=\/path\/to\/oam; set FETCH_MCP_RUNTIME=oam to make this fatal instead\.$/m;

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

  it.skipIf(!buildAvailable)(
    "passes --permission to oam BEFORE `run`, with --allow-net but no other grant",
    async () => {
      // oam rejects `run --permission`, so where the flag sits is
      // load-bearing, and the only grant (--allow-net) is the documented
      // shape for a server whose only side effect is fetching caller-supplied
      // URLs. Read straight off the spawn.
      const run = await runLauncher(undefined, { FETCH_MCP_SANDBOX: "1" }, RECORD_SPAWN_ARGS);
      const args = recordedSpawnArgs(run);
      expect(args, `no spawn was recorded: ${JSON.stringify(run)}`).not.toBeNull();
      expect(args![0]).toBe("--permission");
      // The single grant sits between `--permission` and `run`. No `--allow-env`
      // (this server reads no env), no `--allow-net=...` (bare grants every
      // host, which is the right call for a fetch server -- see the header).
      expect(args!.slice(1, args!.indexOf("run"))).toEqual(["--allow-net"]);
      expect(args![args!.indexOf("run")]).toBe("run");
      expect(args![args!.indexOf("run") + 1]).toMatch(/dist[\\/]index\.js$/);
      expect(args!.slice(args!.indexOf("run") + 2)).toEqual(["--", "--version"]);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "accepts FETCH_MCP_SANDBOX=true as well as 1, and 0/false as off",
    async () => {
      // The parser is unit-tested above; this pins that the launcher actually
      // routes the env var through it. `true` is the natural spelling in a
      // JSON env block, and it used to fail OPEN with nothing on stderr.
      for (const value of ["true", "Yes"]) {
        const run = await runLauncher(undefined, { FETCH_MCP_SANDBOX: value }, RECORD_SPAWN_ARGS);
        const args = recordedSpawnArgs(run);
        expect(args, `no spawn was recorded: ${JSON.stringify(run)}`).not.toBeNull();
        expect(args![0], `FETCH_MCP_SANDBOX=${value}: ${JSON.stringify(args)}`).toBe("--permission");
        expect(run.stderr).not.toMatch(/^fetch-mcp: /m);
      }
      for (const value of ["0", "false"]) {
        const run = await runLauncher(undefined, { FETCH_MCP_SANDBOX: value }, RECORD_SPAWN_ARGS);
        const args = recordedSpawnArgs(run);
        expect(args, `no spawn was recorded: ${JSON.stringify(run)}`).not.toBeNull();
        expect(args![0], `FETCH_MCP_SANDBOX=${value}: ${JSON.stringify(args)}`).toBe("run");
        expect(run.stderr, "an explicit off is not news").not.toMatch(/^fetch-mcp: /m);
      }
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "names an unrecognised FETCH_MCP_SANDBOX value and runs without the sandbox",
    async () => {
      const run = await runLauncher(undefined, { FETCH_MCP_SANDBOX: "maybe" }, RECORD_SPAWN_ARGS);
      const args = recordedSpawnArgs(run);
      expect(args, `no spawn was recorded: ${JSON.stringify(run)}`).not.toBeNull();
      expect(args![0], `an unknown value must read as off: ${JSON.stringify(args)}`).toBe("run");
      // States the reading only: it is printed before the launcher knows whether
      // anything will serve, so it may not claim the server runs without the
      // sandbox (that claim would sit above every fatal exit).
      expect(run.stderr).toMatch(
        /^fetch-mcp: FETCH_MCP_SANDBOX=maybe is not recognised and is treated as off; set it to 1 to enable the sandbox or 0 to disable it\.$/m,
      );
      expect(run.stderr).not.toMatch(/WITHOUT --permission/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "names an unrecognised FETCH_MCP_RUNTIME value and treats it as auto",
    async () => {
      // A typo here used to fall through to auto in silence -- and under the
      // fail-closed pairing that turned "sandbox required" into "sandbox if
      // convenient" with nothing on stderr.
      const run = await runLauncher(undefined, { FETCH_MCP_RUNTIME: "oam;" }, RECORD_SPAWN_ARGS);
      expect(recordedSpawnArgs(run), `auto must still discover and spawn: ${JSON.stringify(run)}`).not.toBeNull();
      expect(run.stderr).toMatch(
        /^fetch-mcp: FETCH_MCP_RUNTIME=oam; is not recognised and is treated as auto; use auto, oam or node\.$/m,
      );
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "trims FETCH_MCP_RUNTIME, so a padded `oam` keeps the fail-closed pairing closed",
    async () => {
      const run = await runLauncher(
        undefined,
        isolated({ FETCH_MCP_SANDBOX: "1", FETCH_MCP_RUNTIME: "oam ", OAM_BIN: MISSING_OAM }),
      );
      expect(run.code, `a padded oam must still be oam: ${JSON.stringify(run)}`).toBe(1);
      expect(run.stdout.trim(), "nothing may be served").toBe("");
      expect(run.stderr).not.toMatch(/is not recognised/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "serves through a sandboxed spawn from an oam host: piped stdio, full handshake, --permission on the argv",
    async () => {
      // The primary new path, end to end: an at-floor oam host under the
      // sandbox spawns a fresh runtime with --permission before `run`, pipes
      // stdio into it (an oam host never inherits -- see ALREADY RUNNING ON
      // OAM), and the MCP session completes through the pipes. The child is
      // the Node running this suite, posing as oam; SERVE_AS_OAM records the
      // oam-shaped argv and translates it so Node can serve.
      const session = await serveLauncher("0.15.2", { FETCH_MCP_SANDBOX: "1" }, SERVE_AS_OAM);
      expect(session.answered, JSON.stringify(session)).toEqual([1, 2]);
      expect(session.exitedOnItsOwn, JSON.stringify(session)).toBe(false);
      const args = recordedSpawnArgs(session);
      expect(args, `no spawn was recorded: ${JSON.stringify(session)}`).not.toBeNull();
      expect(args![0], JSON.stringify(args)).toBe("--permission");
      // `run` is the launcher-shaped subcommand; it sits after any grant.
      const runIdx = args!.indexOf("run");
      expect(runIdx, JSON.stringify(args)).toBeGreaterThan(0);
      // Piped, not inherited: read straight off the spawn options, because a
      // Node posing as oam would complete the handshake either way and could
      // not tell the two apart.
      expect(recordedSpawnStdio(session), "an oam host must pipe, never inherit").toEqual(["pipe", "pipe", "pipe"]);
      // Applied, so nothing to say: the sandbox is silent on success, and no
      // launcher line may claim otherwise.
      expect(session.stderr).not.toMatch(/^fetch-mcp: /m);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "spawns a fresh copy of the host's OWN oam for the sandbox when nothing else is installed",
    async () => {
      // Yaw MCP launches this bin from an oam bundled inside the app -- not
      // on PATH, not in an installed location. That host must be able to
      // sandbox: its own binary is the one oam guaranteed to exist. The host
      // here is the suite's Node posing as an oam of Node's own version, so
      // the execPath probe agrees with the claimed version and it qualifies
      // as the candidate; OAM_BIN is missing and PATH holds no oam, so
      // nothing else could be chosen.
      const session = await serveLauncher(
        NODE_AS_HOST_OAM,
        isolated({ FETCH_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }),
        SERVE_AS_OAM,
      );
      expect(session.answered, JSON.stringify(session)).toEqual([1, 2]);
      const args = recordedSpawnArgs(session);
      expect(args, `no spawn was recorded: ${JSON.stringify(session)}`).not.toBeNull();
      expect(args![0], JSON.stringify(args)).toBe("--permission");
      // `run` is the launcher-shaped subcommand; it sits after any grant.
      expect(args!.indexOf("run"), JSON.stringify(args)).toBeGreaterThan(0);
      // The unusable OAM_BIN is still named, and the chosen binary is this one.
      expect(session.stderr).toMatch(/^fetch-mcp: OAM_BIN=.*does not exist; using .* \(oam \d+\.\d+\.\d+\)\.$/m);
      expect(session.stderr).not.toMatch(/runs WITHOUT --permission/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "does not mistake a host whose binary reports a different version for its own oam",
    async () => {
      // The guard that keeps the case above honest: a wrapper on execPath, or
      // a Node posing as "0.15.2", is not an oam that can spawn a sandboxed
      // child. With nothing else to spawn, that host falls back in-process
      // and says so.
      const run = await runLauncher(
        "0.15.2",
        isolated({ FETCH_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }),
        RECORD_SPAWN_ARGS,
      );
      expect(recordedSpawnArgs(run), `nothing may be spawned: ${JSON.stringify(run)}`).toBeNull();
      expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(SANDBOX_DROPPED);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "spawns with no --permission at all when the sandbox is not requested",
    async () => {
      const run = await runLauncher(undefined, {}, RECORD_SPAWN_ARGS);
      const args = recordedSpawnArgs(run);
      expect(args, `no spawn was recorded: ${JSON.stringify(run)}`).not.toBeNull();
      expect(args![0], `the sandbox must be opt-in: ${JSON.stringify(args)}`).toBe("run");
      expect(args!.includes("--permission")).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe("launcher with no usable oam", () => {
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
      // The OAM_BIN note names no target: Node has not been looked for at
      // that point, and the handoff line above names it once it has been
      // found.
      expect(run.stderr).toMatch(/^fetch-mcp: OAM_BIN=.*does not exist\.$/m);
      expect(run.stderr).not.toMatch(/does not exist; using Node instead/);
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
      expect(run.stderr).toMatch(
        /FETCH_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found, and FETCH_MCP_SANDBOX=\S+ needs one\./,
      );
      // The advice must not loop back: plain "use FETCH_MCP_RUNTIME=node"
      // would drop the sandbox the user just asked for without saying so.
      expect(run.stderr).toMatch(
        /or drop FETCH_MCP_SANDBOX=\S+ and use FETCH_MCP_RUNTIME=node \(Node cannot apply the sandbox\)\./,
      );
      // Fatal is fatal: nothing may claim the server runs without the sandbox.
      expect(run.stderr).not.toMatch(/runs WITHOUT --permission/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_RUNTIME=oam without the sandbox, the error still offers FETCH_MCP_RUNTIME=node plainly",
    async () => {
      const run = await runLauncher("0.9.0", isolated({ FETCH_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stderr).toMatch(
        /^fetch-mcp: FETCH_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found\.$/m,
      );
      expect(run.stderr).toMatch(/, or use FETCH_MCP_RUNTIME=node\.$/m);
      expect(run.stderr).not.toMatch(/SANDBOX/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1, a supported oam host with nothing to spawn serves in-process and says so",
    async () => {
      const run = await runLauncher("0.15.2", isolated({ FETCH_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(IN_LAUNCHER_PROCESS);
      expect(run.stderr).toMatch(/^fetch-mcp: OAM_BIN=.*does not exist; using this oam 0\.15\.2 process instead\.$/m);
      // The downgrade is never silent; the line explains itself on a host
      // that IS an oam ("fresh"), says how to get the sandbox applied, and
      // names the way to make its absence fatal.
      expect(run.stderr).toMatch(SANDBOX_DROPPED);
      expect(run.stderr).toMatch(/a fresh oam \(0\.15\.2 or newer\) is needed to apply it and none could be spawned/);
      expect(run.stderr).toMatch(SANDBOX_REMEDY);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1, a Node host with nothing to spawn serves in-process and says so",
    async () => {
      const run = await runLauncher(undefined, isolated({ FETCH_MCP_SANDBOX: "1", OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(IN_LAUNCHER_PROCESS);
      expect(run.stderr).toMatch(SANDBOX_DROPPED);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1 and FETCH_MCP_RUNTIME=node, serves on Node and says the sandbox is moot",
    async () => {
      const run = await runLauncher(undefined, isolated({ FETCH_MCP_SANDBOX: "1", FETCH_MCP_RUNTIME: "node" }));
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(run.stderr).toMatch(IN_LAUNCHER_PROCESS);
      expect(run.stderr).toMatch(SANDBOX_DROPPED);
      expect(run.stderr).toMatch(/FETCH_MCP_RUNTIME=node runs the server on Node/);
      // The next step for an explicit request to run on Node is to drop that
      // request, not to demand oam.
      expect(run.stderr).toMatch(/^Remove FETCH_MCP_RUNTIME=node to let the launcher use oam\.$/m);
      expect(run.stderr).not.toMatch(/make this fatal/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1, a fatal exit never claims the server runs without the sandbox",
    async () => {
      // The "runs WITHOUT --permission" line is printed only once a path is
      // committed to serving. Two ways to reach an exit that served nothing:
      // a below-floor oam host with no Node on PATH, under auto and under
      // FETCH_MCP_RUNTIME=node.
      const empty = isolated();
      const noNode = mkdtempSync(join(tmpdir(), "fetch-mcp-launcher-nopath-"));
      const envs: Record<string, string>[] = [{}, { FETCH_MCP_RUNTIME: "node" }];
      for (const extraEnv of envs) {
        const run = await runLauncher("0.9.0", {
          ...empty,
          ...extraEnv,
          PATH: noNode,
          OAM_BIN: join(noNode, "oam.exe"),
          FETCH_MCP_SANDBOX: "1",
        });
        expect(run.code, JSON.stringify(run)).toBe(1);
        expect(run.stdout.trim(), "nothing may be served").toBe("");
        expect(run.stderr).toMatch(/no Node was found on PATH/);
        expect(run.stderr, JSON.stringify(extraEnv)).not.toMatch(/runs WITHOUT --permission/);
      }
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_RUNTIME=node on an at-floor oam host with no Node, names the in-process remedy",
    async () => {
      // The "drop FETCH_MCP_RUNTIME=node, this oam can serve" hint fires only
      // on an at-floor oam host with no Node on PATH -- the one case where
      // RUNTIME=node is the ONLY obstacle to serving. A below-floor host
      // (covered above) cannot serve here, so the hint is empty.
      const noNode = mkdtempSync(join(tmpdir(), "fetch-mcp-launcher-nopath-"));
      const run = await runLauncher("0.15.2", {
        ...isolated(),
        PATH: noNode,
        OAM_BIN: join(noNode, "oam.exe"),
        FETCH_MCP_RUNTIME: "node",
      });
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may be served").toBe("");
      expect(run.stderr).toMatch(/no Node was found on PATH/);
      expect(run.stderr).toMatch(/or remove FETCH_MCP_RUNTIME=node to serve on this oam 0\.15\.2\./);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1 and FETCH_MCP_RUNTIME=oam on a Node host, the fatal still offers the loop-aware advice",
    async () => {
      // The at-floor oam host variant is covered above; this pins the same
      // advice on a Node host (no process.versions.oam). A regression that
      // interpolates the host version into the fatal line would show up here
      // as a syntax error or `undefined`.
      const noNode = mkdtempSync(join(tmpdir(), "fetch-mcp-launcher-nopath-"));
      const run = await runLauncher(undefined, {
        ...isolated(),
        PATH: noNode,
        OAM_BIN: join(noNode, "oam.exe"),
        FETCH_MCP_SANDBOX: "1",
        FETCH_MCP_RUNTIME: "oam",
      });
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may be served").toBe("");
      expect(run.stderr).toMatch(
        /FETCH_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found, and FETCH_MCP_SANDBOX=1 needs one\./,
      );
      expect(run.stderr).toMatch(
        /or drop FETCH_MCP_SANDBOX=1 and use FETCH_MCP_RUNTIME=node \(Node cannot apply the sandbox\)\./,
      );
      expect(run.stderr).not.toMatch(/runs WITHOUT --permission/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under an unrecognised sandbox value plus FETCH_MCP_RUNTIME=oam, the fatal offers the plain node advice",
    async () => {
      // "maybe" reads as off, so the loop-aware clause must NOT appear: there
      // is no sandbox to drop, and the plain RUNTIME=node remedy applies.
      // A regression that conditioned on the env value's text instead of
      // `sandbox.length` would leak the loop-aware text into the fatal line.
      const noNode = mkdtempSync(join(tmpdir(), "fetch-mcp-launcher-nopath-"));
      const run = await runLauncher("0.9.0", {
        ...isolated(),
        PATH: noNode,
        OAM_BIN: join(noNode, "oam.exe"),
        FETCH_MCP_SANDBOX: "maybe",
        FETCH_MCP_RUNTIME: "oam",
      });
      expect(run.code, JSON.stringify(run)).toBe(1);
      // The fatal line: the unrecognised-reading line above it is not what
      // we are pinning here, and it would naturally contain the literal
      // "FETCH_MCP_SANDBOX".
      const fatalLine = run.stderr
        .split("\n")
        .find((l) => l.startsWith("fetch-mcp: FETCH_MCP_RUNTIME=oam but no usable oam"));
      expect(fatalLine, JSON.stringify(run)).toBeDefined();
      expect(fatalLine, `fatal line must be the plain RUNTIME=oam opening: ${fatalLine}`).toMatch(
        /^fetch-mcp: FETCH_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found\.$/,
      );
      expect(fatalLine, `loop-aware text must not appear in the fatal: ${fatalLine}`).not.toMatch(
        /drop FETCH_MCP_SANDBOX/,
      );
      expect(fatalLine, `loop-aware text must not appear in the fatal: ${fatalLine}`).not.toMatch(/Node cannot apply/);
      // The remedy below the fatal: plain RUNTIME=node, no sandbox clause.
      expect(run.stderr).toMatch(/, or use FETCH_MCP_RUNTIME=node\.$/m);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "still falls back when the chosen oam fails to spawn on an oam host",
    async () => {
      // The chosen binary passed its --version probe and then could not be
      // spawned. A failed spawn emits 'error' and then 'close' with the negative
      // errno, and on an oam host the launcher waits for 'close' -- so an
      // unguarded close handler exited the launcher mid-fallback and nothing
      // served. OAM_BIN is the Node running this test, which clears the floor,
      // so it is the chosen "oam"; the preload sends that first spawn to a
      // missing path, and the Node handoff spawns normally.
      const run = await runLauncher("0.9.0", isolated({ OAM_BIN: process.execPath }), FAIL_FIRST_SPAWN);
      expect(run.code, JSON.stringify(run)).toBe(0);
      expect(run.stdout.trim(), "the Node fallback must still serve").toBe(PACKAGE_VERSION);
      // The "using X" suffix is omitted on the failed-to-launch line: this
      // host is below the floor, so fallback is a Node handoff, not in-process,
      // and the handoff line below names Node once it has been found. An
      // announcement here would have to either repeat Node's path (just in
      // case the handoff fails) or sit above "no Node was found on PATH" on
      // the failure case -- either way, it's the wrong place.
      expect(run.stderr).toMatch(/^fetch-mcp: failed to launch oam at .*\)\.$/m);
      expect(run.stderr).toMatch(
        /this process is oam 0\.9\.0, older than 0\.15\.2, and the newer oam would not start; running on .*node/,
      );
      expect(run.stderr).toMatch(IN_CHILD);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!buildAvailable)(
    "under FETCH_MCP_SANDBOX=1, a supported oam host keeps serving in-process when the chosen oam fails to spawn",
    async () => {
      // fetch-mcp's own fallback, which the case above cannot reach. The
      // sandbox sends a 0.15.2 host to discovery. When the spawn fails, the
      // documented fallback serves in THIS process, and it has to keep serving.
      // Before the fix it answered `initialize` and then either exited on the
      // dead child's 'close', or, with stdin already piped into that child,
      // stopped reading stdin. Both lose the second request.
      const session = await serveLauncher(
        "0.15.2",
        isolated({ FETCH_MCP_SANDBOX: "1", OAM_BIN: process.execPath }),
        FAIL_FIRST_SPAWN,
      );
      expect(session.answered, JSON.stringify(session)).toEqual([1, 2]);
      expect(session.exitedOnItsOwn, JSON.stringify(session)).toBe(false);
      expect(session.stderr).toMatch(/failed to launch oam at .*; using this oam 0\.15\.2 process instead\./);
    },
    TIMEOUT_MS,
  );
});
