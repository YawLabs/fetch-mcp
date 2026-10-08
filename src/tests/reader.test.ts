import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANCELLED } from "../http.js";
import { createFetchServer } from "../server.js";
import { extractByline, extractTitle, isolateMainContent } from "../tools/reader.js";

describe("extractTitle", () => {
  it("prefers og:title over <title>", () => {
    const html = `
      <head>
        <meta property="og:title" content="The Real Title">
        <title>Fallback Title</title>
      </head>
    `;
    expect(extractTitle(html)).toBe("The Real Title");
  });

  it("reads og:title when content comes before property", () => {
    const html = `<meta content="Reverse Order" property="og:title">`;
    expect(extractTitle(html)).toBe("Reverse Order");
  });

  it("falls back to <title> with whitespace collapsed", () => {
    const html = "<title>Hello\n   World</title>";
    expect(extractTitle(html)).toBe("Hello World");
  });

  it("falls back to <h1> when no title or og", () => {
    const html = "<body><h1>My Heading <span>!</span></h1></body>";
    expect(extractTitle(html)).toBe("My Heading !");
  });

  it("decodes HTML entities in titles", () => {
    const html = "<title>A &amp; B &#39;live&#39;</title>";
    expect(extractTitle(html)).toBe("A & B 'live'");
  });

  it("returns undefined for content without any title signal", () => {
    const html = "<p>just some text</p>";
    expect(extractTitle(html)).toBeUndefined();
  });
});

describe("extractByline", () => {
  it("reads meta name=author", () => {
    const html = `<meta name="author" content="Jeff Yaw">`;
    expect(extractByline(html)).toBe("Jeff Yaw");
  });

  it("falls back to article:author", () => {
    const html = `<meta property="article:author" content="Jane Doe">`;
    expect(extractByline(html)).toBe("Jane Doe");
  });

  it("returns undefined when no byline", () => {
    expect(extractByline("<p>body</p>")).toBeUndefined();
  });
});

describe("isolateMainContent", () => {
  it("extracts <article> body", () => {
    const html = `
      <nav>menu</nav>
      <article>
        <h1>Story</h1>
        <p>This is a long paragraph with more than two hundred characters, which is the minimum length we require before we accept a candidate block as the main content of the page. Without this threshold short navigation-style articles could hijack the extraction.</p>
      </article>
      <footer>copyright</footer>
    `;
    const content = isolateMainContent(html);
    expect(content).toContain("<h1>Story</h1>");
    expect(content).not.toContain("menu");
    expect(content).not.toContain("copyright");
  });

  it("extracts <main> when <article> is absent", () => {
    const html = `
      <header>site header</header>
      <main>
        <p>The long text of the main content block sits here, exceeding the minimum length of two hundred characters so that the extractor picks it as the primary body rather than falling through to the body or another candidate.</p>
      </main>
      <footer>bye</footer>
    `;
    const content = isolateMainContent(html);
    expect(content).toContain("main content block");
    expect(content).not.toContain("site header");
  });

  it("uses itemprop=articleBody", () => {
    const html = `
      <div itemprop="articleBody">
        <p>The article body element sits deep inside the page and uses the schema.org hint that tells readers which element is the main narrative. The block needs more than two hundred characters to beat the length threshold for a legitimate extraction.</p>
      </div>
    `;
    const content = isolateMainContent(html);
    expect(content).toContain("schema.org hint");
  });

  it("uses CMS class names like entry-content", () => {
    const html = `
      <div class="entry-content single">
        <p>A WordPress-style wrapper class identifies the main content. This paragraph needs more than two hundred characters in total to beat the threshold so that the extractor selects it and not the body fallback lower down the chain of candidates.</p>
      </div>
    `;
    const content = isolateMainContent(html);
    expect(content).toContain("WordPress-style wrapper");
  });

  it("falls back to <body> when no article/main/articleBody", () => {
    const html = "<body><p>Just body text.</p></body>";
    const content = isolateMainContent(html);
    expect(content).toContain("Just body text.");
  });

  it("rejects very short <article> tags and tries next candidate", () => {
    const html = `
      <article>Short</article>
      <main>
        <p>The real content lives in <strong>main</strong>, not the dummy article tag at the top of the document. This paragraph is intentionally long so it exceeds the two-hundred-character threshold that guards against short decoys.</p>
      </main>
    `;
    const content = isolateMainContent(html);
    expect(content).toContain("real content");
    expect(content).not.toContain("Short");
  });

  it("picks the longest <article> when multiple cards exist", () => {
    const shortCard =
      "<p>Card 1. Has enough padding text to barely squeeze past the two hundred character minimum that otherwise filters short navigation style decoys. Short intro only.</p>";
    const longArticle =
      "<p>The real article body is substantially longer than any single card preview and carries the full narrative that a reader would want extracted. It comfortably clears the two-hundred-character threshold and represents the true main content of the page.</p><p>With a second paragraph to make the length difference obvious.</p>";
    const html = `
      <section>
        <article>${shortCard}</article>
        <article>${shortCard}</article>
      </section>
      <article>${longArticle}</article>
    `;
    const content = isolateMainContent(html);
    expect(content).toContain("real article body");
    expect(content).not.toContain("Card 1.");
  });

  it("handles nested <article> tags without truncating at the inner closer", () => {
    const html = `
      <article>
        <h1>Outer</h1>
        <article>
          <p>This is an embedded card article whose closing tag must not be treated as the outer article's closer. The page should still extract the outer body in full including this nested piece as part of its content.</p>
        </article>
        <p>Trailing paragraph of the outer article that lives after the nested article closes. The block needs to be more than two hundred characters so the candidate passes the length threshold.</p>
      </article>
    `;
    const content = isolateMainContent(html);
    expect(content).toContain("Outer");
    expect(content).toContain("Trailing paragraph");
    expect(content).toContain("embedded card article");
  });
});

describe("extractTitle / extractByline -- attribute values are decoded once", () => {
  it("does not decode og:title a second time", () => {
    expect(extractTitle(`<meta property="og:title" content="a &amp;lt;b&amp;gt;">`)).toBe("a &lt;b&gt;");
  });

  it("does not decode the author a second time", () => {
    expect(extractByline(`<meta name="author" content="A &amp;amp; B">`)).toBe("A &amp; B");
    expect(extractByline(`<meta property="article:author" content="A &amp;amp; B">`)).toBe("A &amp; B");
  });
});

describe("reader -- linear time on unclosed and nested containers", () => {
  it("extracts no title from a page of unclosed <title>s, quickly", () => {
    const t0 = performance.now();
    expect(extractTitle("<title>x ".repeat(200_000))).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("reads the first <title> up to its close", () => {
    expect(extractTitle("<title>One</title ><title>Two</title>")).toBe("One");
  });

  it("isolates nothing from a page of unclosed matching containers, quickly", () => {
    const html = `<body>${'<div class="post-content">'.repeat(100_000)}</body>`;
    const t0 = performance.now();
    isolateMainContent(html);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("picks the outermost of nested matching containers, quickly", () => {
    const n = 20_000;
    const body = "word ".repeat(100);
    const html = `${'<div class="entry-content">'.repeat(n)}${body}${"</div>".repeat(n)}`;
    const t0 = performance.now();
    const out = isolateMainContent(html);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(out.startsWith('<div class="entry-content">')).toBe(true);
    expect(out.length).toBe(html.length - '<div class="entry-content">'.length - "</div>".length);
  });

  it("still finds an itemprop=articleBody container", () => {
    const text = "Body text. ".repeat(30);
    const html = `<div class="x">nav</div><section itemprop="articleBody"><p>${text}</p></section>`;
    expect(isolateMainContent(html)).toBe(`<p>${text}</p>`);
  });
});

describe("reader -- container attributes are read parsed", () => {
  it("finds a CMS container by class token, and not by text inside another attribute", () => {
    const text = "Body text. ".repeat(30);
    expect(isolateMainContent(`<div class="wrap entry-content x"><p>${text}</p></div>`)).toBe(`<p>${text}</p>`);
    const decoy = `<div title='class="post-content"'><p>${text}</p></div><body>fallback</body>`;
    expect(isolateMainContent(decoy)).toBe("fallback");
  });

  it("reads a long class-like run in linear time", () => {
    // `class="` closes the a="..." value, so the CMS names after it are bare
    // attribute names. Through 0.8.3 a regex over the raw attribute text read
    // them as a class value and retried every name to the end of the tag.
    const text = "word ".repeat(100);
    const t0 = performance.now();
    const out = isolateMainContent(
      `<body><div a="x class=" ${"post-content ".repeat(20_000)}>${text}</div><p>fallback</p></body>`,
    );
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(out).toContain("fallback");
    // A real long class value is one attribute, tested once.
    const t1 = performance.now();
    expect(isolateMainContent(`<div class="${"x ".repeat(200_000)}post-content">${text}</div>`)).toBe(text);
    expect(performance.now() - t1).toBeLessThan(5_000);
  });
});

describe("reader -- tags inside hidden text are not tags", () => {
  const text = "Body text. ".repeat(30);
  const secret = `SECRET${"s".repeat(300)}`;

  it("does not open an <article> written in a script", () => {
    const html = `<body><script>var t="<article>"; var k="${secret}";</script><p>${text}</p></article></body>`;
    const out = isolateMainContent(html);
    // The slice is the whole <body>, script element and all, never one that starts inside the script.
    expect(out).toBe(html.slice("<body>".length, -"</body>".length));
  });

  it.each([
    ["a comment", `<!-- <article> ${secret} --></article><main><p>${text}</p></main>`],
    ["a template", `<template><article>${secret}</article></template><main><p>${text}</p></main>`],
    ["a style", `<style>/* <article> */ .x{content:"${secret}"}</style></article><main><p>${text}</p></main>`],
    ["a noscript", `<noscript><article>${secret}</article></noscript><main><p>${text}</p></main>`],
  ])("ignores an <article> in %s", (_, html) => {
    expect(isolateMainContent(html)).toBe(`<p>${text}</p>`);
  });

  it("does not close an <article> on a </article> written in a script", () => {
    const html = `<article><p>${text}</p><script>var s="</article>";</script><p>more</p></article>`;
    expect(isolateMainContent(html)).toBe(`<p>${text}</p><script>var s="</article>";</script><p>more</p>`);
  });

  it("reads the title and byline from rendered tags only", () => {
    const html =
      `<script>"<meta property=og:title content=Evil><title>Evil</title>"</script>` +
      `<!-- <meta name=author content=Evil> --><meta name=author content=Real><title>Real</title>`;
    expect(extractTitle(html)).toBe("Real");
    expect(extractByline(html)).toBe("Real");
    expect(extractTitle(`<template><h1>Evil</h1></template><h1>Real</h1>`)).toBe("Real");
  });

  it("matches whole tag names and end tags with attributes", () => {
    expect(isolateMainContent(`<article-list><p>${text}</p></article-list><body>fallback</body>`)).toBe("fallback");
    expect(isolateMainContent(`<article><p>${text}</p></article class=x><p>after</p>`)).toBe(`<p>${text}</p>`);
  });
});

describe("fetch_reader -- hostile pages, through the tool (Launch-critical #22)", () => {
  // Through 0.8.3 the markdown step parsed the page in one synchronous call:
  // a 1,200-deep page threw a stack overflow that fetch_reader did not catch, and neither the
  // budget nor cancellation could stop a slow parse.
  let fixture: Server;
  let base: string;
  let page = "";

  beforeAll(async () => {
    fixture = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(page);
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", () => done()));
    base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    fixture.closeAllConnections();
    await new Promise<void>((done) => fixture.close(() => done()));
  });

  const call = async (input: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) => {
    const tools = (
      createFetchServer({ allowPrivateHosts: true }) as unknown as {
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
    )._registeredTools;
    return tools.fetch_reader!.handler({ url: `${base}/page`, allow_private_hosts: true, ...input }, { signal });
  };

  it("returns the depth error for a 1,200-deep page instead of throwing", async () => {
    page = `<html><body>${"<div>".repeat(1200)}x${"</div>".repeat(1200)}</body></html>`;
    const out = await call({});
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("page nests elements");
  });

  it("a call cancelled while it converts a hostile page returns the cancelled error", async () => {
    page = `<html><body>${"<ul><li>".repeat(20_000)}x</body></html>`;
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 300);
    const t0 = performance.now();
    const out = await call({}, cancel.signal);
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain(CANCELLED);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it("the conversion stops at timeout_ms", async () => {
    page = `<html><body>${"<ul><li>".repeat(20_000)}x</body></html>`;
    const t0 = performance.now();
    const out = await call({ timeout_ms: 500 });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("exceeded its 500 ms budget");
    expect(performance.now() - t0).toBeLessThan(2_500);
  });
});

describe("extractTitle -- only an HTML <title> is the page title", () => {
  it.each([
    ["an SVG <title>", "<html><body><svg><title>Logo</title></svg><p>x</p></body></html>"],
    [
      "an SVG <title> whose RCDATA reading runs past the svg",
      "<body><svg><title>Logo</svg><template>SECRET</template><!-- SECRET2 --><p>x</p></title>",
    ],
    ["a MathML <title>", "<body><math><mi><title>T<!--SECRET--></title></mi></math>"],
    ["a <title> a <select> ignores", "<body><select><title><template>SECRET</template></title></select>"],
  ])("reads no title from %s", (_, html) => {
    expect(extractTitle(html)).toBeUndefined();
  });

  it("reads the HTML <title> after an SVG one", () => {
    expect(extractTitle("<body><svg><title>Logo</title></svg><title>Real</title>")).toBe("Real");
    // An unclosed SVG <title> holds the rest of the page (as a browser reads
    // it too: `</svg>` is ignored inside it), and its content is hidden.
    expect(extractTitle("<body><svg><title>Logo</svg><h1>Head</h1>")).toBeUndefined();
  });
});

describe("reader -- containers are paired without a record per opener", () => {
  it("isolates a 4 MiB page of unclosed <div>s quickly", () => {
    const html = "<div>".repeat(800_000);
    const t0 = performance.now();
    expect(isolateMainContent(html)).toBe(html);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("picks the longest trimmed outermost article, the first of equals", () => {
    const a = "a".repeat(250);
    const b = "b".repeat(300);
    const c = "c".repeat(300);
    const html = `<article>  ${a}  </article><article>\n${b}<article>${a}</article>\n</article><article>${c}</article>`;
    expect(isolateMainContent(html)).toBe(`${b}<article>${a}</article>`);
  });

  it("picks itemprop=articleBody before a CMS class, each the longest", () => {
    const t = "t".repeat(250);
    const html =
      `<div class="post-content">${t}${t}</div><section itemprop=articleBody>${t}</section>` +
      `<div itemprop=ArticleBody>${t}x</div>`;
    expect(isolateMainContent(html)).toBe(`${t}x`);
    expect(isolateMainContent(`<div class="post-content">${t}</div><div itemprop=articleBody>short</div>`)).toBe(t);
  });
});
