#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/fetch-mcp.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * Node. It never serves on an oam older than the floor below.
 *
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a
 * plain `import()` of the server into THIS process: no extra spawn, no extra
 * startup, byte-identical to invoking dist/index.js directly. Finding the
 * candidates is stat-only, so a machine without oam never pays for a
 * subprocess.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first, every oam binary
 * found is asked for its version, and then oam boots to serve -- so the
 * launcher is slower than pointing a host at oam directly. Measured on
 * npmjs-mcp (windows-arm64, n=12 medians, spawn to first MCP initialize):
 * oam 116ms, node 172ms, launcher 243ms. It exists for `npx` convenience.
 *
 * For an MCP host config, point straight at oam and skip this file:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js"] }
 *
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- the oam THIS process runs on, if any (see
 * hostOamCandidate), then the installed locations, then PATH -- is asked for
 * its version, and the NEWEST one at or above the floor wins; a tie keeps
 * search order. Taking the first binary found instead let a stale copy early
 * in the search order hide a current one later: with oam 0.9.0 installed in
 * ~/.oam/bin and 0.15.2 on PATH, the launcher bound to 0.9.0 because installed
 * locations are searched first.
 *
 * An OAM_BIN that does not exist, is below the floor, or will not run is named
 * on stderr and discovery carries on. It used to stop everything: a typo in
 * OAM_BIN meant Node, with no hint why.
 *
 * Discovered binaries are quieter. The ones passed over, and an oam .cmd/.bat
 * shim on PATH, are named on stderr only when NO usable oam is found -- the
 * notes explain a fallback or a refusal. When a usable oam is found they are
 * not mentioned, while an unusable OAM_BIN is named either way.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does, and so does oam's sidecar
 * regression matrix. This launcher used to discover oam and spawn it anyway,
 * so one server cost two runtime boots: measured on Windows, oam.exe with a
 * NESTED oam.exe + conhost.exe underneath it. Now, when `process.versions.oam`
 * clears the same MINIMUM OAM VERSION a discovered binary has to, the server is
 * imported into THIS process exactly as the Node fallback is -- no discovery,
 * no `oam --version` probe, no second oam. OAM_BIN is a discovery input, so it
 * is not consulted on that path: the host has already chosen which oam runs.
 *
 * FETCH_MCP_SANDBOX=1 still takes the discovery path on such a host,
 * deliberately: `--permission` is a process-level flag that only a FRESH oam
 * can apply, so choosing in-process there would drop the sandbox without a
 * word -- a security downgrade dressed up as an optimisation.
 *
 * A host oam BELOW the floor never serves. It used to, whenever discovery came
 * up empty. It now hands the server off to the newest usable oam, or to Node
 * found on PATH, or exits with an error when there is neither.
 *
 * Every handoff from an oam host PIPES stdio rather than inheriting it. Before
 * 0.9.0 oam treated `stdio: 'inherit'` as `'pipe'`, so an inherited handoff
 * from such a host connects the child to pipes nobody reads: measured with a
 * real oam 0.8.2 host on aws-mcp's copy of this launcher, the MCP handshake
 * never answered. Piping the streams explicitly completes it, to both oam and
 * Node, and is equally correct from a current oam, so the rule does not depend
 * on the host's version. A Node host keeps `inherit`, which hands over the
 * same fds untouched.
 *
 * Discovery asks for a spawn; it does not guarantee one. If it finds no usable
 * oam, or the spawn itself fails, the default FETCH_MCP_RUNTIME=auto falls
 * back. A Node host runs the server in-process, and so does an oam host at the
 * floor -- which only reaches discovery for the sandbox -- so under
 * FETCH_MCP_SANDBOX=1 that fallback serves WITHOUT `--permission`. The
 * launcher says so on stderr rather than downgrading silently, and
 * FETCH_MCP_RUNTIME=oam makes a sandbox that cannot be applied fatal instead.
 * A host below the floor hands off to Node.
 *
 * THE `--permission` SANDBOX (opt-in)
 * `FETCH_MCP_SANDBOX=1` runs the server under oam's permission model.
 *
 * Net is granted in FULL here, and that is the right call rather than a cop-out:
 * fetching a caller-supplied URL is precisely this server's job, so restricting
 * by host would break the tool instead of hardening it. The value is in what
 * stays denied -- this server reads no file and spawns no process, so running it
 * without an fs or child grant turns both into a runtime refusal rather than a
 * capability it merely happens not to use today.
 *
 * It is opt-in because `--permission` is a behaviour change, and a server that
 * gains a legitimate need for either capability should fail in review, not in a
 * user's session.
 *
 * Request the sandbox through the environment variable, not by putting
 * `--permission` on the HOST command (`oam --permission run <this file>`):
 * under that host every process.env read is empty, so FETCH_MCP_SANDBOX,
 * FETCH_MCP_RUNTIME and OAM_BIN are all inert. The outcome is still safe --
 * the host's own sandbox covers the in-process server -- but nothing this
 * launcher is told applies.
 *
 * When the sandbox IS applied the launcher prints no line about it (it may
 * still mention an unusable OAM_BIN it passed over). Every path that serves
 * WITHOUT it after it was asked for prints a line that contains
 * `runs WITHOUT --permission`, plus how to get it applied. To make silence
 * mean success, pair it with FETCH_MCP_RUNTIME=oam, which turns an unapplied
 * sandbox into a startup failure. To confirm from a shell:
 *   FETCH_MCP_SANDBOX=1 FETCH_MCP_RUNTIME=oam fetch-mcp --version
 * The version on stdout, exit 0 and no `WITHOUT --permission` line means the
 * sandboxed oam served it.
 *
 * MINIMUM OAM VERSION
 * The latest oam release, 0.15.2 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is passed over for a
 * newer oam, or for Node. Below 0.9.0 `child_process.execFile` ran its
 * arguments through a SHELL, `exec` accepted `timeout` and ignored it,
 * `spawnSync` truncated at `maxBuffer` while reporting success, and
 * `stdio: 'inherit'`/`'ignore'` both behaved as `'pipe'`. The server itself
 * spawns nothing, so those could not reach it; the floor is about serving only
 * on the oam release every @yawlabs/*-mcp launcher is verified on. The
 * launcher's own handoff from an old oam host does meet the `inherit` bug,
 * which is why that handoff pipes.
 *
 * SELECTION
 *   FETCH_MCP_RUNTIME=auto   newest usable oam, else Node (default)
 *   FETCH_MCP_RUNTIME=oam    newest usable oam, else exit with an error
 *                            (already running on oam at the floor satisfies
 *                            it, unless FETCH_MCP_SANDBOX=1 needs a fresh one)
 *   FETCH_MCP_RUNTIME=node   Node: in THIS process on Node, handed off to Node
 *                            on PATH when THIS process is oam; never sandboxed
 *   FETCH_MCP_SANDBOX=1      spawn oam under --permission (see above); not
 *                            applied under FETCH_MCP_RUNTIME=node, and the
 *                            launcher says so
 *   OAM_BIN=/path/to/oam     use this oam when it is usable, before discovery
 * Both values are case-insensitive and trimmed. A runtime value other than
 * auto / oam / node is treated as auto and named on stderr. A sandbox value of
 * 1 / true / yes / on enables it, 0 / false / no / off (or unset) disables it,
 * and anything else is treated as off and named on stderr. Neither is ever a
 * silent no-op: the fail-closed pairing (sandbox on + RUNTIME=oam) must not
 * fall open on a typo.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The latest oam release, and the oldest one used. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 15, 2];

/**
 * MINIMUM NODE VERSION. The server's HTTP client is undici 8, whose own floor is
 * Node 22.19.0. Below it the failure is not a clean error: Node 20 dies at
 * import (`webidl.util.markAsUncloneable is not a function`), and Node 22 before
 * 22.15 has no `zlib.createZstdDecompress`, so the FIRST response that arrives
 * with `content-encoding: zstd` throws inside undici's stream and takes the
 * whole server down mid-session. Every path that serves on Node checks this
 * before it commits (and before any "runs WITHOUT --permission" note, which
 * must never sit above an exit that served nothing). oam is not subject to it:
 * it ships its own runtime. Keep in step with package.json `engines.node`.
 */
const NODE_MIN = [22, 19, 0];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess.
 *
 * Installed locations come BEFORE PATH, so when two binaries report the same
 * version the installed copy wins the tie. Someone who develops oam itself
 * usually has oam/target/release on PATH, and cargo replaces that binary
 * underneath running processes. Both forms are checked on Windows: the
 * installer defaults to %LOCALAPPDATA%\oam\bin there, but oam's docs name
 * ~/.oam/bin first and OAM_INSTALL_DIR can pick either.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would hand back a path this launcher cannot execute. A
 * skipped shim is named on stderr when no usable oam is found -- see
 * findOamShim.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` output ("oam 0.15.1") and the host's own
 * `process.versions.oam` ("0.15.1") -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** `node --version` of `cmd` -> [major, minor, patch], or null when it cannot be read. */
function nodeVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

/**
 * The stderr line for a Node below NODE_MIN, or null when `version` is at the
 * floor. `what` names the Node in question ("this process" or a path). An
 * unreadable version is not a refusal -- the launcher has nothing to compare --
 * so null there too; the server's own failure will name the problem.
 *
 * Pure on purpose, like runtimePlan.
 */
function nodeFloorProblem(version, what) {
  if (!version || atLeast(version, NODE_MIN)) return null;
  const floor = NODE_MIN.join(".");
  return (
    `fetch-mcp: ${what} is Node ${version.join(".")}, older than ${floor}; @yawlabs/fetch-mcp needs Node ${floor} or newer ` +
    "(the floor of its HTTP client, undici 8 -- an older Node crashes at import or on the first zstd-encoded response).\n" +
    "Install a newer Node, or install oam from https://oamjs.org and this launcher will use it.\n"
  );
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the server runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back (see fallBack)
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam and
 *                  FETCH_MCP_RUNTIME=node asked for Node
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam. `sandbox` is whether a spawn would carry flags
 * only a fresh oam can apply; see ALREADY RUNNING ON OAM above for why that
 * alone forces the discovery path, and why discovery can still end in-process
 * without those flags. Under `node` it is moot: Node has no `--permission` to
 * apply. The floor is OAM_MIN itself, not a parameter, so a host oam and a
 * discovered one can never be held to different minimums.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam, sandbox }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  if (sandbox) return "discover";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
}

/**
 * Whether a fallback may serve in THIS process: on Node, or on an oam host at
 * the floor. The only host at the floor that ever reaches a fallback is one
 * that took the discovery path for FETCH_MCP_SANDBOX=1, and it serves without
 * `--permission`, as it always has. A host below the floor never serves.
 *
 * Pure on purpose, like runtimePlan.
 */
function fallbackInProcess(hostOam) {
  return hostOam === undefined || atLeast(parseVersion(hostOam), OAM_MIN);
}

/**
 * How FETCH_MCP_SANDBOX reads: "on", "off", or "unrecognised" (set to
 * something that is neither). Case-insensitive, whitespace-trimmed, because a
 * security opt-in that fails OPEN on `true`, `Yes` or a trailing space -- with
 * nothing on stderr -- is the silent downgrade this launcher promises never to
 * make. An unrecognised value is treated as off AND named on stderr (see the
 * top-level `sandboxSetting` check below), never quietly honoured or quietly
 * ignored.
 *
 * Pure on purpose, like runtimePlan: the accepted spellings are testable
 * without booting anything.
 */
function parseSandboxSetting(value) {
  if (value === undefined) return "off";
  const v = value.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return "off";
  if (v === "1" || v === "true" || v === "yes" || v === "on") return "on";
  return "unrecognised";
}

/**
 * How FETCH_MCP_RUNTIME reads: `{ mode, recognised }`. Trimmed and
 * case-insensitive; anything but auto / oam / node is `auto` with
 * `recognised: false`, which the caller names on stderr. Silence here would
 * let the fail-closed pairing (sandbox on + RUNTIME=oam) fall open on
 * `"oam "` -- the same class of downgrade parseSandboxSetting exists to stop.
 *
 * Pure on purpose, like parseSandboxSetting.
 */
function parseRuntimeSetting(value) {
  const v = (value ?? "").trim().toLowerCase();
  // Unset and empty both mean the default, as they do for the sandbox value.
  const mode = v === "" ? "auto" : v;
  if (mode === "auto" || mode === "oam" || mode === "node") return { mode, recognised: true };
  return { mode: "auto", recognised: false };
}

/**
 * The `--permission` grant list, or [] when the sandbox is not requested.
 *
 * These are oam's PROCESS-level flags: they belong before the `run` subcommand,
 * not after it. `oam run --permission file.js` is rejected outright, which is a
 * good failure but only because it is loud -- ordering here is load-bearing.
 *
 * Net grants prefix-match `host` for fetch and `host:port` for sockets.
 * A denied environment variable is ABSENT from process.env rather than throwing,
 * so the env list below is derived from what the bundle actually reads; trimming
 * it produces silent misbehaviour, not a clear denial.
 */
function sandboxFlags(setting) {
  if (setting !== "on") return [];

  // Bare --allow-net grants every host. See the header for why that is correct
  // here rather than a cop-out.
  const netFlag = "--allow-net";

  // The server reads exactly one environment variable: the operator's
  // private-hosts opt-in (src/policy.ts). Grant that name and nothing else.
  // Without the grant the variable is ABSENT under `--permission`, so an
  // operator's FETCH_MCP_ALLOW_PRIVATE_HOSTS=1 would silently read as off --
  // safe, but the "silent misbehaviour" the header warns about. Keep this list
  // in step with every process.env read under src/.
  const envFlag = "--allow-env=FETCH_MCP_ALLOW_PRIVATE_HOSTS";
  return ["--permission", netFlag, envFlag];
}

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Looked for only when no usable oam was found, and then
 * reported rather than ignored, because "no oam binary was found" reads as
 * "install oam" -- the one thing that will not help. Windows only; there is no
 * such shim concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Why a candidate was passed over, for stderr. "Too old" and "could not be run"
 * stay distinct: a binary that is not executable, is the wrong arch, or printed
 * no parseable version is not outdated, and `oam self-update` will not fix it.
 */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * The oam THIS process runs on, as a spawn candidate -- or null on Node.
 *
 * A host that launches `oam run <this file>` from an oam that is not on PATH
 * and not in an installed location (Yaw MCP ships its own, inside the app)
 * is the most common way to reach discovery from an oam host at all: the
 * sandbox needs a fresh oam, and the one binary guaranteed to exist is the
 * host's own. Without this, such a host reported "no usable oam was found"
 * while being one.
 *
 * The binary must report the version the host says it is. A wrapper or shim
 * on execPath, or a Node posing as oam (this launcher's own tests preload
 * `process.versions.oam` onto Node), is not an oam that can spawn a child, and
 * the one `--version` probe tells them apart.
 */
function hostOamCandidate() {
  if (process.versions.oam === undefined) return null;
  const version = oamVersion(process.execPath);
  const claimed = parseVersion(process.versions.oam);
  if (!version || !claimed || version.join(".") !== claimed.join(".")) return null;
  return { path: process.execPath, version };
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable binary
 * among the host's own oam (first, so it wins ties) and discovery. Returns the
 * choice (or null) plus stderr notes: `overrideNote` about an unusable
 * OAM_BIN, and `skipped` describing what was found and rejected when nothing
 * was usable.
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) return { chosen: { path: override, version }, overrideNote, skipped: [] };
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
    }
  }
  const host = hostOamCandidate();
  const seen = new Set([override, host?.path].filter(Boolean).map(pathKey));
  const candidates = [
    ...(host ? [host] : []),
    ...discoverOamPaths()
      .filter((path) => !seen.has(pathKey(path)))
      .map((path) => ({ path, version: oamVersion(path) })),
  ];
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  return { chosen, overrideNote, skipped };
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // A server may gate its bootstrap on being the process ENTRY POINT --
  // `import.meta.url === pathToFileURL(process.argv[1]).href` -- so that its own
  // test file can import the module for unit tests without connecting a stdio
  // transport. aws-mcp does exactly this. Importing the server here would leave
  // argv[1] pointing at THIS launcher, the guard would read false, and the
  // server would load but never serve: the MCP handshake just hangs.
  //
  // Point argv[1] at the server first, so the in-process path is
  // indistinguishable from having executed the file directly. The spawn path
  // needs no equivalent -- there argv[1] is already the server.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

// ONE reporter for every failed in-process start, primary path or fallback.
// runInProcess() is a bare import() that rejects when dist/index.js is missing,
// and at ESM top level an unhandled rejection is an uncaught exception --
// replacing this launcher's diagnostic with a raw stack trace. Names the
// process it was starting in rather than "Node": under the sandbox an at-floor
// oam host falls back on itself.
const startFailed = (e) => {
  process.stderr.write(`fetch-mcp: could not start the server in ${fallbackTarget(hostOam)} (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * Spawn the server in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the server
 * on the same stdio.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // Every handoff from an oam host pipes; see ALREADY RUNNING ON OAM. That is a
  // host below the floor, one at the floor spawning a fresh oam for the
  // sandbox, or any oam under FETCH_MCP_RUNTIME=node.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path. Piping preserves both as well: bytes are copied
      // unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(startFailed);
    return;
  }

  // If the runtime cannot be executed at all (deleted between the version probe
  // and the spawn, wrong arch, permission), fall back rather than failing the
  // whole server. `spawned` prevents falling back AFTER the child started.
  //
  // Everything that assumes a live child waits for 'spawn'. A failed spawn
  // still emits 'close' (after 'error', with the negative errno as its code), so
  // an unguarded close handler would process.exit() out from under the fallback
  // onLaunchFailed has just started -- and stdin piped into a child that never
  // ran would swallow the host's first bytes before the fallback could read
  // them. Until 'spawn', process.stdin has no reader and simply stays paused.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
    if (piped) {
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    forwardSignals();
  });
  child.on("error", (err) => {
    if (spawned) return;
    onLaunchFailed(err).catch(startFailed);
  });
  // A child that exits before reading everything closes its stdin; the
  // resulting EPIPE is not worth crashing over.
  child.stdin?.on("error", () => {});

  // Forward termination so the server's own shutdown path runs in the child
  // rather than the child being orphaned.
  //
  // Registering ANY handler for these suppresses Node's default
  // terminate-on-signal, so the parent's exit has to be arranged explicitly.
  // `child.killed` only records that kill() was CALLED, never that the child
  // is gone, so gating on it swallows every signal after the first and wedges
  // the launcher with no escape hatch.
  //
  // Escalation is driven by a TIMER, not by counting signals. Counting is
  // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
  // apart, and a terminal Ctrl-C reaches the whole process group, so reading
  // "a second signal" as impatience hard-kills a child that is already
  // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
  // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
  // a wall-clock step cannot mis-gate the window either.
  //
  // POSIX vs Windows, and why we do NOT forward on Windows.
  // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
  // is what lets the child run its shutdown. On Windows there are no POSIX
  // signals: child.kill IGNORES the name and calls TerminateProcess -- an
  // immediate hard kill (verified: a child with a SIGTERM handler never runs
  // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
  // graceful shutdown the console's own Ctrl-C just started, skipping the
  // child's process.on("exit") cleanup. The console has already notified the
  // child, so on Windows the timer below is the only kill we issue.
  const ESCALATE_AFTER_MS = 2000;
  let escalation = null;
  function forwardSignals() {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        // No try/catch: kill() on an already-exited child returns false, it does
        // not throw. It throws only for a signal the platform does not know,
        // which SIGINT/SIGTERM/SIGKILL never are.
        if (!isWin) child.kill(sig);
        if (escalation) return; // already counting down; further signals are noise
        escalation = setTimeout(() => {
          // Still here after its grace window. Stop waiting on it.
          child.kill("SIGKILL");
          process.exit(128 + (constants.signals[sig] ?? 15));
        }, ESCALATE_AFTER_MS);
      });
    }
  }

  // Piped: wait for 'close', so the child's last stdout bytes are copied out
  // before this process exits. Inherited: 'exit' is enough, the fds were never
  // ours to drain. Either way, only for a child that actually ran -- see the
  // 'spawn' handler above.
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (!spawned) return;
    if (escalation) clearTimeout(escalation);
    // Mirror the child's fate: a signal death becomes 128+n so callers see a
    // conventional shell exit status rather than a bare 0.
    if (signal) {
      process.exit(128 + (constants.signals[signal] ?? 15));
    }
    process.exit(code ?? 0);
  });
}

/**
 * Hand the server to Node on PATH. Only reachable when THIS process is oam --
 * one below the floor, or any oam under FETCH_MCP_RUNTIME=node -- so there is
 * no in-process option left. `reason` is printed before the handoff; empty
 * means Node was asked for, which is not news. `sandboxWhy`, when the sandbox
 * was requested, is printed only once Node has been found: a line saying the
 * server runs without `--permission` must not precede an exit that served
 * nothing.
 */
async function handOffToNode(reason, sandboxWhy) {
  const node = findNodeOnPath();
  if (!node) {
    // On an oam at the floor under FETCH_MCP_RUNTIME=node, the only obstacle
    // to serving is that setting: THIS process could serve. Say so.
    const onUsableOam = atLeast(parseVersion(process.versions.oam), OAM_MIN);
    const serveHere = onUsableOam
      ? `, or remove FETCH_MCP_RUNTIME=node to serve on this oam ${process.versions.oam}`
      : "";
    const remedy =
      mode === "node"
        ? `Put Node on PATH, launch this command with node${serveHere}.\n`
        : `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`;
    const what = reason || `FETCH_MCP_RUNTIME=node on oam ${process.versions.oam ?? "this process"}`;
    await errSync(`fetch-mcp: ${what}, and no Node was found on PATH to run the server.\n${remedy}`);
    process.exit(1);
  }
  // Before the "running on Node instead" and sandbox notes: a refusal must not
  // sit under lines that say the server is about to serve.
  const tooOld = nodeFloorProblem(nodeVersion(node), node);
  if (tooOld) {
    await errSync(tooOld);
    process.exit(1);
  }
  if (reason) await errSync(`fetch-mcp: ${reason}; running on ${node} instead.\n`);
  await noteSandboxNotApplied(sandboxWhy);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`fetch-mcp: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

/** What a fallback serves on, for stderr. */
function fallbackTarget(hostOam) {
  return hostOam !== undefined && fallbackInProcess(hostOam) ? `this oam ${hostOam} process` : "Node";
}

/**
 * The "; using X instead" suffix for a fallback announcement -- only when the
 * fallback serves in THIS process, which cannot fail to be found. A handoff to
 * Node has not looked for Node yet; handOffToNode names it once it has, so an
 * announcement here cannot sit above "no Node was found on PATH". Likewise a
 * Node host below NODE_MIN: refuseOldNodeInProcess is about to exit, so the
 * announcement must not promise a server it will not start.
 */
function fallbackSuffix(hostOam) {
  if (!fallbackInProcess(hostOam)) return "";
  if (hostOam === undefined && nodeFloorProblem(parseVersion(process.versions.node), "this process")) return "";
  return `; using ${fallbackTarget(hostOam)} instead`;
}

/**
 * The one line that keeps a dropped sandbox from being silent. Printed on every
 * path that serves without `--permission` after it was asked for -- a fallback
 * (nothing usable to spawn, or the spawn failed), and FETCH_MCP_RUNTIME=node,
 * where there is no oam to apply it -- and printed only once that path is
 * committed to serving, so it never sits next to an exit that served nothing.
 * `why` is a clause; the line names the consequence, how to get the sandbox
 * applied, and how to make its absence fatal instead.
 */
async function noteSandboxNotApplied(why) {
  if (sandbox.length === 0) return;
  const remedy =
    mode === "node"
      ? "Remove FETCH_MCP_RUNTIME=node to let the launcher use oam.\n"
      : `To apply it, install or update oam (${OAM_MIN.join(".")} or newer) from https://oamjs.org or set ` +
        "OAM_BIN=/path/to/oam; set FETCH_MCP_RUNTIME=oam to make this fatal instead.\n";
  await errSync(
    `fetch-mcp: ${sandboxAsSet} was not applied -- ${why}, so the server runs WITHOUT --permission.\n${remedy}`,
  );
}

/**
 * On a Node host, exit before serving in THIS process when it is below
 * NODE_MIN. An oam host is exempt: oam runs on its own runtime.
 */
async function refuseOldNodeInProcess(hostOam) {
  if (hostOam !== undefined) return;
  const tooOld = nodeFloorProblem(parseVersion(process.versions.node), "this process");
  if (!tooOld) return;
  await errSync(tooOld);
  process.exit(1);
}

/**
 * No usable oam, or it would not start, under a mode that allows a fallback.
 * `why` finishes the below-floor handoff note, so it can say which of the two
 * happened.
 */
async function fallBack(hostOam, why) {
  // "fresh" is the word that makes this line make sense on a host that IS an
  // oam at the floor: it just said "using this oam 0.15.2 process", and only a
  // freshly spawned oam can apply a process-level flag.
  const sandboxWhy = `a fresh oam (${OAM_MIN.join(".")} or newer) is needed to apply it and none could be spawned`;
  if (fallbackInProcess(hostOam)) {
    await refuseOldNodeInProcess(hostOam);
    await noteSandboxNotApplied(sandboxWhy);
    await runInProcess();
    return;
  }
  await handOffToNode(`this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}, and ${why}`, sandboxWhy);
}

const runtimeSetting = parseRuntimeSetting(process.env.FETCH_MCP_RUNTIME);
const mode = runtimeSetting.mode;
const hostOam = process.versions.oam;

// The sandbox is read off the grant list rather than FETCH_MCP_SANDBOX, so
// "would the spawn carry --permission" cannot drift from what the spawn below
// actually passes.
const sandboxSetting = parseSandboxSetting(process.env.FETCH_MCP_SANDBOX);
const sandbox = sandboxFlags(sandboxSetting);
// The value as the user wrote it (trimmed: an accepted "1 " should not print
// as a double space), so every line about it matches their config.
const sandboxAsSet = `FETCH_MCP_SANDBOX=${(process.env.FETCH_MCP_SANDBOX ?? "").trim()}`;

// Both settings: set to something, but nothing this launcher understands.
// The safe reading of an unknown value is the default (auto; sandbox off) --
// honouring a guess could sandbox a server whose operator meant to switch the
// sandbox off -- but the default must never be silent. These lines describe
// the READING only; whether the server then serves is not known yet, so they
// make no claim about it.
if (!runtimeSetting.recognised) {
  await errSync(
    `fetch-mcp: FETCH_MCP_RUNTIME=${(process.env.FETCH_MCP_RUNTIME ?? "").trim()} is not recognised ` +
      "and is treated as auto; use auto, oam or node.\n",
  );
}
if (sandboxSetting === "unrecognised") {
  await errSync(
    `fetch-mcp: ${sandboxAsSet} is not recognised and is treated as off; ` +
      "set it to 1 to enable the sandbox or 0 to disable it.\n",
  );
}
const plan = runtimePlan({ mode, hostOam, sandbox: sandbox.length > 0 });

// Only FETCH_MCP_RUNTIME=node reaches either non-discovery plan with the
// sandbox requested; a sandboxed `auto` or `oam` always discovers.
const SANDBOX_MOOT_ON_NODE = "FETCH_MCP_RUNTIME=node runs the server on Node, which has no oam sandbox";

if (plan === "in-process") {
  await refuseOldNodeInProcess(hostOam);
  await noteSandboxNotApplied(SANDBOX_MOOT_ON_NODE);
  await runInProcess().catch(startFailed);
} else if (plan === "handoff-node") {
  const belowFloor = !atLeast(parseVersion(hostOam), OAM_MIN);
  await handOffToNode(
    belowFloor ? `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}` : "",
    SANDBOX_MOOT_ON_NODE,
  );
} else {
  const { chosen, overrideNote, skipped } = chooseOam();

  if (chosen) {
    if (overrideNote) {
      await errSync(`fetch-mcp: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    }
    // The sandbox flags go BEFORE `run` (see sandboxFlags), and `--` separates
    // oam's own flags from the script's argv, so `fetch-mcp --version` and any
    // host-supplied flags survive the hop unchanged.
    await launchChild(chosen.path, [...sandbox, "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], async (err) => {
      if (mode === "oam") {
        await errSync(`fetch-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err})\n`);
        process.exit(1);
      }
      await errSync(
        `fetch-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err})${fallbackSuffix(hostOam)}.\n`,
      );
      await fallBack(hostOam, "the newer oam would not start");
    });
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [
            `found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`,
          ]
        : []),
    ];
    if (mode === "oam") {
      // With the sandbox requested, "use FETCH_MCP_RUNTIME=node" is not a
      // remedy but a trade: Node cannot apply it. Say so, or the advice loops
      // -- the fallback note sends people to RUNTIME=oam, and this error would
      // send them straight back.
      const nodeOption =
        sandbox.length > 0
          ? `or drop ${sandboxAsSet} and use FETCH_MCP_RUNTIME=node (Node cannot apply the sandbox)`
          : "or use FETCH_MCP_RUNTIME=node";
      await errSync(
        `fetch-mcp: FETCH_MCP_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found` +
          `${sandbox.length > 0 ? `, and ${sandboxAsSet} needs one` : ""}.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          `Install or update from https://oamjs.org, set OAM_BIN=/path/to/oam, ${nodeOption}.\n`,
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong or their oam is too old to use.
    if (notes.length > 0) {
      await errSync(`fetch-mcp: ${notes.join("; ")}${fallbackSuffix(hostOam)}.\n`);
    }
    await fallBack(hostOam, "no newer oam was found").catch(startFailed);
  }
}
