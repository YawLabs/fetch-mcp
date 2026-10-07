import { describe, expect, it } from "vitest";
import { visibleTagMask } from "../tools/content.js";
import {
  decodeHtmlEntities,
  findBalancedTagContents,
  findTags,
  firstBalancedTagContent,
  forEachBalancedTag,
  parseAttrs,
} from "../tools/html.js";

describe("decodeHtmlEntities", () => {
  it("decodes the named entities it covers", () => {
    expect(decodeHtmlEntities("&amp; &lt; &gt; &quot; &apos; &#39; &nbsp;")).toBe(`& < > " ' '  `);
  });

  it("decodes decimal and hex numeric entities, with either x", () => {
    expect(decodeHtmlEntities("&#65;&#x42;&#X43;&#x1F600;")).toBe("ABC\u{1F600}");
  });

  it("decodes in one pass, so a decoded & never starts another entity (CodeQL #6)", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeHtmlEntities("&amp;quot;&amp;amp;&amp;#65;")).toBe("&quot;&amp;&#65;");
  });

  it.each([
    ["past U+10FFFF", "&#x110000;"],
    ["far past U+10FFFF", "&#99999999999999999999;"],
    ["NUL", "&#0;"],
    ["a lone surrogate", "&#xD800;"],
  ])("decodes a code point %s to U+FFFD instead of throwing", (_, s) => {
    expect(decodeHtmlEntities(s)).toBe("\uFFFD");
  });

  it("leaves unknown and unterminated entities alone", () => {
    expect(decodeHtmlEntities("&copy; &amp &#65 &#xZZ;")).toBe("&copy; &amp &#65 &#xZZ;");
  });
});

describe("parseAttrs", () => {
  it("decodes attribute values once", () => {
    expect(parseAttrs(`content="a &amp;lt; b"`).content).toBe("a &lt; b");
  });

  it("survives an out-of-range numeric entity", () => {
    expect(parseAttrs(`content="x&#99999999;y"`).content).toBe("x\uFFFDy");
  });
});

describe("parseAttrs -- tokenizer rules", () => {
  it("reads valueless, quoted and unquoted attributes", () => {
    expect({ ...parseAttrs(`a b="x y" c='z' d=w/x e`) }).toEqual({ a: "", b: "x y", c: "z", d: "w/x", e: "" });
  });

  it("keeps the first of duplicate attributes, as a browser does", () => {
    expect(parseAttrs(`href="/good" href="/evil"`).href).toBe("/good");
  });

  it("treats quotes in a name or an unquoted value as ordinary characters", () => {
    expect({ ...parseAttrs(`alt=Bob's a"b=1`) }).toEqual({ alt: "Bob's", 'a"b': "1" });
  });

  it("has no prototype, so __proto__ and constructor are plain keys", () => {
    const attrs = parseAttrs(`__proto__=x constructor=y`);
    expect(Object.getOwnPropertyDescriptor(attrs, "__proto__")?.value).toBe("x");
    expect(attrs.constructor).toBe("y");
    expect(parseAttrs("").constructor).toBeUndefined();
  });

  it("parses a very long attribute name in linear time", () => {
    const t0 = performance.now();
    parseAttrs(` ${"a".repeat(2_000_000)}"`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("findBalancedTagContents", () => {
  it("returns outermost contents in order, '' for self-closing, and stops at an unclosed one", () => {
    const html = "<article>a<article>b</article></article><article/><article>c</article><article>d";
    expect(findBalancedTagContents(html, "article")).toEqual(["a<article>b</article>", "", "c"]);
  });

  it("handles deep nesting and many unclosed openers in linear time", () => {
    const t0 = performance.now();
    expect(
      findBalancedTagContents(`${"<article>".repeat(100_000)}${"</article>".repeat(100_000)}`, "article"),
    ).toHaveLength(1);
    expect(findBalancedTagContents(`${"<article>".repeat(100_000)}</article>`, "article")).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("matches whole tag names, and end tags with whitespace or attributes", () => {
    expect(findBalancedTagContents("<article-list>x</article-list><article>a</article\n class=x>", "article")).toEqual([
      "a",
    ]);
    // `</ article>` is a bogus comment in a browser, not an end tag.
    expect(findBalancedTagContents("<article>a</ article>b</article>", "article")).toEqual(["a</ article>b"]);
    // An end tag's attributes are not searched for openers.
    expect(findBalancedTagContents(`<article>a</article x="<article>">b</article>`, "article")).toEqual(["a"]);
  });

  it("with a mask, skips tags in comments, raw text and templates", () => {
    const html =
      "<!-- <article>c --><script>'<article>s'</script><template><article>t</article></template>" +
      "<textarea><article>x</textarea><article>real</article>";
    expect(findBalancedTagContents(html, "article", visibleTagMask(html))).toEqual(["real"]);
    expect([...findTags(html, "article", visibleTagMask(html))].map((t) => t.start)).toEqual([
      html.lastIndexOf("<article>"),
    ]);
  });
});

describe("visibleTagMask -- tags a caller would read as raw text", () => {
  const marked = (html: string, tag: string) =>
    [...findTags(html, tag, visibleTagMask(html))].map((t) => html.slice(t.start, t.start + tag.length + 1));

  it.each([
    ["an SVG <title>", "<svg><title>Logo</title></svg>", "title"],
    ["a MathML <title>", "<math><mi><title>T</title></mi></math>", "title"],
    ["a <script> in an SVG", '<svg><script type="application/ld+json">{}</script></svg>', "script"],
    ["a <style> in an SVG", "<svg><style>a{}</style></svg>", "style"],
    ["a <title> in a <select>", "<select><title>T</title></select>", "title"],
  ])("leaves out %s", (_, html, tag) => {
    expect(marked(html, tag)).toEqual([]);
  });

  it("still marks a <title> and a <script> outside them", () => {
    const html = "<svg><title>a</title></svg><title>b</title><select></select><script>c</script>";
    expect(marked(html, "title")).toEqual(["<title"]);
    expect([...findTags(html, "title", visibleTagMask(html))][0]!.start).toBe(html.lastIndexOf("<title>"));
    expect(marked(html, "script")).toEqual(["<script"]);
  });
});

describe("visibleTagMask -- after the readings of an island part", () => {
  it.each([
    ["a comment across an SVG title's end tag", "<svg><b><title><!--</title><article>--></title><article>"],
    ["a select opened in an island", "<svg><p><select></svg><svg><script/><article>"],
  ])("marks no tag past %s", (_, html) => {
    expect([...findTags(html, "article", visibleTagMask(html))]).toEqual([]);
  });
});

describe("forEachBalancedTag", () => {
  it("reports each pair as it closes, with its depth, and never an unclosed opener", () => {
    const html = "<a1><div>x<div/></div><div y=1>z</div><div>unclosed";
    const seen: string[] = [];
    forEachBalancedTag(html, "div", undefined, (start, contentStart, contentEnd, depth) => {
      seen.push(`${html.slice(start, contentStart)}|${html.slice(contentStart, contentEnd)}|${depth}`);
      return undefined;
    });
    expect(seen).toEqual(["<div/>||1", "<div>|x<div/>|0", "<div y=1>|z|0"]);
  });

  it("stops when the visitor returns true", () => {
    let calls = 0;
    forEachBalancedTag("<p>a</p><p>b</p>", "p", undefined, () => {
      calls++;
      return true;
    });
    expect(calls).toBe(1);
    expect(firstBalancedTagContent("<p><p>a</p></p><p>b</p>", "p")).toBe("<p>a</p>");
    expect(firstBalancedTagContent("<p>never closes", "p")).toBeUndefined();
  });

  it("holds no record per unclosed opener", () => {
    const html = "<div>".repeat(1_000_000);
    const t0 = performance.now();
    let calls = 0;
    forEachBalancedTag(html, "div", undefined, () => {
      calls++;
      return undefined;
    });
    expect(calls).toBe(0);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
