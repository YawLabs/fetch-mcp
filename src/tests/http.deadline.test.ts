import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Deadlines and cancellation (0.8.0).
//
// Through 0.7.1 `timeout_ms` bounded each HOP separately, the DNS lookup ran
// before the hop's timer started, retries slept through their Retry-After
// unconditionally, and nothing looked at the MCP request's cancellation. With
// the schema maxima one call could run for hours. Now `timeout_ms` bounds a
// whole attempt (DNS + every redirect hop + body), retries get a fresh
// budget, the call is capped at ABSOLUTE_MAX_TOTAL_MS, and `signal` stops the
// hop in flight, any retry wait, and every later attempt.

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

const { ABSOLUTE_MAX_TOTAL_MS, createRequester, setHttpContext } = await import("../http.js");

setHttpContext({ version: "test" });

// The fixture is loopback, so these go through a requester with the operator
// opt-in and set allowPrivateHosts per call -- literal 127.0.0.1, no DNS.
const request = createRequester({ allowPrivateHosts: true });

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base: string;
let handler: Handler = (_req, res) => res.end("ok");
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  hits = [];
  lookupMock.mockReset();
});

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

describe("timeout_ms bounds a whole attempt", () => {
  it("covers every hop of a redirect chain, not each hop separately", async () => {
    // Two hops of ~1000ms each: under 0.7.1 each fit a 1500ms per-hop timeout
    // and the chain took ~2000ms. Now the chain must fit the 1500ms together.
    // The margin that matters is the FIRST hop's (500ms of headroom): the
    // second hop must be reached for the test to prove anything, and a loaded
    // box only ever makes the chain longer, never shorter.
    handler = (req, res) => {
      if (req.url === "/a") later(1000, () => res.writeHead(302, { location: "/b" }).end());
      else later(1000, () => res.end("done"));
    };
    const t0 = Date.now();
    const res = await request({ method: "GET", url: `${base}/a`, allowPrivateHosts: true, timeoutMs: 1500 });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("request exceeded 1500ms");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(hits).toEqual(["/a", "/b"]);
  });

  it("still completes a chain that fits the budget", async () => {
    handler = (req, res) => {
      if (req.url === "/a") res.writeHead(302, { location: "/b" }).end();
      else res.end("done");
    };
    const res = await request({ method: "GET", url: `${base}/a`, allowPrivateHosts: true, timeoutMs: 5000 });

    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("done");
  });

  it("counts the DNS lookup against the budget (a resolver that never answers cannot stall the hop)", async () => {
    // Through 0.7.1 the lookup ran before the hop timer started, so it added
    // the OS resolver's full timeout to every hop.
    lookupMock.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    const res = await request({ method: "GET", url: "http://never-answers.example.com/", timeoutMs: 200 });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("request exceeded 200ms");
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("caps the whole call at five minutes", () => {
    // The schema maxima -- 6 attempts x 21 hops x 120s, plus Retry-After waits --
    // used to allow hours. The ceiling is what the per-attempt budget rolls up to.
    expect(ABSOLUTE_MAX_TOTAL_MS).toBe(300_000);
  });
});

describe("caller cancellation (the MCP request's signal)", () => {
  it("returns at once without dialing when the signal is already aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const res = await request({ method: "GET", url: `${base}/x`, allowPrivateHosts: true, signal: aborted.signal });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("request cancelled by the client");
    expect(hits).toEqual([]);
  });

  it("stops a hop in flight", async () => {
    handler = (_req, res) => later(3000, () => res.end("too late"));
    const cancel = new AbortController();
    later(100, () => cancel.abort());
    const t0 = Date.now();
    const res = await request({
      method: "GET",
      url: `${base}/slow`,
      allowPrivateHosts: true,
      timeoutMs: 10_000,
      signal: cancel.signal,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("request cancelled by the client");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("stops a DNS lookup in flight", async () => {
    lookupMock.mockImplementation(() => new Promise(() => {}));
    const cancel = new AbortController();
    later(100, () => cancel.abort());
    const res = await request({
      method: "GET",
      url: "http://never-answers.example.com/",
      timeoutMs: 10_000,
      signal: cancel.signal,
    });

    expect(res.error).toBe("request cancelled by the client");
  });

  it("stops a retry wait instead of sleeping through Retry-After", async () => {
    handler = (_req, res) => res.writeHead(503, { "retry-after": "30" }).end("busy");
    const cancel = new AbortController();
    later(150, () => cancel.abort());
    const t0 = Date.now();
    const res = await request({
      method: "GET",
      url: `${base}/busy`,
      allowPrivateHosts: true,
      retries: 2,
      signal: cancel.signal,
    });

    expect(res.error).toBe("request cancelled by the client");
    expect(Date.now() - t0).toBeLessThan(2000);
    // The first attempt ran; no second attempt started after the cancel.
    expect(hits).toEqual(["/busy"]);
  });

  it("leaves a request that is not cancelled alone", async () => {
    handler = (_req, res) => res.end("fine");
    const res = await request({
      method: "GET",
      url: `${base}/ok`,
      allowPrivateHosts: true,
      signal: new AbortController().signal,
    });

    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("fine");
  });
});

describe("every tool passes the MCP request's signal through", () => {
  // A tool that dropped `signal: extra.signal` would dial the fixture despite
  // the cancelled request. All 15 tools, so no single one can regress quietly.
  const TOOLS = [
    "http_get",
    "http_post",
    "http_put",
    "http_patch",
    "http_delete",
    "http_head",
    "http_options",
    "fetch_html_to_markdown",
    "fetch_html_to_text",
    "fetch_reader",
    "fetch_meta",
    "fetch_links",
    "fetch_feed",
    "fetch_robots",
    "fetch_sitemap",
  ];

  it.each(TOOLS)("%s makes no request once its tools/call is cancelled", async (name) => {
    const { createFetchServer } = await import("../server.js");
    handler = (_req, res) => res.end("<html></html>");
    const tools = (
      createFetchServer({ allowPrivateHosts: true }) as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown, extra: { signal: AbortSignal }) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools;
    expect(Object.keys(tools).sort()).toEqual([...TOOLS].sort());
    const cancelled = new AbortController();
    cancelled.abort();
    const out = await tools[name]!.handler(
      { url: `${base}/page`, allow_private_hosts: true },
      { signal: cancelled.signal },
    );

    expect(hits).toEqual([]);
    // fetch_sitemap just stops (nobody is waiting on a cancelled call); the
    // rest report the cancellation their one request came back with.
    if (name !== "fetch_sitemap") expect(out.content[0]!.text).toContain("request cancelled by the client");
  });
});

describe("tool handlers pass the MCP request's signal through", () => {
  it("a cancelled tools/call stops the request it started", async () => {
    const { createFetchServer } = await import("../server.js");
    handler = (_req, res) => later(3000, () => res.end("too late"));
    const tools = (
      createFetchServer({ allowPrivateHosts: true }) as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown, extra: { signal: AbortSignal }) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools;
    const cancel = new AbortController();
    later(100, () => cancel.abort());
    const t0 = Date.now();
    const out = await tools.fetch_html_to_text!.handler(
      { url: `${base}/slow`, allow_private_hosts: true },
      { signal: cancel.signal },
    );

    expect(out.content[0]!.text).toContain("request cancelled by the client");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
