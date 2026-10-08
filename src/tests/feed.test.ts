import type { Server } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setHttpContext } from "../http.js";
import { createFetchServer } from "../server.js";
import { MAX_FEED_PARSE_BYTES, MAX_FEED_PARSE_TAGS, parseFeedXml } from "../tools/feed.js";

describe("parseFeedXml — RSS 2.0", () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Blog</title>
    <description>A sample feed</description>
    <link>https://example.com</link>
    <lastBuildDate>Wed, 01 Jan 2025 12:00:00 GMT</lastBuildDate>
    <item>
      <title>First Post</title>
      <link>https://example.com/first</link>
      <guid>https://example.com/first</guid>
      <pubDate>Wed, 01 Jan 2025 12:00:00 GMT</pubDate>
      <dc:creator>Jane</dc:creator>
      <description>First summary</description>
      <content:encoded><![CDATA[<p>First body</p>]]></content:encoded>
      <category>tech</category>
      <category>news</category>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/second</link>
      <description>Second summary</description>
    </item>
  </channel>
</rss>`;

  it("detects RSS and pulls channel metadata", () => {
    const parsed = parseFeedXml(rss);
    expect(parsed.kind).toBe("rss");
    expect(parsed.title).toBe("Example Blog");
    expect(parsed.description).toBe("A sample feed");
    expect(parsed.link).toBe("https://example.com");
    expect(parsed.updated).toContain("Jan 2025");
  });

  it("parses items with author and content:encoded", () => {
    const parsed = parseFeedXml(rss);
    expect(parsed.entries).toHaveLength(2);
    const first = parsed.entries[0];
    expect(first?.title).toBe("First Post");
    expect(first?.link).toBe("https://example.com/first");
    expect(first?.author).toBe("Jane");
    expect(first?.summary).toBe("First summary");
    expect(first?.content).toContain("First body");
    expect(first?.categories).toEqual(["tech", "news"]);
  });

  it("handles items without optional fields", () => {
    const parsed = parseFeedXml(rss);
    expect(parsed.entries[1]?.title).toBe("Second Post");
    expect(parsed.entries[1]?.author).toBeUndefined();
    expect(parsed.entries[1]?.categories).toBeUndefined();
  });
});

describe("parseFeedXml — Atom 1.0", () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <subtitle>An atom feed</subtitle>
  <link rel="self" href="https://example.com/feed.xml"/>
  <link rel="alternate" href="https://example.com"/>
  <updated>2025-01-01T12:00:00Z</updated>
  <entry>
    <title>Atom Entry</title>
    <id>urn:uuid:123</id>
    <link rel="alternate" href="https://example.com/post"/>
    <link rel="self" href="https://example.com/feed/123"/>
    <published>2025-01-01T12:00:00Z</published>
    <updated>2025-01-02T12:00:00Z</updated>
    <author><name>John Doe</name></author>
    <summary>Atom summary</summary>
    <content>Atom content</content>
    <category term="tech" label="Technology"/>
  </entry>
</feed>`;

  it("detects Atom and picks the alternate link (not self)", () => {
    const parsed = parseFeedXml(atom);
    expect(parsed.kind).toBe("atom");
    expect(parsed.title).toBe("Atom Feed");
    expect(parsed.description).toBe("An atom feed");
    expect(parsed.link).toBe("https://example.com");
  });

  it("parses entry fields including nested author", () => {
    const parsed = parseFeedXml(atom);
    expect(parsed.entries).toHaveLength(1);
    const e = parsed.entries[0];
    expect(e?.title).toBe("Atom Entry");
    expect(e?.id).toBe("urn:uuid:123");
    expect(e?.link).toBe("https://example.com/post");
    expect(e?.author).toBe("John Doe");
    expect(e?.summary).toBe("Atom summary");
    expect(e?.content).toBe("Atom content");
    expect(e?.categories).toEqual(["tech"]);
  });
});

describe("parseFeedXml — Atom content types", () => {
  it("preserves content type=html", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>F</title>
  <entry>
    <title>E</title>
    <content type="html">&lt;p&gt;hi&lt;/p&gt;</content>
  </entry>
</feed>`;
    const parsed = parseFeedXml(xml);
    expect(parsed.entries[0]?.contentType).toBe("html");
    expect(parsed.entries[0]?.content).toContain("<p>hi</p>");
  });

  it("preserves content type=text", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>F</title>
  <entry>
    <title>E</title>
    <content type="text">plain</content>
  </entry>
</feed>`;
    const parsed = parseFeedXml(xml);
    expect(parsed.entries[0]?.contentType).toBe("text");
    expect(parsed.entries[0]?.content).toBe("plain");
  });

  it("does not set contentType for RSS entries", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>X</title>
  <item><title>One</title><description>plain rss</description></item>
</channel></rss>`;
    const parsed = parseFeedXml(xml);
    expect(parsed.entries[0]?.contentType).toBeUndefined();
  });
});

describe("parseFeedXml — tag limit", () => {
  // Markup costs the parser per tag: 16 MiB of `<x/>` parsed in 7.6 s under the byte limit alone.
  it("refuses a feed with more than MAX_FEED_PARSE_TAGS tags without parsing it", () => {
    const xml = `<rss><channel>${"<x/>".repeat(MAX_FEED_PARSE_TAGS)}</channel></rss>`;
    expect(xml.length).toBeLessThan(MAX_FEED_PARSE_BYTES);
    expect(() => parseFeedXml(xml)).toThrow(`feed has more than ${MAX_FEED_PARSE_TAGS} tags`);
  });

  it("parses a feed at the limit", () => {
    const xml = `<rss><channel><title>t</title>${"<x/>".repeat(MAX_FEED_PARSE_TAGS - 6)}</channel></rss>`;
    expect(parseFeedXml(xml).title).toBe("t");
  });
});

describe("parseFeedXml — edge cases", () => {
  it("returns kind=unknown for non-feed XML", () => {
    const parsed = parseFeedXml('<?xml version="1.0"?><root/>');
    expect(parsed.kind).toBe("unknown");
    expect(parsed.entries).toEqual([]);
  });

  it("handles a single-entry RSS where item is not an array", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>X</title>
  <item><title>One</title><link>https://x/one</link></item>
</channel></rss>`;
    const parsed = parseFeedXml(xml);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.title).toBe("One");
  });

  it("handles an Atom feed with a single link object (not array)", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Solo Atom</title>
  <link href="https://solo.example"/>
  <entry><title>E</title><link href="https://solo.example/e"/></entry>
</feed>`;
    const parsed = parseFeedXml(xml);
    expect(parsed.kind).toBe("atom");
    expect(parsed.link).toBe("https://solo.example");
    expect(parsed.entries[0]?.link).toBe("https://solo.example/e");
  });
});

describe("parseFeedXml on hostile XML", () => {
  it("refuses input past the parse limit without parsing it", () => {
    expect(MAX_FEED_PARSE_BYTES).toBe(16 * 1024 * 1024);
    expect(() => parseFeedXml(`<rss>${" ".repeat(100)}</rss>`, 64)).toThrow(
      "feed is larger than the 64-byte parse limit; larger feeds are refused",
    );
  });

  it("keeps the attributes the extractors read and drops the rest", () => {
    const xml = `<rss><channel><item a1="x" a2="y"><guid isPermaLink="false">abc</guid><title data-x="1">T</title></item></channel></rss>`;
    const parsed = parseFeedXml(xml);
    expect(parsed.entries[0]).toEqual({ id: "abc", title: "T" });
    const atom = parseFeedXml(
      `<feed><entry><link rel="self" href="https://x/self" foo="1"/><link rel="alternate" href="https://x/a"/><category term="t" scheme="s"/><content type="html" xml:lang="en">c</content></entry></feed>`,
    );
    expect(atom.entries[0]).toMatchObject({
      link: "https://x/a",
      categories: ["t"],
      content: "c",
      contentType: "html",
    });
  });

  it("does not expand entities that reference other entities (billion laughs)", () => {
    let dtd = '<!DOCTYPE rss [<!ENTITY a0 "xxxxxxxxxx">';
    for (let i = 1; i < 10; i++) dtd += `<!ENTITY a${i} "${`&a${i - 1};`.repeat(10)}">`;
    const parsed = parseFeedXml(`${dtd}]><rss><channel><item><title>&a9;</title></item></channel></rss>`);
    expect(parsed.entries[0]!.title!.length).toBeLessThan(100);
  });

  it("throws past 100,000 expanded entity characters rather than inflating", () => {
    const xml = `<!DOCTYPE rss [<!ENTITY b "${"y".repeat(9000)}">]><rss><channel>${"<item><title>&b;</title></item>".repeat(20)}</channel></rss>`;
    expect(() => parseFeedXml(xml)).toThrow(/Expanded content length limit/);
  });

  it("throws on nesting past 100 levels", () => {
    expect(() => parseFeedXml(`<rss>${"<a>".repeat(200)}${"</a>".repeat(200)}</rss>`)).toThrow(/nested tags/i);
  });
});

describe("fetch_feed tool limits", () => {
  setHttpContext({ version: "test" });
  let server: Server;
  let baseUrl: string;
  let body = "";

  beforeAll(async () => {
    server = createHttpServer((_req, res) => {
      res.setHeader("content-type", "application/rss+xml");
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function callFeed(input: Record<string, unknown>): Promise<{ raw: string; isError: boolean }> {
    const s = createFetchServer({ allowPrivateHosts: true });
    const tool = (
      s as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              input: unknown,
              extra: { signal: AbortSignal },
            ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
          }
        >;
      }
    )._registeredTools.fetch_feed!;
    const out = await tool.handler(
      { url: `${baseUrl}/feed.xml`, allow_private_hosts: true, ...input },
      { signal: new AbortController().signal },
    );
    return { raw: out.content[0]!.text, isError: Boolean(out.isError) };
  }

  it("says a feed cut off at max_bytes is too large, rather than reporting a parse error", async () => {
    body = `<rss><channel>${"<item><title>x</title></item>".repeat(500)}</channel></rss>`;
    const { raw, isError } = await callFeed({ max_bytes: 4096 });
    expect(isError).toBe(true);
    expect(raw).toContain("feed is larger than max_bytes (4096 bytes); raise max_bytes to read it");
  });

  it("refuses a feed past the 16 MiB parse limit even when max_bytes allows it", async () => {
    body = `<rss><channel>${" ".repeat(MAX_FEED_PARSE_BYTES)}</channel></rss>`;
    const { raw, isError } = await callFeed({ max_bytes: 20 * 1024 * 1024 });
    body = "";
    expect(isError).toBe(true);
    expect(raw).toContain(`feed is larger than the ${MAX_FEED_PARSE_BYTES}-byte parse limit`);
  });

  it("still parses a feed that fits", async () => {
    body = "<rss><channel><title>T</title><item><title>one</title></item></channel></rss>";
    const { raw, isError } = await callFeed({});
    expect(isError).toBe(false);
    expect(JSON.parse(raw)).toMatchObject({ kind: "rss", title: "T", entryCount: 1 });
  });
});
