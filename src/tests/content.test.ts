import { describe, expect, it } from "vitest";
import { makeTurndown, stripHtmlToText } from "../tools/content.js";

describe("makeTurndown", () => {
  const td = makeTurndown();

  it("converts basic HTML to markdown", () => {
    const html = "<h1>Title</h1><p>Hello <strong>world</strong>.</p>";
    const md = td.turndown(html);
    expect(md).toContain("# Title");
    expect(md).toContain("Hello **world**.");
  });

  it("renders headings with atx style", () => {
    const html = "<h1>One</h1><h2>Two</h2><h3>Three</h3>";
    const md = td.turndown(html);
    expect(md).toContain("# One");
    expect(md).toContain("## Two");
    expect(md).toContain("### Three");
  });

  it("renders unordered lists with dash bullets", () => {
    const html = "<ul><li>apple</li><li>banana</li><li>cherry</li></ul>";
    const md = td.turndown(html);
    expect(md).toMatch(/^-\s+apple/m);
    expect(md).toMatch(/^-\s+banana/m);
    expect(md).toMatch(/^-\s+cherry/m);
  });

  it("renders fenced code blocks", () => {
    const html = "<pre><code>const x = 1;\nconsole.log(x);</code></pre>";
    const md = td.turndown(html);
    expect(md).toMatch(/```[\s\S]*const x = 1;[\s\S]*```/);
  });

  it("preserves links", () => {
    const html = '<p>See <a href="https://example.com">example</a>.</p>';
    const md = td.turndown(html);
    expect(md).toContain("[example](https://example.com)");
  });

  it("strips script tags", () => {
    const html = "<p>before</p><script>alert('xss')</script><p>after</p>";
    const md = td.turndown(html);
    expect(md).not.toContain("alert");
    expect(md).toContain("before");
    expect(md).toContain("after");
  });

  it("strips style tags", () => {
    const html = "<style>body{color:red}</style><p>visible</p>";
    const md = td.turndown(html);
    expect(md).not.toContain("color:red");
    expect(md).toContain("visible");
  });

  it("strips noscript, iframe, svg, canvas", () => {
    const html = [
      "<noscript>no-js</noscript>",
      "<iframe src='x'></iframe>",
      "<svg><circle/></svg>",
      "<canvas></canvas>",
      "<p>kept</p>",
    ].join("");
    const md = td.turndown(html);
    expect(md).not.toContain("no-js");
    expect(md).not.toContain("iframe");
    expect(md).toContain("kept");
  });

  it("strips NAV, FOOTER, ASIDE", () => {
    const html = [
      "<nav>menu items</nav>",
      "<main><p>main content</p></main>",
      "<aside>sidebar</aside>",
      "<footer>copyright</footer>",
    ].join("");
    const md = td.turndown(html);
    expect(md).not.toContain("menu items");
    expect(md).not.toContain("sidebar");
    expect(md).not.toContain("copyright");
    expect(md).toContain("main content");
  });
});

describe("stripHtmlToText", () => {
  it("removes all HTML tags", () => {
    expect(stripHtmlToText("<p>hello <b>world</b></p>")).toBe("hello world");
  });

  it("strips script and style blocks with their contents", () => {
    const html = "<script>evil()</script><p>ok</p><style>x{}</style>";
    expect(stripHtmlToText(html)).toBe("ok");
  });

  it("strips HTML comments", () => {
    expect(stripHtmlToText("<p>a</p><!-- secret -->b")).not.toContain("secret");
  });

  it("strips noscript content", () => {
    expect(stripHtmlToText("<noscript>nojs</noscript>text")).toBe("text");
  });

  it("decodes common HTML entities", () => {
    const out = stripHtmlToText("a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#39;f&#39;");
    expect(out).toBe("a b & c <d> \"e\" 'f'");
  });

  it("converts block-level closing tags to newlines", () => {
    const html = "<p>one</p><p>two</p><p>three</p>";
    expect(stripHtmlToText(html)).toBe("one\ntwo\nthree");
  });

  it("converts br to newline", () => {
    expect(stripHtmlToText("line1<br>line2<br/>line3")).toBe("line1\nline2\nline3");
  });

  it("collapses 3+ consecutive newlines to exactly 2", () => {
    const html = "<p>a</p><p></p><p></p><p>b</p>";
    const out = stripHtmlToText(html);
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripHtmlToText("   \n<p>hello</p>\n   ")).toBe("hello");
  });

  it("handles a realistic-ish document", () => {
    const html = `
      <html><head><style>h1{}</style></head>
      <body>
        <h1>Title</h1>
        <p>First <b>paragraph</b> with &amp; entity.</p>
        <script>tracking();</script>
        <ul><li>Item 1</li><li>Item 2</li></ul>
        <!-- hidden -->
      </body></html>
    `;
    const out = stripHtmlToText(html);
    expect(out).toContain("Title");
    expect(out).toContain("First paragraph with & entity.");
    expect(out).toContain("Item 1");
    expect(out).toContain("Item 2");
    expect(out).not.toContain("tracking");
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("h1{}");
  });
});
