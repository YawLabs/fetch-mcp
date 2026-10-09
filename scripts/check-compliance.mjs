#!/usr/bin/env node
/**
 * Grade the built launcher with @yawlabs/mcp-compliance, the suite Yaw MCP
 * grades every server with (`yaw-mcp audit`; a grade below
 * YAW_MCP_MIN_COMPLIANCE refuses the server's spawns). The devDependency is
 * pinned to the same version line Yaw MCP uses -- keep them in step.
 *
 * Exit codes, which release.sh maps to fail / warn:
 *   0  graded A, no required test failed
 *   1  graded below A, or a required test failed -- a release blocker
 *   2  the suite could not run or produced no grade (not installed, the
 *      server would not start, unparseable output) -- release.sh WARNS: the
 *      release was not graded, and it says so rather than passing silently
 *
 * Skipped tests (capabilities the server does not offer: resources, prompts)
 * are counted and printed, never hidden.
 *
 * Usage: node scripts/check-compliance.mjs        (after npm run build)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_GRADE = "A";
const PKG = join(REPO_ROOT, "node_modules", "@yawlabs", "mcp-compliance", "package.json");

if (!existsSync(PKG)) {
  console.error("mcp-compliance: @yawlabs/mcp-compliance is not installed (run npm ci) -- NOT graded");
  process.exit(2);
}
if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) {
  console.error("mcp-compliance: dist/index.js is missing (run npm run build) -- NOT graded");
  process.exit(2);
}

// The CLI's own entry, run on this Node: no .cmd shim, so no shell, so a path
// with spaces (C:\Program Files\nodejs) survives.
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const entry = join(dirname(PKG), typeof pkg.bin === "string" ? pkg.bin : pkg.bin["mcp-compliance"]);
const launcher = join(REPO_ROOT, "bin", "fetch-mcp.mjs");
const r = spawnSync(
  process.execPath,
  [entry, "test", "--format", "json", "--min-grade", MIN_GRADE, "--", process.execPath, launcher],
  {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  },
);

let report;
try {
  report = JSON.parse(r.stdout ?? "");
} catch {
  console.error(
    `mcp-compliance: no JSON report (exit ${r.status ?? r.signal ?? r.error?.message}) -- NOT graded\n${(r.stderr ?? "").slice(-2000)}`,
  );
  process.exit(2);
}

const s = report.summary ?? {};
console.log(
  `mcp-compliance ${report.toolVersion ?? "?"} (spec ${report.specVersion ?? "?"}): grade ${report.grade} ` +
    `(score ${report.score}), ${s.passed}/${s.total} passed, ${s.requiredPassed}/${s.required} required, ${s.skipped ?? 0} skipped`,
);
for (const w of report.warnings ?? []) console.log(`  warning: ${w}`);

const failedRequired = (report.tests ?? []).filter((t) => t.required && !t.passed);
for (const t of failedRequired) console.error(`  required test failed: ${t.id} -- ${t.details ?? ""}`);
if (typeof report.grade !== "string") {
  console.error("mcp-compliance: the report carries no grade -- NOT graded");
  process.exit(2);
}
if (report.grade > MIN_GRADE || failedRequired.length > 0) {
  console.error(`mcp-compliance: grade ${report.grade} is below ${MIN_GRADE}, or a required test failed`);
  process.exit(1);
}
process.exit(0);
