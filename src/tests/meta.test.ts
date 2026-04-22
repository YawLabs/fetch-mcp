import { describe, expect, it } from "vitest";
import { parseHtmlMeta } from "../tools/meta.js";

describe("parseHtmlMeta", () => {
  it("extracts title, description, and canonical", () => {
    const html = `
      <html lang="en">
        <head>
          <title>My Page</title>
          <meta name="description" content="A page about things.">
          <link rel="canonical" href="https://example.com/canonical">
        </head>
        <body>body</body>
      </html>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/page");
    expect(meta.title).toBe("My Page");
    expect(meta.description).toBe("A page about things.");
    expect(meta.canonical).toBe("https://example.com/canonical");
    expect(meta.language).toBe("en");
  });

  it("extracts OG properties", () => {
    const html = `
      <head>
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG description">
        <meta property="og:image" content="https://example.com/img.png">
        <meta property="og:type" content="article">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.og).toEqual({
      title: "OG Title",
      description: "OG description",
      image: "https://example.com/img.png",
      type: "article",
    });
  });

  it("keeps first og value in `og` and all values in `ogAll`", () => {
    const html = `
      <head>
        <meta property="og:image" content="https://ex.com/one.png">
        <meta property="og:image" content="https://ex.com/two.png">
        <meta property="og:image" content="https://ex.com/three.png">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.og.image).toBe("https://ex.com/one.png");
    expect(meta.ogAll.image).toEqual(["https://ex.com/one.png", "https://ex.com/two.png", "https://ex.com/three.png"]);
  });

  it("only populates *All for repeated keys (single-value keys omitted)", () => {
    const html = `
      <head>
        <meta property="og:title" content="Solo">
        <meta property="og:image" content="a.png">
        <meta property="og:image" content="b.png">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect("title" in meta.ogAll).toBe(false);
    expect(meta.ogAll.image).toEqual(["a.png", "b.png"]);
  });

  it("extracts Twitter card properties", () => {
    const html = `
      <head>
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:site" content="@example">
        <meta name="twitter:title" content="Twitter Title">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.twitter.card).toBe("summary_large_image");
    expect(meta.twitter.site).toBe("@example");
    expect(meta.twitter.title).toBe("Twitter Title");
  });

  it("extracts article: properties", () => {
    const html = `
      <head>
        <meta property="article:author" content="Jane Doe">
        <meta property="article:published_time" content="2025-01-01T00:00:00Z">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.article.author).toBe("Jane Doe");
    expect(meta.article.published_time).toBe("2025-01-01T00:00:00Z");
  });

  it("resolves relative link hrefs to absolute", () => {
    const html = `
      <head>
        <link rel="canonical" href="/about">
        <link rel="icon" href="/favicon.ico">
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Posts">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/blog/post");
    expect(meta.canonical).toBe("https://example.com/about");
    expect(meta.icons[0]?.href).toBe("https://example.com/favicon.ico");
    expect(meta.feeds[0]?.href).toBe("https://example.com/feed.xml");
    expect(meta.feeds[0]?.title).toBe("Posts");
    expect(meta.feeds[0]?.type).toContain("rss");
  });

  it("captures icon rels of multiple flavours", () => {
    const html = `
      <head>
        <link rel="icon" href="/a.ico">
        <link rel="shortcut icon" href="/b.ico">
        <link rel="apple-touch-icon" href="/c.png" sizes="180x180">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.icons).toHaveLength(3);
    expect(meta.icons[2]?.sizes).toBe("180x180");
  });

  it("parses JSON-LD blocks", () => {
    const html = `
      <head>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Article", "headline": "Hello"}
        </script>
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.jsonLd).toHaveLength(1);
    const first = meta.jsonLd[0] as { headline?: string };
    expect(first.headline).toBe("Hello");
  });

  it("ignores malformed JSON-LD without failing", () => {
    const html = `
      <head>
        <script type="application/ld+json">{ not-valid json }</script>
        <script type="application/ld+json">{"@type":"Person","name":"Ok"}</script>
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.jsonLd).toHaveLength(1);
  });

  it("extracts robots directive", () => {
    const html = `<head><meta name="robots" content="noindex,nofollow"></head>`;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.robots).toBe("noindex,nofollow");
  });

  it("decodes HTML entities in title and description", () => {
    const html = `
      <head>
        <title>A &amp; B</title>
        <meta name="description" content="Prices &lt; 100">
      </head>
    `;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.title).toBe("A & B");
    expect(meta.description).toBe("Prices < 100");
  });

  it("preserves '>' characters inside quoted meta content", () => {
    // The old regex stopped at the first `>` and lost the rest of the tag.
    const html = `<head><meta name="description" content="Best reviews > 4 stars and <100ms"></head>`;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.description).toBe("Best reviews > 4 stars and <100ms");
  });

  it("does not break when a meta tag attribute contains '>' before other attrs", () => {
    const html = `<head><meta property="og:description" content="arrow > pointing" >
      <meta property="og:title" content="Real title"></head>`;
    const meta = parseHtmlMeta(html, "https://example.com/");
    expect(meta.og.description).toBe("arrow > pointing");
    expect(meta.og.title).toBe("Real title");
  });
});
