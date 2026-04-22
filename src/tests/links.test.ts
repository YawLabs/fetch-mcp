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
