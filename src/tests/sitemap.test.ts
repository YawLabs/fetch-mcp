import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ABSOLUTE_MAX_BYTES, CANCELLED } from "../http.js";
import {
  assertXmlTagCount,
  decodeSitemapPayload,
  MAX_XML_PARSE_BYTES,
  MAX_XML_PARSE_TAGS,
  parseSitemapXml,
  sitemapByteCap,
} from "../tools/sitemap.js";

describe("parseSitemapXml", () => {
  it("parses a flat urlset", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/a</loc>
    <lastmod>2025-01-01</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/b</loc>
  </url>
</urlset>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls).toHaveLength(2);
    expect(parsed.urls[0]).toEqual({
      loc: "https://example.com/a",
      lastmod: "2025-01-01",
      changefreq: "daily",
      priority: 0.8,
    });
    expect(parsed.urls[1]).toEqual({ loc: "https://example.com/b" });
    expect(parsed.childSitemaps).toEqual([]);
  });

  it("parses a sitemap index", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls).toEqual([]);
    expect(parsed.childSitemaps).toEqual(["https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml"]);
  });

  it("handles a single-url sitemap without crashing", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/only</loc></url>
</urlset>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls).toHaveLength(1);
    expect(parsed.urls[0]?.loc).toBe("https://example.com/only");
  });

  it("ignores priority if not a number", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc><priority>not-a-number</priority></url>
</urlset>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls[0]?.priority).toBeUndefined();
  });
});

describe("decodeSitemapPayload", () => {
  it("returns utf8 when not gzipped", async () => {
    const buf = Buffer.from("<urlset/>", "utf8");
    expect(await decodeSitemapPayload(buf)).toBe("<urlset/>");
  });

  it("gunzips when content is gzip-encoded", async () => {
    const original = "<urlset>hello</urlset>";
    const gz = gzipSync(Buffer.from(original, "utf8"));
    expect(await decodeSitemapPayload(gz)).toBe(original);
  });

  it("refuses a gzip payload that decompresses past maxOutputLength (gzip bomb)", async () => {
    // ~10 KB on the wire, 10 MiB inflated: max_bytes alone only bounds the former.
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(decodeSitemapPayload(bomb, 64 * 1024)).rejects.toThrow(
      /decompresses past 65536 bytes.*raise max_bytes/,
    );
  });

  it("decompresses a payload that fits under maxOutputLength", async () => {
    const original = "<urlset>fits</urlset>";
    const gz = gzipSync(Buffer.from(original, "utf8"));
    expect(await decodeSitemapPayload(gz, original.length)).toBe(original);
  });
});

describe("sitemapByteCap", () => {
  it("defaults to 20 MiB and passes a smaller caller value through", () => {
    expect(sitemapByteCap(undefined)).toBe(20 * 1024 * 1024);
    expect(sitemapByteCap(4096)).toBe(4096);
  });

  it("never exceeds the 100 MiB ceiling, so max_bytes cannot lift the gzip-bomb cap past it", () => {
    // The schema puts no upper bound on max_bytes; this clamp is the bound.
    expect(sitemapByteCap(ABSOLUTE_MAX_BYTES)).toBe(ABSOLUTE_MAX_BYTES);
    expect(sitemapByteCap(ABSOLUTE_MAX_BYTES + 1)).toBe(ABSOLUTE_MAX_BYTES);
    expect(sitemapByteCap(Number.MAX_SAFE_INTEGER)).toBe(ABSOLUTE_MAX_BYTES);
  });
});

describe("the per-document XML tag limit", () => {
  // Markup costs the parser per tag: 16 MiB of `<a/>` (4.2M tags) parsed in
  // 6-7.5 s under the byte limit alone.
  it("counts every `<` and throws past the limit", () => {
    expect(() => assertXmlTagCount("<a><b/></a>", 4, "sitemap")).not.toThrow();
    expect(() => assertXmlTagCount("<a><b/><c/><d/></a>", 4, "sitemap")).toThrow(
      "sitemap has more than 4 tags; larger documents are refused",
    );
    expect(() => assertXmlTagCount("no markup", 0, "sitemap")).not.toThrow();
  });

  it("refuses markup-dense input under the byte limit without parsing it", () => {
    const xml = `<urlset>${"<a/>".repeat(MAX_XML_PARSE_TAGS)}</urlset>`;
    expect(xml.length).toBeLessThan(MAX_XML_PARSE_BYTES);
    expect(() => parseSitemapXml(xml)).toThrow(`sitemap has more than ${MAX_XML_PARSE_TAGS} tags`);
  });

  it("leaves room for a protocol-sized 50,000-URL sitemap (10 tags per URL)", () => {
    expect(50_000 * 10 + 2).toBeLessThan(MAX_XML_PARSE_TAGS);
  });
});

describe("the per-document XML parse limit", () => {
  // fast-xml-parser is synchronous and uninterruptible: a 19 MiB urlset stalled
  // the server 4.65 s through 0.8.3. Documents past the limit never reach it.
  it("is 16 MiB, which a protocol-sized 50,000-URL sitemap fits under", () => {
    expect(MAX_XML_PARSE_BYTES).toBe(16 * 1024 * 1024);
    const entry = (i: number) =>
      `<url><loc>https://www.example-store.com/products/category-name/some-product-slug-${i}</loc><lastmod>2026-09-30T12:34:56+00:00</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
    expect(entry(49_999).length * 50_000).toBeLessThan(MAX_XML_PARSE_BYTES);
  });

  it("parseSitemapXml refuses a string past the limit without parsing it", () => {
    expect(() => parseSitemapXml(`<urlset>${" ".repeat(100)}</urlset>`, 64)).toThrow(
      "sitemap XML is larger than the 64-byte parse limit per document; larger documents are refused",
    );
    expect(parseSitemapXml("<urlset><url><loc>https://x/a</loc></url></urlset>", 64).urls).toHaveLength(1);
  });

  it("decodeSitemapPayload refuses a plain payload past the limit", async () => {
    await expect(decodeSitemapPayload(Buffer.alloc(65, 0x20), undefined, { parseLimit: 64 })).rejects.toThrow(
      /64-byte parse limit/,
    );
    expect(await decodeSitemapPayload(Buffer.alloc(64, 0x20), undefined, { parseLimit: 64 })).toHaveLength(64);
  });

  it("stops a gzip at the parse limit when it is below max_bytes, and names the parse limit", async () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0x20));
    await expect(decodeSitemapPayload(bomb, 512 * 1024, { parseLimit: 64 * 1024 })).rejects.toThrow(
      /65536-byte parse limit/,
    );
    // max_bytes the smaller cap: the max_bytes message, which raising max_bytes can fix.
    await expect(decodeSitemapPayload(bomb, 64 * 1024, { parseLimit: 512 * 1024 })).rejects.toThrow(
      /decompresses past 65536 bytes.*raise max_bytes/,
    );
  });

  it("applies the 16 MiB default to a gzip even when max_bytes is the 100 MiB ceiling", async () => {
    const bomb = gzipSync(Buffer.alloc(MAX_XML_PARSE_BYTES + 1, 0x20));
    await expect(decodeSitemapPayload(bomb, ABSOLUTE_MAX_BYTES)).rejects.toThrow(
      `larger than the ${MAX_XML_PARSE_BYTES}-byte parse limit`,
    );
  });

  it("stops a gunzip whose signal is aborted", async () => {
    const gz = gzipSync(Buffer.from("<urlset/>", "utf8"));
    await expect(decodeSitemapPayload(gz, undefined, { signal: AbortSignal.abort() })).rejects.toThrow(CANCELLED);
  });
});

describe("parseSitemapXml on hostile XML", () => {
  it("ignores attributes, so an attributed <loc> stays a string", () => {
    const parsed = parseSitemapXml('<urlset><url><loc id="x">https://x/a</loc></url></urlset>');
    expect(parsed.urls).toEqual([{ loc: "https://x/a" }]);
  });

  it("does not expand entities that reference other entities (billion laughs)", () => {
    let dtd = '<!DOCTYPE urlset [<!ENTITY a0 "xxxxxxxxxx">';
    for (let i = 1; i < 10; i++) dtd += `<!ENTITY a${i} "${`&a${i - 1};`.repeat(10)}">`;
    const parsed = parseSitemapXml(`${dtd}]><urlset><url><loc>&a9;</loc></url></urlset>`);
    expect(parsed.urls[0]!.loc.length).toBeLessThan(100);
  });

  it("throws past 100,000 expanded entity characters rather than inflating", () => {
    const xml = `<!DOCTYPE urlset [<!ENTITY b "${"y".repeat(9000)}">]><urlset>${"<url><loc>&b;</loc></url>".repeat(20)}</urlset>`;
    expect(() => parseSitemapXml(xml)).toThrow(/Expanded content length limit/);
  });

  it("throws on nesting past 100 levels", () => {
    expect(() => parseSitemapXml(`<urlset>${"<a>".repeat(200)}${"</a>".repeat(200)}</urlset>`)).toThrow(/nested tags/i);
  });
});
