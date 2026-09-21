import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALLOW_PRIVATE_HOSTS_ENV,
  allowPrivateHostsWarning,
  PRIVATE_HOSTS_DISABLED,
  parseAllowPrivateHostsSetting,
} from "../policy.js";
import { createFetchServer } from "../server.js";

// FETCH_MCP_ALLOW_PRIVATE_HOSTS: the operator gate on the per-call
// allow_private_hosts opt-in. The model is untrusted, so the flag it sets can
// only widen reach when whoever launched the server said so.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_BIN = resolve(__dirname, "..", "..", "dist", "index.js");
// Same convention as version.test.ts: skip rather than fail without a build;
// release.sh always builds before it tests.
const buildAvailable = existsSync(DIST_BIN);

describe("parseAllowPrivateHostsSetting", () => {
  it.each(["1", "true", "yes", "on", "TRUE", " On ", "yes\n"])("reads %j as on", (value) => {
    expect(parseAllowPrivateHostsSetting(value)).toBe("on");
  });

  it.each([undefined, "", "  ", "0", "false", "no", "off", "OFF", " false "])("reads %j as off", (value) => {
    expect(parseAllowPrivateHostsSetting(value)).toBe("off");
  });

  it.each(["maybe", "2", "enabled", "y", "1;", "tru e"])("reads %j as unrecognised (treated as off)", (value) => {
    expect(parseAllowPrivateHostsSetting(value)).toBe("unrecognised");
  });
});

describe("allowPrivateHostsWarning", () => {
  it("names an unrecognised value, trimmed, and says it is treated as off", () => {
    expect(allowPrivateHostsWarning(" maybe ")).toBe(
      `fetch-mcp: ${ALLOW_PRIVATE_HOSTS_ENV}=maybe is not recognised and is treated as off; ` +
        "set it to 1 to let tool calls opt into private hosts with allow_private_hosts, or 0 to refuse them.\n",
    );
  });

  it.each([undefined, "", "1", "true", "0", "off"])("says nothing for the accepted value %j", (value) => {
    expect(allowPrivateHostsWarning(value)).toBeNull();
  });
});

// A loopback fixture: reachable only when the opt-in is honoured.
let fixture: Server;
let fixtureUrl: string;

beforeAll(async () => {
  fixture = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("INTERNAL-ONLY");
  });
  await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", () => done()));
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((done) => fixture.close(() => done()));
});

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** Call a registered tool's handler directly, the way the integration suites do. */
async function callTool(server: ReturnType<typeof createFetchServer>, name: string, input: unknown) {
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (input: unknown, extra: { signal: AbortSignal }) => Promise<unknown> }
      >;
    }
  )._registeredTools;
  return (await tools[name]!.handler(input, { signal: new AbortController().signal })) as ToolResult;
}

describe("createFetchServer -- the gate at the tool boundary", () => {
  // One http_* tool and one content tool: both reach the network through
  // httpRequest, where the gate lives, so every tool gets it.
  it.each([
    "http_get",
    "fetch_html_to_text",
  ])("%s refuses allow_private_hosts: true by default (no operator opt-in)", async (tool) => {
    const out = await callTool(createFetchServer(), tool, { url: fixtureUrl, allow_private_hosts: true });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain(PRIVATE_HOSTS_DISABLED);
    expect(out.content[0]!.text).not.toContain("INTERNAL-ONLY");
  });

  it("honours allow_private_hosts: true when the operator opted in", async () => {
    const out = await callTool(createFetchServer({ allowPrivateHosts: true }), "http_get", {
      url: fixtureUrl,
      allow_private_hosts: true,
    });
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain("INTERNAL-ONLY");
  });

  it("keeps the guard on for a call that does not ask, even with the operator opt-in", async () => {
    const out = await callTool(createFetchServer({ allowPrivateHosts: true }), "http_get", { url: fixtureUrl });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/127\.0\.0\.1.*reserved/);
  });

  it("keeps each server's policy its own: servers created later neither open nor close it", async () => {
    // Through 0.7.1 the policy was module state, so the most recent
    // createFetchServer() decided for every server in the process: an embedder's
    // untrusted server opened up the moment a trusted one was created.
    const untrusted = createFetchServer();
    const trusted = createFetchServer({ allowPrivateHosts: true });
    const later = createFetchServer();
    const ask = { url: fixtureUrl, allow_private_hosts: true };

    expect((await callTool(untrusted, "http_get", ask)).content[0]!.text).toContain(PRIVATE_HOSTS_DISABLED);
    expect((await callTool(trusted, "http_get", ask)).content[0]!.text).toContain("INTERNAL-ONLY");
    expect((await callTool(later, "http_get", ask)).content[0]!.text).toContain(PRIVATE_HOSTS_DISABLED);
    // The plain server created after it did not close the trusted one either.
    expect((await callTool(trusted, "http_get", ask)).content[0]!.text).toContain("INTERNAL-ONLY");
  });

  it("tells the model about the gate in every tool's allow_private_hosts description", () => {
    const tools = (
      createFetchServer() as unknown as {
        _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, { description?: string }> } }>;
      }
    )._registeredTools;
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of names) {
      const description = tools[name]!.inputSchema?.shape?.allow_private_hosts?.description;
      expect(description, `${name} allow_private_hosts`).toContain(ALLOW_PRIVATE_HOSTS_ENV);
    }
  });
});

/** Start dist/index.js with `env`, drive initialize + one tools/call, return the result and stderr. */
async function runBuiltServer(env: Record<string, string | undefined>, args: Record<string, unknown>) {
  const childEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [DIST_BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (c: string) => {
    stderr += c;
  });
  try {
    const responses = new Map<number, unknown>();
    const waiters = new Map<number, (v: unknown) => void>();
    let buffered = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") {
          responses.set(msg.id, msg);
          waiters.get(msg.id)?.(msg);
        }
      }
    });
    const exited = new Promise<never>((_, reject) =>
      child.on("exit", (code) => reject(new Error(`server exited (${code}); stderr: ${stderr}`))),
    );
    // Only meaningful while a request is in flight; the kill() in finally must
    // not surface as an unhandled rejection after the test has passed.
    exited.catch(() => {});
    const request = (id: number, method: string, params: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const answered = new Promise((done) => {
        if (responses.has(id)) done(responses.get(id));
        else waiters.set(id, done);
      });
      return Promise.race([answered, exited]);
    };
    await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "policy-test", version: "0.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const call = (await request(2, "tools/call", { name: "http_get", arguments: args })) as {
      result: ToolResult;
    };
    return { result: call.result, stderr };
  } finally {
    child.kill();
  }
}

describe("startServer -- FETCH_MCP_ALLOW_PRIVATE_HOSTS end to end (built server)", () => {
  it.skipIf(!buildAvailable)("unset: the opt-in is refused and stderr is quiet", async () => {
    const { result, stderr } = await runBuiltServer(
      { [ALLOW_PRIVATE_HOSTS_ENV]: undefined },
      { url: fixtureUrl, allow_private_hosts: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(PRIVATE_HOSTS_DISABLED);
    expect(stderr).not.toContain(ALLOW_PRIVATE_HOSTS_ENV);
  });

  it.skipIf(!buildAvailable)("=1: the opt-in reaches the loopback fixture", async () => {
    const { result } = await runBuiltServer(
      { [ALLOW_PRIVATE_HOSTS_ENV]: "1" },
      { url: fixtureUrl, allow_private_hosts: true },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("INTERNAL-ONLY");
  });

  it.skipIf(!buildAvailable)("unrecognised value: named on stderr and treated as OFF (fails closed)", async () => {
    const { result, stderr } = await runBuiltServer(
      { [ALLOW_PRIVATE_HOSTS_ENV]: "maybe" },
      { url: fixtureUrl, allow_private_hosts: true },
    );
    expect(stderr).toContain(`${ALLOW_PRIVATE_HOSTS_ENV}=maybe is not recognised and is treated as off`);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(PRIVATE_HOSTS_DISABLED);
  });
});
