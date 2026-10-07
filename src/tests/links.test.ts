import { describe, expect, it } from "vitest";
import { extractLinks } from "../tools/links.js";

describe("extractLinks", () => {
  it("resolves relative hrefs against the base URL", () => {
    const html = `
      <a href="/about">About</a>
      <a href="contact.html">Contact</a>
      <a href="https://other.example/page">External</a>
    `;
    const links = extractLinks(html, "https://site.com/blog/post");
    expect(links).toHaveLength(3);
    expect(links[0]?.href).toBe("https://site.com/about");
    expect(links[1]?.href).toBe("https://site.com/blog/contact.html");
    expect(links[2]?.href).toBe("https://other.example/page");
  });

  it("honors <base href>", () => {
    const html = `
      <head><base href="https://cdn.example/"></head>
      <a href="doc">Doc</a>
    `;
    const links = extractLinks(html, "https://site.com/");
    expect(links[0]?.href).toBe("https://cdn.example/doc");
  });

  it("classifies internal vs external by host", () => {
    const html = `
      <a href="https://site.com/a">A</a>
      <a href="https://other.com/b">B</a>
    `;
    const links = extractLinks(html, "https://site.com/");
    expect(links[0]?.type).toBe("internal");
    expect(links[1]?.type).toBe("external");
  });

  it("treats www.site.com as internal when page host is site.com", () => {
    const html = `
      <a href="https://www.site.com/a">A</a>
      <a href="https://site.com/b">B</a>
      <a href="https://other.com/c">C</a>
    `;
    const links = extractLinks(html, "https://site.com/");
    expect(links[0]?.type).toBe("internal");
    expect(links[1]?.type).toBe("internal");
    expect(links[2]?.type).toBe("external");
  });

  it("treats site.com as internal when page host is www.site.com", () => {
    const html = `
      <a href="https://site.com/a">A</a>
      <a href="https://www.site.com/b">B</a>
    `;
    const links = extractLinks(html, "https://www.site.com/");
    expect(links[0]?.type).toBe("internal");
    expect(links[1]?.type).toBe("internal");
  });

  it("skips javascript:, mailto:, tel:, data:, file:, and fragment links", () => {
    const html = `
      <a href="#section">Anchor</a>
      <a href="javascript:alert(1)">JS</a>
      <a href="mailto:x@y.z">Mail</a>
      <a href="tel:+1234">Phone</a>
      <a href="data:text/plain,hi">Data</a>
      <a href="file:///etc/passwd">File</a>
      <a href="/real">Real</a>
    `;
    const links = extractLinks(html, "https://site.com/");
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://site.com/real");
  });

  it("captures anchor text with inner markup stripped", () => {
    const html = `<a href="/a"><span>Read <em>more</em></span></a>`;
    const links = extractLinks(html, "https://site.com/");
    expect(links[0]?.text).toBe("Read more");
  });

  it("captures rel and title attributes", () => {
    const html = `<a href="/a" rel="nofollow noopener" title="Tip">X</a>`;
    const links = extractLinks(html, "https://site.com/");
    expect(links[0]?.rel).toBe("nofollow noopener");
    expect(links[0]?.title).toBe("Tip");
  });

  it("handles single and double quoted attrs", () => {
    const html = `
      <a href='/single'>s</a>
      <a href="/double">d</a>
      <a href=/unquoted>u</a>
    `;
    const links = extractLinks(html, "https://site.com/");
    expect(links.map((l) => l.href)).toEqual([
      "https://site.com/single",
      "https://site.com/double",
      "https://site.com/unquoted",
    ]);
  });

  it("decodes HTML entities in anchor text", () => {
    const html = `<a href="/a">A &amp; B</a>`;
    const links = extractLinks(html, "https://site.com/");
    expect(links[0]?.text).toBe("A & B");
  });

  it("preserves '>' inside quoted href and title attributes", () => {
    const html = `<a href="/search?q=a>b" title="greater > than">link</a>`;
    const links = extractLinks(html, "https://site.com/");
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://site.com/search?q=a%3Eb");
    expect(links[0]?.title).toBe("greater > than");
  });

  it("returns an empty array when no anchors exist", () => {
    expect(extractLinks("<p>nothing here</p>", "https://site.com/")).toEqual([]);
  });

  it("skips anchors without an href attribute", () => {
    const html = `<a name="anchor">nope</a><a href="/a">yes</a>`;
    const links = extractLinks(html, "https://site.com/");
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://site.com/a");
  });
});

describe("extractLinks -- scheme allow-list (CodeQL #9)", () => {
  it.each([
    ["vbscript:", `<a href="vbscript:msgbox(1)">x</a>`],
    ["javascript: with an encoded tab", `<a href="java&#9;script:alert(1)">x</a>`],
    ["javascript: with a literal newline", `<a href="java\nscript:alert(1)">x</a>`],
    ["javascript: behind a control character", `<a href="\u0001javascript:alert(1)">x</a>`],
    ["JavaScript: in mixed case", `<a href="JaVaScRiPt:alert(1)">x</a>`],
    ["ftp:", `<a href="ftp://files.example.com/a">x</a>`],
    ["blob:", `<a href="blob:https://site.com/uuid">x</a>`],
    ["sms:", `<a href="sms:+1234">x</a>`],
  ])("skips %s", (_, html) => {
    expect(extractLinks(html, "https://site.com/")).toEqual([]);
  });

  it("skips relative hrefs when <base href> points at a non-http scheme", () => {
    expect(extractLinks(`<base href="ftp://files.example.com/"><a href="a">x</a>`, "https://site.com/")).toEqual([]);
  });

  it("keeps http and https links", () => {
    const links = extractLinks(`<a href="http://a.com/">a</a><a href="HTTPS://b.com/">b</a>`, "https://site.com/");
    expect(links.map((l) => l.href)).toEqual(["http://a.com/", "https://b.com/"]);
  });
});

describe("extractLinks -- anchor text offsets", () => {
  it("reads each anchor's text correctly after characters whose lowercase form is longer", () => {
    const html = `\u0130\u0130\u0130\u0130<a href="/one">One</A><a href="/two">Two</a >`;
    const links = extractLinks(html, "https://site.com/");
    expect(links.map((l) => l.text)).toEqual(["One", "Two"]);
  });

  it("decodes entities in an href once", () => {
    const links = extractLinks(`<a href="/s?q=a&amp;amp;b">x</a>`, "https://site.com/");
    expect(links[0]?.href).toBe("https://site.com/s?q=a&amp;b");
  });
});

describe("extractLinks -- quotes outside quoted values", () => {
  it("finds the links after an anchor with an apostrophe in an unquoted attribute", () => {
    const html = `<a href=/a title=Bob's>A</a><a href="/b">B</a>`;
    const links = extractLinks(html, "https://site.com/");
    expect(links.map((l) => [l.href, l.text])).toEqual([
      ["https://site.com/a", "A"],
      ["https://site.com/b", "B"],
    ]);
  });
});

describe("extractLinks -- unquoted values ending in a slash", () => {
  it("keeps the trailing slash of an unquoted href", () => {
    const links = extractLinks(
      `<a href=/blog/>Blog</a><a href=https://x.com/a/>X</a><a href="/q/" />`,
      "https://site.com/",
    );
    expect(links.map((l) => l.href)).toEqual(["https://site.com/blog/", "https://x.com/a/", "https://site.com/q/"]);
  });
});

describe("extractLinks -- unclosed anchors", () => {
  it("ends an anchor's text at its </a> or at the next <a>, as a browser does", () => {
    const links = extractLinks(`<a href="/a">A <a href="/b">B</a> tail <a href="/c">C`, "https://site.com/");
    expect(links.map((l) => l.text)).toEqual(["A", "B", ""]);
  });

  it("handles many anchors sharing one far-off </a>, and text full of <, in linear time", () => {
    const t0 = performance.now();
    expect(extractLinks(`${"<a href=http://x/>t".repeat(100_000)}</a>`, "http://x/")).toHaveLength(100_000);
    const [only] = extractLinks(`<a href=http://x/>${"<".repeat(1_000_000)}</a>`, "http://x/");
    expect(only?.text).toBe("<".repeat(1_000_000));
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("handles a page of unclosed anchors in linear time", () => {
    // Searching for </a> afresh from every anchor read to the end each time:
    // 2 MB took 58 s.
    const t0 = performance.now();
    const links = extractLinks('<a href="https://e.com/x">t '.repeat(100_000), "https://e.com/");
    expect(links).toHaveLength(100_000);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("extractLinks -- an anchor with no </a> after it", () => {
  it("has no text, rather than the rest of the page", () => {
    const html = `<a href="/one">One</a><a href="/last">Last<p>footer</p><script>var secret = 1;</script></body></html>`;
    const links = extractLinks(html, "https://site.com/");
    expect(links.map((l) => [l.href, l.text])).toEqual([
      ["https://site.com/one", "One"],
      ["https://site.com/last", ""],
    ]);
  });
});
