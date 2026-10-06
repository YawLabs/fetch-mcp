import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, findBalancedTagContents, parseAttrs } from "../tools/html.js";

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
});
