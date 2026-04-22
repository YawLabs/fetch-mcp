import { describe, expect, it } from "vitest";
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
