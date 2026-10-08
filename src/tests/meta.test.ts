import { describe, expect, it } from "vitest";
import { formatJson } from "../format.js";
import { jsonNestsDeeperThan, MAX_JSON_LD_DEPTH, MAX_META_KEYS, MAX_META_LIST, parseHtmlMeta } from "../tools/meta.js";

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

describe("parseHtmlMeta -- title", () => {
  it("reads no title from a page of unclosed <title>s, quickly", () => {
    const t0 = performance.now();
    expect(parseHtmlMeta("<title>x ".repeat(200_000), "https://site.com/").title).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("decodes the title once", () => {
    expect(parseHtmlMeta("<title>a &amp;lt; b</title>", "https://site.com/").title).toBe("a &lt; b");
  });
});

describe("parseHtmlMeta -- <html lang> and JSON-LD in linear time", () => {
  it("reads lang and every JSON-LD block", () => {
    const html = `<html lang="en"><head><script type="application/ld+json">{"a":1}</script><script>x</script><script type=' Application/LD+JSON '>{"b":2}</script ></head></html>`;
    const meta = parseHtmlMeta(html, "https://site.com/");
    expect(meta.language).toBe("en");
    expect(meta.jsonLd).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles many <html> and <script> openers and unclosed JSON-LD quickly", () => {
    const t0 = performance.now();
    parseHtmlMeta("<html ".repeat(200_000), "https://site.com/");
    parseHtmlMeta("<script ".repeat(200_000), "https://site.com/");
    expect(parseHtmlMeta('<script type="application/ld+json">'.repeat(100_000), "https://site.com/").jsonLd).toEqual(
      [],
    );
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("reader -- article, main and h1 in linear time", () => {
  it("handles nested and unclosed article, main and h1 quickly", async () => {
    const { isolateMainContent, extractTitle } = await import("../tools/reader.js");
    const t0 = performance.now();
    isolateMainContent(`${"<main>".repeat(50_000)}${"x".repeat(300)}${"</main>".repeat(50_000)}`);
    isolateMainContent(`${"<article>".repeat(100_000)}</article>`);
    expect(extractTitle(`${"<h1>".repeat(100_000)}</h1>`)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("parseHtmlMeta -- tags in hidden text are not metadata", () => {
  it("ignores meta, link and title in a comment, a script, a style or a template", () => {
    const html =
      `<html lang=en><head><!-- <meta property="og:title" content="SECRET"> <html lang=xx> -->` +
      `<script>"<link rel=canonical href=/secret><meta name=description content=SECRET>"</script>` +
      `<style><title>SECRET3</title></style>` +
      `<template><meta name=robots content=SECRET><link rel=icon href=/secret.ico></template>` +
      `<meta property="og:title" content="Real"><title>Real</title></head></html>`;
    const meta = parseHtmlMeta(html, "https://site.com/");
    expect(JSON.stringify(meta)).not.toMatch(/SECRET|secret/);
    expect(meta.og).toEqual({ title: "Real" });
    expect(meta.title).toBe("Real");
    expect(meta.language).toBe("en");
    expect(meta.canonical).toBeUndefined();
    expect(meta.icons).toEqual([]);
  });

  it("reads the reviewer's repro as no metadata", () => {
    const meta = parseHtmlMeta(
      `<head><!-- <meta property="og:title" content="SECRET"> --><script>"<link rel=canonical href=/secret>"</script><style><title>SECRET3</title></style></head>`,
      "https://x/",
    );
    expect(meta.og).toEqual({});
    expect(meta.canonical).toBeUndefined();
    expect(meta.title).toBeUndefined();
  });

  it("ignores JSON-LD and a title inside an <svg>, and a </head> in a comment", () => {
    const html =
      `<head><!-- </head> --><meta name=description content=Kept>` +
      `<svg><title>Logo</title><script type="application/ld+json">{"svg":1}</script></svg>` +
      `<script type="application/ld+json">{"a":1}</script></head>`;
    const meta = parseHtmlMeta(html, "https://site.com/");
    expect(meta.description).toBe("Kept");
    expect(meta.title).toBeUndefined();
    expect(meta.jsonLd).toEqual([{ a: 1 }]);
  });

  it("builds the mask in linear time on a page of comments and scripts", () => {
    const t0 = performance.now();
    parseHtmlMeta(`<head>${"<!-- <meta name=a content=b> -->".repeat(100_000)}</head>`, "https://site.com/");
    parseHtmlMeta(`<head>${"<script><meta name=a content=b></script>".repeat(100_000)}`, "https://site.com/");
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("parseHtmlMeta -- a JSON-LD block ends where the browser ends the script", () => {
  it.each([
    ["an end tag with an attribute", '{"a":"</script x><!--SECRET1-->"}'],
    ["a self-closing end tag", '{"a":"</script/><style>SECRET2</style>"}'],
    ["an end tag with a quoted attribute", '{"a":"</script x=\\">\\"<!--SECRET4-->"}'],
  ])("reads nothing past %s", (_, json) => {
    expect(JSON.parse(json)).toBeTypeOf("object");
    const html = `<head><script type="application/ld+json">${json}</script><script type="application/ld+json">{"b":2}</script></head>`;
    const meta = parseHtmlMeta(html, "https://site.com/");
    expect(JSON.stringify(meta)).not.toContain("SECRET");
    expect(meta.jsonLd).toEqual([{ b: 2 }]);
  });

  it("keeps a </script> in a double-escaped region inside the block", () => {
    const json = '{"a":"<!--<script></script>-->"}';
    const meta = parseHtmlMeta(`<script type="application/ld+json">${json}</script>`, "https://site.com/");
    expect(meta.jsonLd).toEqual([{ a: "<!--<script></script>-->" }]);
  });
});

describe("parseHtmlMeta -- bounded output", () => {
  const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;

  it("drops a JSON-LD block nested past the limit, before it is parsed", () => {
    const at = (d: number) => `${"[".repeat(d)}${"]".repeat(d)}`;
    const meta = parseHtmlMeta(
      `<head>${ld(at(MAX_JSON_LD_DEPTH))}${ld(at(MAX_JSON_LD_DEPTH + 1))}</head>`,
      "https://e.com/",
    );
    expect(meta.jsonLd).toHaveLength(1);
    expect(meta.truncated).toEqual(["jsonLd"]);
  });

  it("counts depth outside strings only", () => {
    expect(jsonNestsDeeperThan(`{"a":"${"[".repeat(500)}\\"{{"}`, 2)).toBe(false);
    expect(jsonNestsDeeperThan(`[[[`, 2)).toBe(true);
  });

  it("formats a page of deeply nested JSON-LD blocks in bounded output, without throwing", () => {
    const deep = `${"[".repeat(4000)}${"]".repeat(4000)}`;
    const shallow = `${"[".repeat(60)}{"x":1}${"]".repeat(60)}`;
    const html = `<head>${ld(deep)}${ld(shallow).repeat(100)}</head>`;
    const t0 = Date.now();
    const out = formatJson(parseHtmlMeta(html, "https://e.com/"));
    expect(out.isError).toBeUndefined();
    const text = out.content[0]!.text;
    expect(text.length).toBeLessThan(50_200);
    expect(text).toMatch(/\[\.\.\. truncated \d+ chars \.\.\.\]$/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("caps icons and feeds, and does not resolve the links it drops", () => {
    const base = `https://example.com/${"a".repeat(2000)}/`;
    const html = `<head>${'<link rel=icon href=x><link rel=alternate type="application/rss+xml" href=f>'.repeat(20_000)}</head>`;
    const meta = parseHtmlMeta(html, base);
    expect(meta.icons).toHaveLength(MAX_META_LIST);
    expect(meta.feeds).toHaveLength(MAX_META_LIST);
    expect(meta.icons[0]!.href).toBe(`${base}x`);
    expect(meta.truncated).toEqual(["icons", "feeds"]);
    expect(formatJson(meta).content[0]!.text.length).toBeLessThan(50_200);
  });

  it("caps og keys and values per key, and flags each family", () => {
    const keys = Array.from({ length: MAX_META_KEYS + 5 }, (_, i) => `<meta property="og:k${i}" content=v>`).join("");
    const vals = '<meta name="twitter:image" content=i>'.repeat(MAX_META_LIST + 5);
    const meta = parseHtmlMeta(`<head>${keys}${vals}<meta property="article:tag" content=t></head>`, "https://e.com/");
    expect(Object.keys(meta.og)).toHaveLength(MAX_META_KEYS);
    expect(meta.twitterAll.image).toHaveLength(MAX_META_LIST);
    expect(meta.article).toEqual({ tag: "t" });
    expect(meta.truncated).toEqual(["og", "twitter"]);
  });

  it("omits truncated when nothing was cut", () => {
    expect(parseHtmlMeta("<head><link rel=icon href=x></head>", "https://e.com/").truncated).toBeUndefined();
  });

  it("keeps prototype-named keys as ordinary keys", () => {
    const html =
      '<head><meta property="og:constructor" content=a><meta property="og:constructor" content=b><meta property="og:__proto__" content=c></head>';
    const meta = parseHtmlMeta(html, "https://e.com/");
    expect(Object.hasOwn(meta.og, "constructor")).toBe(true);
    expect(meta.og.constructor).toBe("a");
    expect(meta.ogAll.constructor).toEqual(["a", "b"]);
    expect(Object.hasOwn(meta.og, "__proto__")).toBe(true);
    expect(JSON.parse(formatJson(meta).content[0]!.text).og).toEqual(JSON.parse('{"constructor":"a","__proto__":"c"}'));
  });
});
