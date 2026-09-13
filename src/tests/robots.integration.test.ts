import { readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setHttpContext } from "../http.js";
import { createFetchServer } from "../server.js";

setHttpContext({ version: "test" });

let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void = () => {};

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Exercise the `fetch_robots` tool end-to-end. */
async function callRobots(
  input: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown> | null; raw: string; isError: boolean }> {
  const s = createFetchServer();
  const tools = (
    s as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> }
  )._registeredTools;
  const tool = tools.fetch_robots;
  const out = (await tool.handler(input)) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const raw = out.content[0]!.text;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* error messages are plain strings */
  }
  return { parsed, raw, isError: Boolean(out.isError) };
}

/**
 * The keys README.md documents for `fetch_robots`, read from the README itself
 * so the tests fail when the docs and the handler drift apart in either
 * direction. `optional` holds the `key?:` entries.
 */
function documentedKeys(): { required: string[]; optional: string[] } {
  const readme = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf-8");
  const section = readme.slice(readme.indexOf("### `fetch_robots`"));
  const block = /```ts\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";
  const required: string[] = [];
  const optional: string[] = [];
  for (const m of block.matchAll(/^\s+(\w+)(\?)?:/gm)) {
    (m[2] ? optional : required).push(m[1]!);
  }
  return { required, optional };
}

function serveRobots(status: number, body: string) {
  handler = (_req, res, url) => {
    if (url.pathname === "/robots.txt") {
      res.statusCode = status;
      res.setHeader("content-type", "text/plain");
      res.end(body);
    } else {
      res.statusCode = 200;
      res.end("page");
    }
  };
}

describe("fetch_robots integration", () => {
  it("reads the documented shape out of the README", () => {
    // Guards the parser below: an empty or partial key list would let every
    // shape assertion in this file pass vacuously.
    const { required, optional } = documentedKeys();
    expect(required).toEqual([
      "robotsUrl",
      "status",
      "userAgent",
      "path",
      "allowed",
      "matchedRule",
      "crawlDelay",
      "sitemaps",
      "rawRobotsText",
    ]);
    expect(optional).toEqual(["note"]);
  });

  it("returns the full documented shape when robots.txt 404s", async () => {
    serveRobots(404, "not found");
    const { parsed, isError } = await callRobots({
      url: `${baseUrl}/some/page?q=1`,
      allow_private_hosts: true,
    });
    expect(isError).toBe(false);
    expect(parsed).toEqual({
      robotsUrl: `${baseUrl}/robots.txt`,
      status: 404,
      userAgent: "*",
      path: "/some/page?q=1",
      allowed: true,
      matchedRule: null,
      crawlDelay: null,
      sitemaps: [],
      rawRobotsText: "",
      note: "no robots.txt -- crawl permitted by default",
    });
  });

  it("carries a supplied user_agent through the 404 response", async () => {
    serveRobots(404, "");
    const { parsed } = await callRobots({
      url: `${baseUrl}/`,
      user_agent: "ExampleBot",
      allow_private_hosts: true,
    });
    expect(parsed!.userAgent).toBe("ExampleBot");
    expect(parsed!.path).toBe("/");
  });

  it("returns every documented key on both the 404 and the parsed path", async () => {
    const { required, optional } = documentedKeys();

    serveRobots(404, "");
    const missing = (await callRobots({ url: `${baseUrl}/x`, allow_private_hosts: true })).parsed!;

    serveRobots(
      200,
      ["User-agent: *", "Disallow: /private", "Crawl-delay: 5", `Sitemap: ${baseUrl}/sitemap.xml`].join("\n"),
    );
    const found = (await callRobots({ url: `${baseUrl}/private/x`, allow_private_hosts: true })).parsed!;
    expect(found.allowed).toBe(false);
    expect(found.matchedRule).toBe("Disallow: /private");
    expect(found.crawlDelay).toBe(5);
    expect(found.sitemaps).toEqual([`${baseUrl}/sitemap.xml`]);

    for (const body of [missing, found]) {
      for (const key of required) expect(body, `missing documented key "${key}"`).toHaveProperty(key);
      const undocumented = Object.keys(body).filter((k) => !required.includes(k) && !optional.includes(k));
      expect(undocumented).toEqual([]);
    }
  });

  it("still returns an error for a non-404 failure", async () => {
    serveRobots(500, "down");
    const { raw, isError } = await callRobots({ url: `${baseUrl}/`, allow_private_hosts: true });
    expect(isError).toBe(true);
    expect(raw).toContain("HTTP 500");
  });
});
