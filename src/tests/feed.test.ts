import { describe, expect, it } from "vitest";
import { parseFeedXml } from "../tools/feed.js";

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
