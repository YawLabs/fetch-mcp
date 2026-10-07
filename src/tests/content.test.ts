import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANCELLED } from "../http.js";
import { createFetchServer } from "../server.js";
import { stripHtmlToText } from "../tools/content.js";

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

describe("stripHtmlToText -- end tags and sanitization (CodeQL #1-#5, #8)", () => {
  it.each([
    ["a space before the >", "a<script>secret()</script >b"],
    ["a newline before the >", "a<script>secret()</script\n>b"],
    ["upper case and junk in the end tag", "a<SCRIPT>secret()</Script foo>b"],
    ["a slash in the end tag", "a<script>secret()</script/>b"],
  ])("drops script content when the end tag has %s", (_, html) => {
    expect(stripHtmlToText(html)).toBe("ab");
  });

  it("drops style and noscript content the same way", () => {
    expect(stripHtmlToText("a<style>.secret{}</style >b<noscript>secret</NOSCRIPT\t>c")).toBe("abc");
  });

  it("drops everything after a script with no end tag, as a browser does", () => {
    expect(stripHtmlToText("a<script>secret(); <p>still script</p>")).toBe("a");
  });

  it("does not splice a new tag together out of the pieces around a removed one", () => {
    // A browser reads `<scr<script>` as one tag named "scr<script", so what
    // follows is page text there too; the point is that no `<script` survives.
    expect(stripHtmlToText("a<scr<script>x</script>ipt>alert(1)</script>b")).toBe("axipt>alert(1)b");
  });

  it("drops comments, including unclosed ones and the --!> and <!--> forms", () => {
    expect(stripHtmlToText("a<!-- secret -->b<!-- secret --!>c<!-->d<!--->e<!-- secret")).toBe("abcde");
  });

  it("drops a tag cut off by the end of the input", () => {
    expect(stripHtmlToText("text<a href='x")).toBe("text");
  });

  it("ends a line on block end tags written with whitespace or in upper case", () => {
    expect(stripHtmlToText("<p>one</p ><DIV>two</DIV>three")).toBe("one\ntwo\nthree");
  });

  it("decodes entities once, after the tags are gone", () => {
    expect(stripHtmlToText("a &amp;lt;b&amp;gt; c")).toBe("a &lt;b&gt; c");
  });

  it("decodes numeric entities", () => {
    expect(stripHtmlToText("it&#8217;s &#x2014; &#X41;")).toBe("it\u2019s \u2014 A");
  });
});

// The regex chain these replaced already passed each case here; they pin
// that the tokenizer keeps it, and are not part of the CodeQL fixes above.
describe("stripHtmlToText -- behaviour kept from the regex version", () => {
  it("drops script content when the start tag has an attribute holding a quoted >", () => {
    expect(stripHtmlToText(`a<script data-x="</b>">secret()</script>b`)).toBe("ab");
  });

  it("does not end a script on a longer tag name that starts with script", () => {
    expect(stripHtmlToText("a<script>x = '</scripts>'; secret()</script>b")).toBe("ab");
  });

  it("keeps the content of an element whose name only starts with script", () => {
    expect(stripHtmlToText("<scripts>kept</scripts>")).toBe("kept");
  });

  it("drops a doctype, processing instructions and CDATA", () => {
    expect(stripHtmlToText("<!DOCTYPE html><?xml version='1.0'?>a<![CDATA[secret]]>b")).toBe("ab");
  });

  it("keeps a < that does not start a tag", () => {
    expect(stripHtmlToText("a < b and c<3")).toBe("a < b and c<3");
  });

  it("decodes an escaped tag to text, not markup", () => {
    expect(stripHtmlToText("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>");
  });

  it("keeps indices straight around characters whose lowercase form is longer", () => {
    expect(stripHtmlToText("\u0130\u0130<SCRIPT>secret()</SCRIPT>ok")).toBe("\u0130\u0130ok");
  });
});

describe("stripHtmlToText -- tokenizer edge cases", () => {
  it.each([
    ["an attribute name", "<p a'b><script>' >secret()</script>after"],
    ["an unquoted value", "<div title=it's><style>' >.secret{}</style>after"],
    ["an unquoted alt before a comment", "<img alt=Bob's><!--' >secret-->after"],
  ])("treats a quote inside %s as a plain character", (_, html) => {
    expect(stripHtmlToText(html)).toBe("after");
  });

  it("keeps the page after a tag with an apostrophe in an unquoted value", () => {
    expect(stripHtmlToText(`<p>Don't <b class=it's>bold</b> keep going</p><p>Final: we're done.</p>`)).toBe(
      "Don't bold keep going\nFinal: we're done.",
    );
  });

  it("still skips a > inside a quoted value", () => {
    expect(stripHtmlToText(`a<span title="x > y" data-z='<script>'>b</span>c`)).toBe("abc");
  });

  it("keeps markup inside title, textarea and xmp as text", () => {
    expect(stripHtmlToText("<title>How to use <script> tags</title><p>Body text</p>")).toBe(
      "How to use <script> tags\nBody text",
    );
    expect(stripHtmlToText("<textarea>Example: <style> body{} </TEXTAREA ><p>Visible</p>")).toBe(
      "Example: <style> body{}\nVisible",
    );
  });

  it("drops iframe, noembed and noframes fallback content", () => {
    expect(stripHtmlToText("a<iframe>secret</iframe>b<noembed>secret</noembed>c<noframes>secret</noframes>d")).toBe(
      "abcd",
    );
  });

  it("does not end a script at the </script> of a <script> nested in <!-- -->", () => {
    expect(stripHtmlToText("<script>document.write('<!--<script>x</script>');secret()</script>tail")).toBe("tail");
  });

  it("ends a script at its first </script> once a <!-- in it is closed", () => {
    expect(stripHtmlToText("<script><!-- x --></script>after<!-- c -->")).toBe("after");
    expect(stripHtmlToText("<script><!--></script>after")).toBe("after");
  });

  it("strips a large page of short comments in linear time", () => {
    // commentEnd once searched to the end of the input for each kind of
    // comment end, per comment: 40 KB took 0.5 s and 320 KB took 66 s.
    const html = "<!--a-->x".repeat(200_000);
    const t0 = performance.now();
    expect(stripHtmlToText(html)).toBe("x".repeat(200_000));
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("strips a large page of short scripts and unclosed tags in linear time", () => {
    const t0 = performance.now();
    expect(stripHtmlToText("<script>a</script>x".repeat(200_000))).toBe("x".repeat(200_000));
    expect(stripHtmlToText("<script><!--a</script>x".repeat(200_000))).toBe("x".repeat(200_000));
    expect(stripHtmlToText("<script><!--<script>a</script>-->b</script>x".repeat(100_000))).toBe("x".repeat(100_000));
    expect(stripHtmlToText(`${"<p a=b ".repeat(200_000)}`)).toBe("");
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- self-closing and foreign content", () => {
  it.each([
    ["<script/>", "<p>a</p><script/>var SECRET=1</script><p>b</p>", "a\nb"],
    ["<script src=x />", `<p>a</p><script src="x.js" /><p>HIDDEN</p></script><p>b</p>`, "a\nb"],
    ["<style/>", "<style/>body{SECRET}</style>ok", "ok"],
    ["<noscript/>", "<noscript/>SECRET</noscript>ok", "ok"],
    ["<iframe/>", "<iframe/>SECRET</iframe>ok", "ok"],
  ])("ignores the self-closing flag on %s, as a browser does", (_, html, text) => {
    expect(stripHtmlToText(html)).toBe(text);
  });

  it.each(["svg", "math"])("reads <!-- --> inside <%s><style> as a comment, not raw text", (root) => {
    expect(stripHtmlToText(`<${root}><style><!--</style><p>HIDDEN</p>--></style></${root}>ok`)).toBe("ok");
  });

  it("drops the text of SVG script and style elements", () => {
    expect(stripHtmlToText("<svg><style>.a{fill:red}</style><script>secret()</script><text>Label</text></svg>ok")).toBe(
      "Labelok",
    );
  });

  it("keeps SVG and MathML text, and drops CDATA there", () => {
    expect(stripHtmlToText("<svg><text>x<![CDATA[ < y]]></text></svg> and <math><mi>z</mi></math>")).toBe("x and z");
  });

  it("goes back to HTML rules inside an integration point", () => {
    expect(stripHtmlToText("<svg><foreignObject><style>.secret{}</style>Inside</foreignObject></svg>ok")).toBe(
      "Insideok",
    );
  });

  it("leaves foreign content at an HTML breakout tag", () => {
    expect(stripHtmlToText("<svg><style>x{}</style><p>Visible</p><style>.secret{}</style>after")).toBe(
      "Visible\nafter",
    );
  });

  it("handles deep and unbalanced foreign nesting in linear time", () => {
    const t0 = performance.now();
    expect(stripHtmlToText(`${"<svg>".repeat(100_000)}${"</g>".repeat(100_000)}x`)).toBe("x");
    expect(stripHtmlToText(`<svg><mi>${"<svg>".repeat(100_000)}${"</mi>".repeat(100_000)}x`)).toBe("x");
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- trailing blanks", () => {
  it("strips blanks before a newline and keeps them between words", () => {
    expect(stripHtmlToText("a  \t\nb c")).toBe("a\nb c");
  });

  it("handles a long run of blanks in linear time", () => {
    // /[ \t]+\n/g retried at every blank: 80 KB of spaces took 20-40 s.
    const t0 = performance.now();
    expect(stripHtmlToText(`x${" ".repeat(2_000_000)}y`)).toBe(`x${" ".repeat(2_000_000)}y`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- foreign content, round 3", () => {
  it("keeps an SVG <style> hidden to its own end tag, whatever HTML appears inside it", () => {
    // A browser would let <font color> or <p> break out of the SVG here; the
    // scanner does not model that, and hides rather than shows.
    expect(stripHtmlToText(`<svg><style><font title=" size=1">SECRET</style></svg>after`)).toBe("after");
    expect(stripHtmlToText("<svg><style><font color>text</font></style></svg>after")).toBe("after");
  });

  it("closes an integration point and the <svg> around it once its HTML is closed", () => {
    expect(stripHtmlToText("<svg><foreignObject><span>in</span></foreignObject></svg><p>out</p>")).toBe("inout");
    expect(stripHtmlToText("<svg><foreignObject>in</svg><style>.x{}</style>out")).toBe("inout");
  });

  it("drops CDATA in SVG and MathML, which HTML would read as a bogus comment", () => {
    // SVG reads <![CDATA[...]]> as text; inside an integration point or after
    // a breakout a browser reads it as a comment. The scanner hides it.
    expect(stripHtmlToText("<svg><title><![CDATA[Revenue chart]]></title></svg>ok")).toBe("ok");
    expect(stripHtmlToText("<p><svg><use href='#i'/></p><![CDATA[SECRET]]><p>after")).toBe("after");
    expect(stripHtmlToText("<svg><b><![CDATA[SECRET]]></b></svg>after")).toBe("after");
  });

  it("treats annotation-xml as an integration point only with an HTML encoding", () => {
    // The scan does not read the encoding: a comment that runs across the
    // script's HTML end tag desynchronizes the readings, and the rest is hidden.
    expect(
      stripHtmlToText("<math><annotation-xml><script><!--</script>SECRET--></script></annotation-xml></math>ok"),
    ).toBe("");
    expect(
      stripHtmlToText(
        `<math><annotation-xml encoding="text/html"><style>.secret{}</style>Shown</annotation-xml></math>`,
      ),
    ).toBe("Shown");
  });

  it("drops <template> content, nested or not", () => {
    expect(stripHtmlToText("<template>SECRET<template>more</template>still</template>visible")).toBe("visible");
    expect(stripHtmlToText("<template><p>SECRET</p></template><p>visible</p>")).toBe("visible");
  });

  it("handles deep HTML nesting inside an integration point in linear time", () => {
    const t0 = performance.now();
    const html = `<svg><foreignObject>${"<span>".repeat(100_000)}${"</b>".repeat(100_000)}x`;
    expect(stripHtmlToText(html)).toBe("x");
    expect(stripHtmlToText(`<svg><foreignObject>${"<div><span>".repeat(50_000)}${"</span>".repeat(100_000)}y`)).toBe(
      "y",
    );
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- HTML end tags around unclosed foreign content, round 4", () => {
  it.each([
    ["noscript", "<div><svg></div><noscript>SECRET</noscript>after"],
    ["iframe", "<b><svg></b><iframe>SECRET</iframe>after"],
    ["script", `<div><svg></div><script>var s="<b>"+SECRET</script>after`],
    ["template", "<span><svg></span><template>SECRET</template>after"],
  ])("closes an unclosed <svg> with its HTML parent, so a following %s is hidden again", (_, html) => {
    expect(stripHtmlToText(html)).toBe("after");
  });

  it("closes an <svg> inside a <template> with the template", () => {
    expect(stripHtmlToText("<template><svg><path></template><p>after</p>")).toBe("after");
    expect(stripHtmlToText("<template><svg><template>x</template>still hidden</template><p>after</p>")).toBe("after");
  });

  it("hides rather than shows when an SVG <style> is never closed", () => {
    // A browser ends it at </div>; the scanner keeps it hidden to the end.
    expect(stripHtmlToText("<div><svg><style>SECRET</div>after")).toBe("");
  });

  it("closes a <template> whatever is left open inside it", () => {
    expect(stripHtmlToText("<ul><li><template><li>Row</template></ul><p>Main text</p>")).toBe("Main text");
    expect(stripHtmlToText("<template><table><tr><td>{{a}}<td>{{b}}</template><p>Main</p>")).toBe("Main");
    expect(
      stripHtmlToText(`<template x-if="open"><div class="modal"><p>Text</div></template><main><p>AFTER</p></main>`),
    ).toBe("AFTER");
    expect(stripHtmlToText("<template><math><mi><mrow></template><p>Main</p>")).toBe("Main");
  });

  it("hides HTML raw-text elements inside an unclosed <svg> or <math>", () => {
    expect(stripHtmlToText("<li><p><svg></li><iframe>SECRET</iframe>after")).toBe("after");
    expect(stripHtmlToText("<table><tr><td><svg></table><noscript>SECRET</noscript>after")).toBe("after");
    expect(stripHtmlToText("<div><p>a<svg><g></div><template>SECRET</template>after")).toBe("a\nafter");
    expect(stripHtmlToText("<svg><desc><span>d</desc><iframe>SECRET</iframe></svg>after")).toBe("dafter");
  });

  it("leaves foreign content open on an end tag that closes nothing", () => {
    expect(stripHtmlToText("<div><svg><style></x>SECRET</style></svg>after</div>")).toBe("after");
    expect(stripHtmlToText("<svg><style></div>SECRET</style></svg>after")).toBe("after");
  });

  it("does not close an HTML element past a special one", () => {
    // </b> meets the open <div> first: ignored in a browser, so the <svg> stays open.
    expect(stripHtmlToText("<b><div><svg><style></b>SECRET</style></svg>after")).toBe("after");
  });

  it("handles many end tags against deep foreign nesting in linear time", () => {
    const t0 = performance.now();
    expect(stripHtmlToText(`<div>${"<svg><g>".repeat(50_000)}${"</x>".repeat(100_000)}</div>x`)).toBe("x");
    expect(stripHtmlToText(`${"<span>".repeat(50_000)}<svg>${"</b>".repeat(100_000)}y`)).toBe("y");
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- island end tags inside hidden elements, round 6", () => {
  it.each([
    ["foreignObject style", "<svg><foreignObject><style>a</svg>SECRET</style></foreignObject></svg>V"],
    ["foreignObject script", `<svg><foreignObject><script>x="</svg>";SECRET</script></foreignObject></svg>V`],
    ["desc style", "<svg><desc><style>a</svg>SECRET</style></desc></svg>V"],
    ["mi style", "<math><mi><style>a</math>SECRET</style></mi></math>V"],
    ["mtext script", "<math><mtext><script>a</math>SECRET</script></mtext></math>V"],
    ["breakout style", "<svg><p><style>a</svg>SECRET</style>V"],
    ["breakout script", "<svg><img src=x><script>var s='</svg>';SECRET</script>V"],
    ["template inside", "<template><svg><style></template>SECRET</style></svg></template>V"],
  ])("keeps a hidden element hidden past a </svg> or </math> inside it (%s)", (_, html) => {
    expect(stripHtmlToText(html)).not.toContain("SECRET");
    expect(stripHtmlToText(html).endsWith("V")).toBe(true);
  });

  it("keeps the script that follows an unclosed inline icon hidden", () => {
    const html = `<p>Hi</p><svg viewBox="0 0 10 10"><path d="M0 0"></g><p>Article text</p><script>var k="SECRET"; s = svg.replace("</svg>", ""); var t="SECRET2";</script><p>Footer</p>`;
    const out = stripHtmlToText(html);
    expect(out).not.toContain("SECRET");
    expect(out).toContain("Article text");
    expect(out).toContain("Footer");
  });
});

describe("stripHtmlToText -- self-closed hidden elements inside SVG / MathML, round 7", () => {
  it.each([
    [
      "script after an unclosed icon",
      `<div><svg viewBox="0 0 24 24"><path d="M0 0h24"/></div><script src="/a.js" />var k = "SECRET";</script><p>after</p>`,
    ],
    ["style after an unclosed icon", `<li><svg><use href="#i"/></li><style/>.hidden{} SECRET</style><li>after`],
    ["script after a breakout", "<svg><use href='#i'/><span>label</span><script src=x />SECRET</script></svg>after"],
    [
      "script in foreignObject",
      "<svg><foreignObject><div><script src=x />SECRET</script></div></foreignObject></svg>after",
    ],
    ["template in foreignObject", "<svg><foreignObject><template/>SECRET</template></foreignObject></svg>after"],
    ["iframe in foreignObject", "<svg><foreignObject><iframe src=x />SECRET</iframe></foreignObject></svg>after"],
    ["style after a breakout div", "<svg width=10><path d=x/><div>text<style/>SECRET</style>more</div>after"],
  ])("hides it to its end tag: %s", (_, html) => {
    const out = stripHtmlToText(html);
    expect(out).not.toContain("SECRET");
    expect(out.endsWith("after")).toBe(true);
  });
});

describe("stripHtmlToText -- island tracking, round 8", () => {
  it.each([
    ["an outer end tag over an open inner one", "<svg><style/><script></style>SECRET"],
    ["a template end tag over an open style", "<svg><template><b><style></template>SECRET"],
    ["a style end tag over a template", "<svg><style></svg><template></style>SECRET"],
    ["noscript under math", "<math><noscript/><script></noscript>SECRET"],
    ["a textarea holding </template>", "<template><svg><p><textarea></template>SECRET"],
    ["an xmp holding </template>", "<template><svg><foreignObject><xmp></template>SECRET"],
    ["a title holding </template>", "<template><svg><desc><title></template>SECRET"],
    ["an integration point inside a style", "<svg><style><title><p></style>SECRET"],
    ["foreignObject inside a style", "<svg><style><foreignObject><e></style>SECRET"],
    ["an svg nested in math", "<math><p><svg></math><style><!--</style>SECRET-->"],
    [
      "an svg end tag at HTML content",
      "<svg><foreignObject><div></svg></div></foreignObject><style><!--</style>SECRET--></style></svg>",
    ],
    ["a double-escaped script after a breakout", `<svg><p><script><a title="<!--<script>"></script>SECRET`],
    ["xmp in a select", "<select><xmp><script>SECRET</script></xmp>"],
    ["title in a select", "<select><title><script>SECRET</script></title>"],
    ["plaintext in a select", "<select><plaintext><script>SECRET</script>"],
  ])("keeps it hidden: %s", (_, html) => {
    expect(stripHtmlToText(html)).not.toContain("SECRET");
  });

  it("still reads ordinary SVG, MathML, templates and selects", () => {
    // An SVG <title> is a tooltip, and hidden like every raw-text or RCDATA name in an island.
    expect(stripHtmlToText("<svg><title>Chart</title><g><text>Label</text></g></svg><p>after</p>")).toBe("Labelafter");
    expect(stripHtmlToText("<template><math><mi><mrow></template><p>Main</p>")).toBe("Main");
    expect(stripHtmlToText("<select><option>One</option><option>Two</option></select><title>T</title>x")).toBe(
      "OneTwoT\nx",
    );
  });

  it("finds raw-text ends in linear time", () => {
    const t0 = performance.now();
    expect(stripHtmlToText(`<svg>${"<style></style>x".repeat(100_000)}</svg>`)).toBe("x".repeat(100_000));
    stripHtmlToText(`<svg><style>${"<script>".repeat(50_000)}${"<style>".repeat(50_000)}`);
    stripHtmlToText(`<template><svg>${"</template>".repeat(100_000)}`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- both readings hidden, round 9", () => {
  it("hides a template opened inside a style that a <select> ignores", () => {
    expect(stripHtmlToText("<select><style><template></Style>SECRET")).not.toContain("SECRET");
    expect(stripHtmlToText("<select><style>.a{}</style><option>One</option></select>after")).toBe("Oneafter");
  });

  it("reads CDATA as a bogus comment, so markup after its first > is read", () => {
    expect(stripHtmlToText("<SVG><body><![CDATA[><template ]]>SECRET")).not.toContain("SECRET");
    expect(stripHtmlToText("<svg><p><![CDATA[><script>]]>SECRET</script>after")).toBe("after");
  });

  it("finds raw-text ends inside a <select> in linear time", () => {
    const t0 = performance.now();
    stripHtmlToText(`<select>${"<style>".repeat(100_000)}x`);
    stripHtmlToText(`<select>${"<style>a".repeat(100_000)}</style>x`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- end tags inside SVG CDATA", () => {
  it.each([
    ["math script", "<math><script><![CDATA[></script>SECRET"],
    ["svg script", "<svg><SCRIPT><![CDATA[></SCRIPT>SECRET"],
    ["svg style", "<svg><style><![CDATA[></style>SECRET"],
    ["template around svg", "<template><svg><![CDATA[></template>SECRET"],
  ])("closes nothing before the CDATA ends (%s)", (_, html) => {
    expect(stripHtmlToText(html)).not.toContain("SECRET");
  });

  it("closes again once the CDATA has ended", () => {
    expect(stripHtmlToText("<svg><script><![CDATA[ x ]]></script></svg>after")).toBe("after");
  });

  it("finds CDATA ends in linear time", () => {
    // Each `<![CDATA[` searched to the end of the input for a `]]>` that is not there.
    const t0 = performance.now();
    stripHtmlToText(`<svg>${"<![CDATA[>".repeat(400_000)}`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("stripHtmlToText -- self-closed raw-text elements in plain SVG / MathML, round 10", () => {
  it.each([
    ["svg style", "<svg><style/><text>Label</text></svg>after", "Labelafter"],
    ["svg script", "<svg viewBox='0 0 1 1'><script href=a.js /><path d=x/></svg><p>after</p>", "after"],
    ["math noscript", "<math><noscript/><mi>x</mi></math>after", "xafter"],
  ])("reads it as an empty element, not raw text to the end of the page (%s)", (_, html, text) => {
    expect(stripHtmlToText(html)).toBe(text);
  });

  it.each([
    ["after a breakout", "<svg><p><style/>SECRET"],
    ["after an end tag that can leave the island", "<div><svg></div><style/>SECRET"],
    ["after an unmatched end tag", "<svg></g><script/>SECRET"],
    ["in an integration point", "<svg><desc><style/>SECRET"],
    ["in a MathML text integration point", "<math><mi><script/>SECRET"],
    ["back at the root after an integration point", "<svg><desc><p></desc><style/>SECRET"],
    ["in an svg inside a select", "<select><svg><style/>SECRET"],
    ["in a nested svg", "<svg><foreignObject><svg><style/>SECRET"],
    ["after a font", "<svg><font color=red><style/>SECRET"],
  ])("still hides what may be raw text to the end of the page: %s", (_, html) => {
    expect(stripHtmlToText(html)).not.toContain("SECRET");
  });
});

describe("stripHtmlToText -- end tags measured once", () => {
  it("measures a shared raw-text end tag inside a <select> once", () => {
    // Every <style> opener re-read the end tag's attributes, which never reach a `>`.
    const t0 = performance.now();
    stripHtmlToText(`<select>${"<style>".repeat(20_000)}</style ${"a ".repeat(50_000)}`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("measures each end tag once when openers of different names alternate", () => {
    // A single memo slot: <style> and <iframe> evicted each other's end tag,
    // so every opener re-read an unclosed quoted attribute to the end (14 s).
    const t0 = performance.now();
    const k = 16_000;
    expect(stripHtmlToText(`<select>${"<style><iframe>".repeat(k)}</style x="</iframe y="${"a".repeat(15 * k)}`)).toBe(
      "",
    );
    const five = "<style><iframe><noscript><noembed><noframes>";
    const ends = `</style a="</iframe b="</noscript c="</noembed d="</noframes e="`;
    expect(stripHtmlToText(`<select>${five.repeat(k)}${ends}${"a".repeat(15 * k)}`)).toBe("");
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("fetch_html_to_markdown -- hostile pages, through the tool (Launch-critical #22)", () => {
  // Through 0.8.3 the markdown step parsed the page in one synchronous call:
  // a 1,200-deep page threw a stack overflow, and neither the
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
    return tools.fetch_html_to_markdown!.handler(
      { url: `${base}/page`, allow_private_hosts: true, ...input },
      { signal },
    );
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

describe("stripHtmlToText -- a <template> inside a <select>", () => {
  it.each([
    ["a style", "<select><template><style></template>SECRET</style>SECRET2</template>after"],
    [
      "a self-closed style",
      "<select><template><Style title=\"x\"/></template><script x='</style>'>SECRET</template>after",
    ],
    ["an iframe", "<select><template><iframe></template>SECRET</iframe>SECRET2</template>after"],
  ])("reads %s in the template's content as raw text, as a browser does", (_, html) => {
    const out = stripHtmlToText(html);
    expect(out).not.toContain("SECRET");
    expect(out).toBe("after");
  });

  it("goes back to the select's reading when the template closes", () => {
    expect(stripHtmlToText("<select><template></template><style><template></style>SECRET")).toBe("");
    expect(stripHtmlToText("<select><option>A</option><template>x</template><option>B</option></select>C")).toBe("ABC");
  });
});

describe("stripHtmlToText -- raw-text readings in an island meet again, round 12", () => {
  it.each([
    ["a comment in an SVG <title> after a breakout", "<svg><b><title><!--</title><script>-->SECRET</script>"],
    ["a quoted attribute in an SVG <title>", '<svg><b><title><a x="</title><script>">SECRET</script>'],
    ["a comment in a MathML <xmp>", "<math><span><xmp><!--</xmp><template>-->SECRET"],
    ["a title closed again after the swallowed tags", "<svg><b><title><!--</title><script>--></title>SECRET</script>"],
    ["a tag across the end of CDATA", '<svg><script><![CDATA[ x> <a y="]]><script>">SECRET'],
    ["a tag across the end of CDATA in plain SVG", '<svg><g><![CDATA[ x> <a y="]]><script>">SECRET'],
    [
      "two scripts whose raw readings end apart",
      "<svg><script><!--x--!><b><script><!--</script><style>--></script></script>SECRET</style>",
    ],
  ])("hides the rest: %s", (_, html) => {
    expect(stripHtmlToText(html)).not.toContain("SECRET");
  });

  it.each([
    ["a table", "<svg><table><select></svg><svg><script/>SECRET"],
    ["a <p>", "<svg><p><select></svg><svg><script/>SECRET"],
    ["a <b>", "<svg><b><select></svg><svg><script/>SECRET"],
    ["a MathML table", "<math><table><select></math><svg><script/>SECRET"],
    ["a foreignObject", "<svg><foreignObject><select></foreignObject></svg><svg><script/>SECRET"],
    ["a desc, then a style", "<svg><desc><select></desc></svg><svg><style/>SECRET"],
  ])("tracks a <select> opened in an island after %s", (_, html) => {
    expect(stripHtmlToText(html)).not.toContain("SECRET");
  });

  it.each([
    ["a <title> after it", '<svg><select></svg><title><a x="</title><script>">SECRET</script>'],
    ["a second <select>", "<svg><select></svg><select><style><template></style>SECRET"],
    ["a style in a real select", '<select><style><a x="</style><script>">SECRET</script>'],
  ])("reads a select that may not be one both ways: %s", (_, html) => {
    expect(stripHtmlToText(html)).not.toContain("SECRET");
  });

  it("still reads SVG with CDATA styles and scripts, and closed titles", () => {
    expect(
      stripHtmlToText(
        "<svg><style><![CDATA[.a>b{fill:red}]]></style><script><![CDATA[if(a<b){x='y>'}]]></script><text>L</text></svg><p>after</p>",
      ),
    ).toBe("Lafter");
    expect(stripHtmlToText("<svg><title>T1</title><g><title>T2</title><text>L</text></g></svg>after")).toBe("Lafter");
    expect(stripHtmlToText("<svg><![CDATA[a<b]]><text>L</text></svg>after")).toBe("Lafter");
    expect(stripHtmlToText("<svg><style><!--</style><p>HIDDEN</p>--></style></svg>ok")).toBe("ok");
  });

  it("stays linear on many raw-text openers in an island", () => {
    const t0 = performance.now();
    stripHtmlToText(`<svg><b>${"<style>x</style><title>y</title><script>z</script>".repeat(30_000)}`);
    stripHtmlToText(`<select>${"<style><iframe>".repeat(50_000)}`);
    stripHtmlToText(`<svg><select></svg>${"<title><xmp>".repeat(50_000)}`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
