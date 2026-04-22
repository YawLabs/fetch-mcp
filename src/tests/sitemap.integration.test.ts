import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
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

/** Exercise the `fetch_sitemap` tool end-to-end. */
async function callSitemap(
  input: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown> | null; raw: string; isError: boolean }> {
  const s = createFetchServer();
  const tools = (
    s as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> }
  )._registeredTools;
  const tool = tools["fetch_sitemap"];
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

describe("fetch_sitemap integration", () => {
  it("returns warnings (not error) when one child sitemap in an index fails", async () => {
    handler = (_req, res, url) => {
      if (url.pathname === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/good.xml</loc></sitemap>
  <sitemap><loc>${baseUrl}/bad.xml</loc></sitemap>
</sitemapindex>`);
      } else if (url.pathname === "/good.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/a</loc></url>
  <url><loc>${baseUrl}/b</loc></url>
</urlset>`);
      } else if (url.pathname === "/bad.xml") {
        res.statusCode = 500;
        res.end("boom");
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
      max_depth: 1,
    });
    expect(isError).toBe(false);
    expect(parsed).not.toBeNull();
    expect(parsed!.urlCount).toBe(2);
    const warnings = parsed!.warnings as Array<{ url: string; error: string }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.url).toContain("/bad.xml");
  });

  it("exposes childSitemaps when max_depth=0 is called on a sitemap index", async () => {
    handler = (_req, res, url) => {
      if (url.pathname === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/child1.xml</loc></sitemap>
  <sitemap><loc>${baseUrl}/child2.xml</loc></sitemap>
</sitemapindex>`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
      max_depth: 0,
    });
    expect(isError).toBe(false);
    expect(parsed!.urlCount).toBe(0);
    const children = parsed!.childSitemaps as string[];
    expect(children).toHaveLength(2);
    expect(children.some((c) => c.endsWith("/child1.xml"))).toBe(true);
    expect(children.some((c) => c.endsWith("/child2.xml"))).toBe(true);
  });

  it("auto-decompresses a gzipped sitemap discovered via an index", async () => {
    const gzPayload = gzipSync(
      Buffer.from(
        `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/from-gz</loc></url>
</urlset>`,
        "utf8",
      ),
    );
    handler = (_req, res, url) => {
      if (url.pathname === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/child.xml.gz</loc></sitemap>
</sitemapindex>`);
      } else if (url.pathname === "/child.xml.gz") {
        // Serve as application/x-gzip with no Content-Encoding -- the scenario node fetch won't auto-decode.
        res.setHeader("content-type", "application/x-gzip");
        res.end(gzPayload);
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
      max_depth: 1,
    });
    expect(isError).toBe(false);
    expect(parsed!.urlCount).toBe(1);
    const urls = parsed!.urls as Array<{ loc: string }>;
    expect(urls[0]!.loc).toContain("/from-gz");
  });

  it("returns error when the very first sitemap fetch fails", async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end("down");
    };
    const { raw, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
    });
    expect(isError).toBe(true);
    expect(raw).toContain("500");
  });
});
