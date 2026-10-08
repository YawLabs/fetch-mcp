import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRequester,
  jsonAutoParseAllowed,
  MAX_JSON_AUTOPARSE_CHARS,
  MAX_JSON_AUTOPARSE_CONTAINERS,
  MAX_JSON_AUTOPARSE_DEPTH,
  setHttpContext,
} from "../http.js";

// The JSON auto-parse (Launch-critical #4) runs only on application/json or
// +json, and only on a body the linear pre-scan admits: JSON.parse is one
// synchronous call whose cost follows the container count, so an
// attacker-chosen `[[[...]]]` stalled the stdio server for seconds and, at the
// 100 MiB byte cap, would have run it out of memory.

setHttpContext({ version: "test" });
const httpRequest = createRequester({ allowPrivateHosts: true });

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;
let handler: Handler;

beforeAll(async () => {
  server = createHttpServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function serve(body: string, contentType = "application/json") {
  handler = (_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", contentType);
    res.end(body);
  };
}

const nest = (n: number) => "[".repeat(n) + "]".repeat(n);

describe("jsonAutoParseAllowed", () => {
  it("admits nesting up to the depth limit and refuses one past it", () => {
    expect(jsonAutoParseAllowed(nest(MAX_JSON_AUTOPARSE_DEPTH))).toBe(true);
    expect(jsonAutoParseAllowed(nest(MAX_JSON_AUTOPARSE_DEPTH + 1))).toBe(false);
    const objs = (n: number) => '{"a":'.repeat(n - 1) + "{}" + "}".repeat(n - 1);
    expect(jsonAutoParseAllowed(objs(MAX_JSON_AUTOPARSE_DEPTH))).toBe(true);
    expect(jsonAutoParseAllowed(objs(MAX_JSON_AUTOPARSE_DEPTH + 1))).toBe(false);
  });

  it("ignores brackets inside strings, including after escaped quotes", () => {
    const inString = JSON.stringify({ s: nest(5_000) });
    expect(jsonAutoParseAllowed(inString)).toBe(true);
    // `\"` must not end the string: the brackets after it are still string content.
    const escaped = JSON.stringify([`a"${"[".repeat(5_000)}`]);
    expect(escaped).toContain('\\"[[[');
    expect(jsonAutoParseAllowed(escaped)).toBe(true);
    // An escaped backslash before the closing quote does end the string.
    const backslash = `["x\\\\", ${nest(MAX_JSON_AUTOPARSE_DEPTH + 1)}]`;
    expect(jsonAutoParseAllowed(backslash)).toBe(false);
  });

  it("refuses more containers than the cap even when shallow", () => {
    const at = `[${Array(MAX_JSON_AUTOPARSE_CONTAINERS - 1)
      .fill("[]")
      .join(",")}]`;
    expect(jsonAutoParseAllowed(at)).toBe(true);
    expect(jsonAutoParseAllowed(`[${at}]`)).toBe(false);
  });

  it("refuses a body longer than the size threshold without scanning it", () => {
    expect(jsonAutoParseAllowed(" ".repeat(MAX_JSON_AUTOPARSE_CHARS))).toBe(true);
    expect(jsonAutoParseAllowed(" ".repeat(MAX_JSON_AUTOPARSE_CHARS + 1))).toBe(false);
  });
});

describe("httpRequest -- bounded JSON auto-parse", () => {
  it("skips the parse of a deeply nested 8 MiB body quickly and keeps the raw text", async () => {
    const body = nest(4 * 1024 * 1024);
    serve(body);
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true, maxBytes: 16 * 1024 * 1024 });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.json).toBeUndefined();
    expect(res.bodyText?.length).toBe(body.length);
    // JSON.parse on this body took ~3.5 s and ~600 MB; the scan is a few ms.
    expect(elapsed).toBeLessThan(2_000);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(200 * 1024 * 1024);
  });

  it("still parses a normal ~10 MiB array of objects", async () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({
      id: i,
      name: `item ${i}`,
      tags: ["a", "b"],
      nested: { x: i * 1.5, y: "z".repeat(20) },
    }));
    const body = JSON.stringify(items);
    expect(body.length).toBeGreaterThan(9 * 1024 * 1024);
    serve(body);
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true, maxBytes: 16 * 1024 * 1024 });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.json)).toBe(true);
    expect((res.json as unknown[]).length).toBe(100_000);
  });

  it("still parses +json and moderately nested bodies", async () => {
    serve(JSON.stringify({ a: JSON.parse(nest(500)) }), "application/vnd.api+json; charset=utf-8");
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.json).toBeTypeOf("object");
  });

  it("leaves json undefined past the size threshold and returns the text", async () => {
    const body = `"${"x".repeat(MAX_JSON_AUTOPARSE_CHARS)}"`;
    serve(body);
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true, maxBytes: 32 * 1024 * 1024 });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.json).toBeUndefined();
    expect(res.bodyText?.length).toBe(body.length);
  });

  it("does not parse a JSON-looking body served as text/html", async () => {
    serve('{"a":1}', "text/html");
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.json).toBeUndefined();
  });
});
