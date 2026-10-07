import { readdirSync, readFile, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import domino, { type DomElement } from "@mixmark-io/domino";
import { describe, expect, it, vi } from "vitest";
import { CANCELLED } from "../http.js";
import {
  ATTRS_PER_NODE,
  conversionSlots,
  countedTemplateDoc,
  type DocInternals,
  htmlToMarkdown,
  MAX_CONCURRENT_CONVERSIONS,
  MAX_INPUT_IN_FLIGHT,
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_INPUT,
  MAX_NODE_BUDGET,
  MAX_TAG_NAME_CHARS,
  MAX_TAG_NAMES,
  MIN_NODE_BUDGET,
  makeTurndown,
  NODE_BUDGET_CHARS,
  OUTPUT_FACTOR,
  OUTPUT_SLACK,
} from "../markdown.js";
import { ConversionDeadlineError, ConversionLimitError } from "../vendor/turndown/turndown.js";

// HTML-to-markdown, bounded (CLAUDE.md Launch-critical #22).
//
// Through 0.8.3 both markdown tools handed the page to the npm `turndown`
// package, which parsed it with domino in one synchronous call: `timeout_ms`
// and cancellation could not interrupt it, misnested markup was quadratic,
// 35 KB of `<b id=N><p>x` exhausted a 4 GB heap, ~1,150 levels of nesting
// overflowed the stack, and Turndown itself was quadratic on large pages.
// Timings in the comments are the old code's, measured on Node 22.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = resolve(__dirname, "..");

async function md(html: string, opts?: Parameters<typeof htmlToMarkdown>[1]): Promise<string> {
  const r = await htmlToMarkdown(html, opts);
  if ("error" in r) throw new Error(`unexpected conversion error: ${r.error}`);
  return r.markdown;
}

async function err(html: string, opts?: Parameters<typeof htmlToMarkdown>[1]): Promise<string> {
  const r = await htmlToMarkdown(html, opts);
  if (!("error" in r)) throw new Error("expected a conversion error, got markdown");
  return r.error;
}

const BUDGET_ERROR = /HTML-to-markdown conversion exceeded its \d+ ms budget/;
const OUTPUT_ERROR = /page's markdown grows past \d+ characters while converting/;

/** Runs a conversion, recording the longest gap a 2 ms interval timer saw (the event-loop stall). */
async function timed(html: string, budgetMs: number) {
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 2);
  const t0 = performance.now();
  try {
    const result = await htmlToMarkdown(html, { budgetMs });
    const end = performance.now();
    return { result, ms: end - t0, maxGapMs: Math.max(maxGapMs, end - last) };
  } finally {
    clearInterval(timer);
  }
}

const parseRoot = (html: string) =>
  domino.createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`).getElementById("turndown-root")!;

describe("htmlToMarkdown -- output (unchanged from npm turndown)", () => {
  it("converts basic HTML to markdown", async () => {
    const out = await md("<h1>Title</h1><p>Hello <strong>world</strong>.</p>");
    expect(out).toContain("# Title");
    expect(out).toContain("Hello **world**.");
  });

  it("renders headings with atx style", async () => {
    const out = await md("<h1>One</h1><h2>Two</h2><h3>Three</h3>");
    expect(out).toContain("# One");
    expect(out).toContain("## Two");
    expect(out).toContain("### Three");
  });

  it("renders unordered lists with dash bullets", async () => {
    const out = await md("<ul><li>apple</li><li>banana</li><li>cherry</li></ul>");
    expect(out).toMatch(/^-\s+apple/m);
    expect(out).toMatch(/^-\s+banana/m);
    expect(out).toMatch(/^-\s+cherry/m);
  });

  it("renders fenced code blocks", async () => {
    const out = await md("<pre><code>const x = 1;\nconsole.log(x);</code></pre>");
    expect(out).toMatch(/```[\s\S]*const x = 1;[\s\S]*```/);
  });

  it("preserves links", async () => {
    const out = await md('<p>See <a href="https://example.com">example</a>.</p>');
    expect(out).toContain("[example](https://example.com)");
  });

  it("strips script tags", async () => {
    const out = await md("<p>before</p><script>alert('xss')</script><p>after</p>");
    expect(out).not.toContain("alert");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("strips style tags", async () => {
    const out = await md("<style>body{color:red}</style><p>visible</p>");
    expect(out).not.toContain("color:red");
    expect(out).toContain("visible");
  });

  it("strips noscript, iframe, svg, canvas", async () => {
    const out = await md(
      [
        "<noscript>no-js</noscript>",
        "<iframe src='x'></iframe>",
        "<svg><circle/></svg>",
        "<canvas></canvas>",
        "<p>kept</p>",
      ].join(""),
    );
    expect(out).not.toContain("no-js");
    expect(out).not.toContain("iframe");
    expect(out).toContain("kept");
  });

  it("strips NAV, FOOTER, ASIDE", async () => {
    const out = await md(
      [
        "<nav>menu items</nav>",
        "<main><p>main content</p></main>",
        "<aside>sidebar</aside>",
        "<footer>copyright</footer>",
      ].join(""),
    );
    expect(out).not.toContain("menu items");
    expect(out).not.toContain("sidebar");
    expect(out).not.toContain("copyright");
    expect(out).toContain("main content");
  });

  it("converts an empty page to an empty string", async () => {
    expect(await md("")).toBe("");
  });

  it("keeps blank-node handling: void and meaningful-when-blank descendants (patched has())", async () => {
    // A blank <p> holding an <img> is not blank; one holding a blank <a> is not
    // either; a <p> of only whitespace is.
    expect(await md('<p>a</p><p> <img src="/i.png" alt="i"> </p><p>b</p>')).toBe("a\n\n![i](/i.png)\n\nb");
    expect(await md("<div>a</div><div>   </div><div>b</div>")).toBe("a\n\nb");
    // An SVG <a> inside a blank span (expected string taken from npm turndown 7.2.4).
    expect(await md("<p>x<span> <svg><a></a></svg> </span>y</p>")).toBe("x y");
  });

  it("keeps whitespace flanking, blank nodes and <ol> numbering (patch f; expected strings from npm turndown 7.2.4)", async () => {
    expect(await md("<p>a<b> \u00a0x\u00a0 </b>c</p>")).toBe("a \u00a0**x**\u00a0 c");
    expect(await md("<p>a <em> b </em> c</p>")).toBe("a _b_ c");
    expect(await md("<pre>x <i> \u00a0 </i> y<b>\u3000 z \u3000</b> w</pre>")).toBe("x \u00a0  y\u3000 **z** \u3000 w");
    expect(await md("<p>a<i>\u00a0 </i><b> b</b>c</p>")).toBe("a\u00a0 **b**c");
    expect(await md('<ol start="3"><li>a</li><li>b</li><li>c</li></ol>')).toBe("3.  a\n4.  b\n5.  c");
    expect(await md('<p>x<span> </span><img src="i.png"><a href="u"> </a>y</p>')).toBe("x ![](i.png) [](u)y");
  });

  it("joins children exactly like upstream's reduce(join) (patched process(), oracle check)", async () => {
    // The 6-line upstream join(), as the oracle.
    const trimTrailingNewlines = (s: string) => {
      let end = s.length;
      while (end > 0 && s[end - 1] === "\n") end--;
      return s.substring(0, end);
    };
    const join = (output: string, replacement: string) => {
      const s1 = trimTrailingNewlines(output);
      const s2 = replacement.replace(/^\n*/, "");
      const nls = Math.max(output.length - s1.length, replacement.length - s2.length);
      return s1 + "\n\n".substring(0, nls) + s2;
    };
    // Each <x-r data-i=N> child's replacement is pieces[N], so the vendored
    // process() joins exactly the strings the oracle does.
    let pieces: string[] = [];
    const td = makeTurndown();
    td.addRule("fixedReplacement", {
      filter: (node) => node.nodeName === "X-R",
      replacement: (_content, node) => pieces[Number(node.getAttribute("data-i"))]!,
    });
    const tokens = ["", "\n", "\n\n", "\n\n\n", "a", "b c", " ", "\t", "d\n", "\ne"];
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const count = 1 + rand(30);
      pieces = [];
      for (let i = 0; i < count; i++) {
        let piece = "";
        for (let k = rand(4); k >= 0; k--) piece += tokens[rand(tokens.length)];
        pieces.push(piece);
      }
      const html = pieces.map((_, i) => `<x-r data-i="${i}">x</x-r>`).join("");
      const root = domino
        .createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`)
        .getElementById("turndown-root")!;
      // postProcess(): one more join with each rule's (empty) append, then the trims.
      const expected = join(pieces.reduce(join, ""), "")
        .replace(/^[\t\r\n]+/, "")
        .replace(/[\t\r\n\s]+$/, "");
      expect(td.turndown(root), JSON.stringify(pieces)).toBe(expected);
    }
  });
});

describe("htmlToMarkdown -- linear on large pages", () => {
  it("converts a flat 2 MiB article quickly (old: 8.4 s, on 2 MiB of a denser unit the node budget now refuses)", async () => {
    // 9 nodes and an attribute per 100 characters: about 195,000 of the 250,000 nodes allowed.
    const unit = "<p>hello <b>world</b> and <a href='/x'>link</a>, then a run of plain words to read on with</p>\n";
    const html = unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
    const t0 = performance.now();
    const out = await md(html);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(out.startsWith("hello **world** and [link](/x)")).toBe(true);
  });

  it("converts 100,000 &nbsp; in one paragraph quickly (old: 15.6 s)", async () => {
    const t0 = performance.now();
    const out = await md(`<p>a${"&nbsp;".repeat(100_000)}b</p>`);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(out.length).toBe(100_002);
  });

  it("converts 200,000 spaces in a <pre> quickly (old: quadratic trailing-whitespace regex)", async () => {
    const t0 = performance.now();
    const out = await md(`<pre>${" ".repeat(200_000)}x</pre>`);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(out).toContain("x");
  });
});

describe("htmlToMarkdown -- nesting depth", () => {
  it("refuses 1,200 nested <div>s with an error instead of a stack overflow (old: RangeError)", async () => {
    const n = 1200;
    expect(await err(`${"<div>".repeat(n)}x${"</div>".repeat(n)}`)).toContain(
      `page nests elements 1200 deep (limit ${MAX_MARKDOWN_DEPTH})`,
    );
  });

  it("converts nesting exactly at the limit, and refuses one level past it", async () => {
    const at = MAX_MARKDOWN_DEPTH;
    expect(await md(`${"<div>".repeat(at)}x${"</div>".repeat(at)}`)).toBe("x");
    const past = at + 1;
    expect(await err(`${"<div>".repeat(past)}x${"</div>".repeat(past)}`)).toContain(`nests elements ${past} deep`);
  });

  it("refuses deep unclosed lists and nested tables", async () => {
    expect(await err(`${"<ul><li>".repeat(600)}x`)).toContain("nests elements 1200 deep");
    // table > tbody > tr > td: four levels per table.
    expect(await err(`${"<table><tr><td>".repeat(300)}x`)).toContain("nests elements 1200 deep");
  });
});

describe("htmlToMarkdown -- node budget", () => {
  it("stops a page whose parse amplifies its size (old: exhausted a 4 GB heap)", async () => {
    let html = "";
    for (let i = 0; i < 2500; i++) html += `<b id=${i}><p>x`;
    expect(html.length).toBeLessThan(40_000);
    const t0 = performance.now();
    const e = await err(html);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(e).toMatch(/page builds more than \d+ DOM nodes/);
  });

  // Found in the fourth review: a budget of 100,000 + one node per character
  // (cap 1,000,000) let 1 MiB of `<p>x` hold ~500 MB, and template content
  // and attributes were not counted at all. Numbers are the previous version's.
  const budgetFor = (html: string) =>
    Math.min(MAX_NODE_BUDGET, MIN_NODE_BUDGET + Math.floor(html.length / NODE_BUDGET_CHARS));

  it("budgets MIN_NODE_BUDGET plus one node per NODE_BUDGET_CHARS characters", async () => {
    // Two nodes per `<p>x`: 120,000 nodes fit the 130,000 a 240,000-character page gets ...
    const fits = "<p>x".repeat(60_000);
    expect(budgetFor(fits)).toBe(130_000);
    expect(await md(fits)).toMatch(/^x\n\nx\n\n/);
    // ... and 140,000 do not fit 135,000.
    const over = "<p>x".repeat(70_000);
    expect(await err(over)).toContain(`more than ${budgetFor(over)} DOM nodes (the limit for a 280000-character page`);
  });

  it(`refuses 2 MiB of <p>x at the ${MAX_NODE_BUDGET}-node cap (was: 1 MiB held ~500 MB)`, async () => {
    const html = "<p>x".repeat(512 * 1024);
    expect(budgetFor(html)).toBe(MAX_NODE_BUDGET);
    const t0 = performance.now();
    expect(await err(html)).toContain(`more than ${MAX_NODE_BUDGET} DOM nodes`);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("counts nodes built inside <template> content (was: 36 KB built 2.6 GB, uncounted)", async () => {
    let html = "<template>";
    for (let i = 0; i < 2500; i++) html += `<b id=${i}><p>x`;
    const t0 = performance.now();
    expect(await err(html)).toMatch(/page builds more than \d+ DOM nodes/);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it(`counts attributes, ${ATTRS_PER_NODE} to a node, including the ones cloned with formatting elements (was: 814 KB built 3.5 GB in 30 s)`, async () => {
    // 676 distinct attributes on each <b>; every <p> re-creates the open <b>s with all of theirs.
    const names = Array.from({ length: 676 }, (_, i) => String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26)));
    const html = `<b ${names.join(" ")}><p>x`.repeat(400);
    const t0 = performance.now();
    expect(await err(html)).toMatch(/page builds more than \d+ DOM nodes .*an attribute counts as 1\/4 node/);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("converts pages with templates as before (template content is never converted)", async () => {
    expect(await md("<p>a</p><template><p>hidden<template><b>deeper</b></template></p></template><p>b</p>")).toBe(
      "a\n\nb",
    );
    expect(await md("<table><template><tr><td>t</td></tr></template><tr><td>c</td></tr></table>")).toContain("c");
  });
});

describe("htmlToMarkdown -- concurrency limit", () => {
  // Sliced parses interleave, so without a limit N concurrent calls held N
  // DOMs at once (fourth review: 8 calls of 1 MiB peaked at 2.0 GB).
  const slow = "<ul><li>".repeat(20_000); // parses until its budget runs out

  it(`runs at most ${MAX_CONCURRENT_CONVERSIONS} at once; a queued call leaves on its signal or deadline`, async () => {
    expect(conversionSlots()).toEqual({ active: 0, waiting: 0, chars: 0 });
    const running = Array.from({ length: MAX_CONCURRENT_CONVERSIONS }, () => htmlToMarkdown(slow, { budgetMs: 1_500 }));
    const cancel = new AbortController();
    const t0 = performance.now();
    const cancelled = htmlToMarkdown("<p>x</p>", { signal: cancel.signal });
    const timedOut = htmlToMarkdown("<p>x</p>", { budgetMs: 100 });
    const queued = htmlToMarkdown("<p>queued</p>", { budgetMs: 10_000 });
    // A queued call holds only its input: it has not parsed anything yet.
    expect(conversionSlots()).toMatchObject({ active: MAX_CONCURRENT_CONVERSIONS, waiting: 3 });
    setTimeout(() => cancel.abort(), 50);
    expect(await cancelled).toEqual({ error: CANCELLED });
    expect(await timedOut).toEqual({ error: expect.stringMatching(BUDGET_ERROR) });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(conversionSlots()).toMatchObject({ active: MAX_CONCURRENT_CONVERSIONS, waiting: 1 });
    // The running calls stop at their budget, then the queued one gets a slot.
    for (const r of await Promise.all(running)) expect(r).toEqual({ error: expect.stringMatching(BUDGET_ERROR) });
    expect(await queued).toEqual({ markdown: "queued" });
    expect(conversionSlots()).toEqual({ active: 0, waiting: 0, chars: 0 });
  });

  it("serves queued calls in order and frees every slot, refusals and failures included", async () => {
    const order: number[] = [];
    const pages = ["<p>1</p>", `${"<div>".repeat(300)}x`, "<p>3</p>", "<ul><li>".repeat(20_000), "<p>5</p>"];
    const results = await Promise.all(
      pages.map((html, i) =>
        htmlToMarkdown(html, { budgetMs: 2_000 }).then((r) => {
          order.push(i);
          return r;
        }),
      ),
    );
    expect(results[0]).toEqual({ markdown: "1" });
    expect(results[1]).toEqual({ error: expect.stringContaining("nests elements 300 deep") });
    expect(results[4]).toEqual({ markdown: "5" });
    expect(order.indexOf(4)).toBeGreaterThan(order.indexOf(2));
    expect(conversionSlots()).toEqual({ active: 0, waiting: 0, chars: 0 });
  });

  it.each([
    ["a promise job", (run: () => void) => Promise.resolve().then(run)],
    // From the poll phase the next phase is check, before timers: only the
    // handoff's own deadline check stops the grant there.
    ["an I/O callback", (run: () => void) => new Promise<void>((done) => readFile(__filename, () => done(run())))],
  ])("never grants a slot to a queued call whose deadline passed while the loop was blocked, released from %s (fifth review: 16 queued calls ran up to 3.6 s past budget)", async (_, startIn) => {
    // The holders convert entirely in microtasks, so their slots come free
    // before any timer can fire; the queued calls' 5 ms budgets are long gone.
    let holders: Promise<unknown>[] = [];
    let queued: Promise<unknown>[] = [];
    const parses = vi.spyOn(domino, "createIncrementalHTMLParser");
    await startIn(() => {
      holders = Array.from({ length: MAX_CONCURRENT_CONVERSIONS }, () => htmlToMarkdown("<p>h</p>"));
      queued = Array.from({ length: 16 }, () => htmlToMarkdown("<p>late</p>", { budgetMs: 5 }));
      const t0 = performance.now();
      while (performance.now() - t0 < 30); // block the loop past every queued deadline
    });
    for (const r of await Promise.all(holders)) expect(r).toEqual({ markdown: "h" });
    for (const r of await Promise.all(queued)) expect(r).toEqual({ error: expect.stringMatching(BUDGET_ERROR) });
    // Only the holders parsed: an expired call is settled, never run.
    expect(parses).toHaveBeenCalledTimes(MAX_CONCURRENT_CONVERSIONS);
    parses.mockRestore();
    expect(conversionSlots()).toEqual({ active: 0, waiting: 0, chars: 0 });
  });

  it("hands a freed slot over on a later event-loop turn, and skips a queued call cancelled meanwhile", async () => {
    const holders = Array.from({ length: MAX_CONCURRENT_CONVERSIONS }, () => htmlToMarkdown("<p>h</p>"));
    const cancel = new AbortController();
    const cancelled = htmlToMarkdown("<p>c</p>", { signal: cancel.signal });
    const next = htmlToMarkdown("<p>n</p>");
    cancel.abort();
    expect(await cancelled).toEqual({ error: CANCELLED });
    await Promise.all(holders);
    // Both slots are free, but the handoff waits for the loop to turn (it
    // used to be granted inside the holder's release, on the same tick).
    expect(conversionSlots()).toEqual({ active: 0, waiting: 1, chars: 0 });
    expect(await next).toEqual({ markdown: "n" });
    expect(conversionSlots()).toEqual({ active: 0, waiting: 0, chars: 0 });
  });

  it(`weighs slots by input: at most ${MAX_INPUT_IN_FLIGHT} characters in flight, one call always admitted`, async () => {
    expect(MAX_INPUT_IN_FLIGHT).toBeLessThan(2 * MAX_MARKDOWN_INPUT);
    // Slow pages (unclosed lists, parse until the budget) padded to size.
    const big = "<ul><li>".repeat(20_000) + " ".repeat(MAX_MARKDOWN_INPUT - 160_000);
    const first = htmlToMarkdown(big, { budgetMs: 300 });
    const second = htmlToMarkdown(big, { budgetMs: 5_000 });
    // Two pages at the ceiling never convert together: the second waits.
    expect(conversionSlots()).toEqual({ active: 1, waiting: 1, chars: big.length });
    // A small page waits behind it too (FIFO), then runs beside the second.
    const small = htmlToMarkdown("<p>s</p>", { budgetMs: 5_000 });
    expect(conversionSlots()).toEqual({ active: 1, waiting: 2, chars: big.length });
    expect(await first).toEqual({ error: expect.stringMatching(BUDGET_ERROR) });
    expect(await small).toEqual({ markdown: "s" });
    expect(conversionSlots()).toEqual({ active: 1, waiting: 0, chars: big.length }); // the second, still running
    expect(await second).toEqual({ error: expect.stringMatching(BUDGET_ERROR) });
    expect(conversionSlots()).toEqual({ active: 0, waiting: 0, chars: 0 });
  });
});

describe("htmlToMarkdown -- input ceiling", () => {
  it(`refuses a page over ${MAX_MARKDOWN_INPUT} characters before building anything (fifth review: 100 MiB took 1.5-3 GB, 8 calls OOM-crashed Node)`, async () => {
    const t0 = performance.now();
    const r = await htmlToMarkdown(`<p>${"*_".repeat(MAX_MARKDOWN_INPUT / 2)}</p>`);
    expect(r).toEqual({ error: expect.stringContaining(`over the ${MAX_MARKDOWN_INPUT}-character limit`) });
    expect((r as { error: string }).error).toContain("fetch_html_to_text");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(conversionSlots()).toEqual({ active: 0, waiting: 0, chars: 0 });
  });

  it("converts a page exactly at the ceiling", async () => {
    const html = `<p>${"a".repeat(MAX_MARKDOWN_INPUT - 7)}</p>`;
    expect(html.length).toBe(MAX_MARKDOWN_INPUT);
    expect((await md(html, { budgetMs: 30_000 })).length).toBe(MAX_MARKDOWN_INPUT - 7);
  });
});

describe("htmlToMarkdown -- deadline and cancellation", () => {
  it("stops parsing 20,000 unclosed <ul><li> at the budget (old: 51 s)", async () => {
    const t0 = performance.now();
    const e = await err("<ul><li>".repeat(20_000), { budgetMs: 500 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(e).toMatch(BUDGET_ERROR);
    expect(e).toContain("500 ms");
  });

  it("stops parsing 20,000 distinct open <b>s at the budget (old: 45 s)", async () => {
    let html = "";
    for (let i = 0; i < 20_000; i++) html += `<b id=${i}>`;
    const t0 = performance.now();
    const e = await err(`${html}x`, { budgetMs: 500 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(e).toMatch(BUDGET_ERROR);
  });

  it("stops on the caller's signal, and keeps the event loop running while it parses", async () => {
    const cancel = new AbortController();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    setTimeout(() => cancel.abort(), 100);
    const t0 = performance.now();
    try {
      const e = await err("<ul><li>".repeat(20_000), { signal: cancel.signal });
      expect(e).toBe(CANCELLED);
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(ticks).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(timer);
    }
  });

  it("returns at once when the signal is already aborted", async () => {
    const cancel = new AbortController();
    cancel.abort();
    expect(await err("<p>x</p>", { signal: cancel.signal })).toBe(CANCELLED);
  });

  it("bounds the whole conversion: 1 MiB of blank 250-deep chains stops at its budget", async () => {
    const chain = `${"<div>".repeat(250)}${"</div>".repeat(250)}`;
    const html = chain.repeat(Math.ceil((1024 * 1024) / chain.length));
    const t0 = performance.now();
    const e = await err(html, { budgetMs: 200 });
    expect(performance.now() - t0).toBeLessThan(200 + 1_000);
    expect(e).toMatch(BUDGET_ERROR);
  });

  it("the vendored Turndown checks its deadline after parsing (patch e)", () => {
    // Parsed outside the bounded path on purpose, so only Turndown's own check can stop it.
    const html = "<p>x</p>".repeat(2_000);
    const root = domino
      .createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`)
      .getElementById("turndown-root")!;
    const td = makeTurndown();
    td.deadline = performance.now() - 1;
    td.visited = 0;
    expect(() => td.turndown(root)).toThrow(ConversionDeadlineError);
  });
});

describe("htmlToMarkdown -- Turndown phase bounds", () => {
  // Found in review of the first bounded version: its Turndown phase still
  // re-read textContent per node (O(depth x nodes)), checked the deadline only
  // every 256th node, and let blockquote/list nesting rewrite the whole content
  // at every level. Times in these comments are that version's, on Node 22.
  it("converts 150,000 blank elements under 250 <div>s in O(1) per node (was: 3.7 s, a 3.5 s stall, on a 1 s budget)", async () => {
    const html = `${"<div>".repeat(250)}${"<i></i>".repeat(149_796)}`;
    const { result, ms, maxGapMs } = await timed(html, 1_000);
    expect(ms).toBeLessThan(1_000 + 1_000);
    expect(maxGapMs).toBeLessThan(1_000 + 1_000);
    expect(result).toEqual({ markdown: "" });
  });

  it("converts 90,000 whitespace-only elements under 250 <div>s within its budget (400,000 were 5.5-7.9 s on a 2 s budget; the node budget now refuses that many)", async () => {
    const html = `${"<div>".repeat(250)}${"<i> </i>".repeat(90_000)}x${"</div>".repeat(250)}`;
    const { result, ms, maxGapMs } = await timed(html, 2_000);
    expect(ms).toBeLessThan(2_000 + 1_000);
    expect(maxGapMs).toBeLessThan(2_000 + 1_000);
    // Done or stopped at the budget on a loaded machine; never past it.
    if ("error" in result) expect(result.error).toMatch(BUDGET_ERROR);
    else expect(result.markdown).toBe("x");
  });

  it("refuses 250 nested <blockquote>s around 400,000 lines at the output cap (was: 98.8 s, 2.8 GB)", async () => {
    const html = `${"<blockquote>".repeat(250)}<pre>${"x\n".repeat(400_000)}</pre>${"</blockquote>".repeat(250)}`;
    const { result, ms } = await timed(html, 1_000);
    expect(ms).toBeLessThan(1_000 + 1_000);
    expect("error" in result && result.error).toMatch(OUTPUT_ERROR);
    expect("error" in result && result.error).toContain(`${OUTPUT_FACTOR * html.length + OUTPUT_SLACK} characters`);
  });

  it("refuses 120 nested list items around 400,000 lines at the output cap", async () => {
    const html = `${"<ul><li>".repeat(120)}<pre>${"x\n".repeat(400_000)}</pre>${"</li></ul>".repeat(120)}`;
    const { result, ms } = await timed(html, 1_000);
    expect(ms).toBeLessThan(1_000 + 1_000);
    expect("error" in result && result.error).toMatch(OUTPUT_ERROR);
  });

  it("numbers 60,000 <ol> items without a per-item scan (was: quadratic)", async () => {
    const { result, ms } = await timed(`<ol>${"<li>x".repeat(60_000)}</ol>`, 10_000);
    expect(ms).toBeLessThan(5_000);
    const out = "markdown" in result ? result.markdown : result.error;
    expect(out.startsWith("1.  x\n2.  x\n")).toBe(true);
    expect(out.endsWith("\n60000.  x")).toBe(true);
  });

  it("collapses whitespace without domino's per-removal ancestor walk (patch h)", () => {
    // domino's modify() walks every ancestor of a removed node while the
    // document's modclock is non-zero: O(depth) per node collapseWhitespace() removes.
    const root = parseRoot(`${"<div>".repeat(50)}${"<i> </i>".repeat(1_000)}x`);
    // The prototype's modify() is read-only, so shadow it on every element of the tree.
    type Modifiable = { doc: { modclock: number }; modify: () => void };
    let walks = 0;
    const elements: DomElement[] = [root];
    while (elements.length > 0) {
      const el = elements.pop()!;
      const original = (el as unknown as Modifiable).modify;
      Object.defineProperty(el, "modify", {
        value(this: Modifiable) {
          if (this.doc.modclock) walks++;
          original.call(this);
        },
      });
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) elements.push(c);
    }
    expect(makeTurndown().turndown(root)).toBe("x");
    // 1,000 nodes were removed; only the one root.modify() after restoring the clock walks.
    expect(walks).toBe(1);
  });

  it("the vendored Turndown checks its deadline at every node (patch e)", () => {
    const td = makeTurndown();
    td.deadline = performance.now() - 1;
    td.visited = 0;
    // One element: the old every-256th-node check never fired here.
    expect(() => td.turndown(parseRoot("<p>x</p>"))).toThrow(ConversionDeadlineError);
  });

  it("the vendored Turndown throws ConversionLimitError past maxOutput, before joining (patch g)", () => {
    const td = makeTurndown();
    td.maxOutput = 1_000;
    expect(() => td.turndown(parseRoot(`<p>${"x".repeat(999)}</p><p>y</p>`))).toThrow(ConversionLimitError);
    const ok = makeTurndown();
    ok.maxOutput = 1_000;
    expect(ok.turndown(parseRoot(`<p>${"x".repeat(990)}</p>`))).toBe("x".repeat(990));
  });

  // Found in the second review: string work on ONE node's text, attribute or
  // content ran as a single operation, so the deadline (checked between
  // operations) could not stop it. Times are the previous version's, Node 22.
  it("converts inline code that starts with a space in linear time (patch i; was: 100 KB took 17.6 s on a 200 ms budget)", async () => {
    // <br> becomes "  \n", then " ": content starts with a space and does not
    // end with one, which made upstream's /^ .*?[^ ].* $/ backtrack quadratically.
    const { result, ms } = await timed(`<p><code><br>${"a".repeat(100_000)}</code></p>`, 1_000);
    expect(ms).toBeLessThan(1_000 + 1_000);
    expect(result).toEqual({ markdown: `\`   ${"a".repeat(100_000)}\`` });
  });

  it("picks the inline code delimiter from a set of run lengths (patch i; was: one array scan per length tried)", () => {
    // 200,000 single backticks plus runs of 2..600: upstream collected all
    // 200,599 runs in an array and scanned it once per length it tried (601
    // scans; 3 MB of this took 1.8 s, against 0.15 s now). Count the scans.
    const runs = Array.from({ length: 599 }, (_, i) => "`".repeat(i + 2)).join(" ");
    const root = parseRoot(`<p><code>${"` ".repeat(200_000)}${runs}</code></p>`);
    const indexOf = Array.prototype.indexOf;
    let longScans = 0;
    Array.prototype.indexOf = function (this: unknown[], ...args: Parameters<typeof indexOf>) {
      if (this.length > 1_000) longScans++;
      return indexOf.apply(this, args);
    };
    let out: string;
    try {
      out = makeTurndown().turndown(root);
    } finally {
      Array.prototype.indexOf = indexOf;
    }
    expect(longScans).toBe(0);
    expect(out.startsWith(`${"`".repeat(601)} \` \``)).toBe(true);
    expect(out.endsWith(`${"`".repeat(600)} ${"`".repeat(601)}`)).toBe(true);
  });

  it("keeps inline code, escaping, link and image output (patches i, j; expected strings from the previous vendored Turndown)", async () => {
    const cases: Array<[string, string]> = [
      ["<p><code>`a</code></p>", "`` `a ``"],
      ["<p><code>a`</code></p>", "`` a` ``"],
      ["<p><code> a\u2028b </code></p>", "`a\u2028b`"],
      ["<p><code>a``b`c</code></p>", "```a``b`c```"],
      ["<p><code>` `` ````</code></p>", "``` ` `` ```` ```"],
      ["<p><code><br>aaaa</code></p>", "`   aaaa`"],
      ["<blockquote><p>a</p><p>b&#13;c&#x2028;d</p></blockquote>", "> a\n> \n> b c\u2028> d"],
      [
        '<p><img src="a (b).png" alt="x\n  y *z*" title="t &quot;q&quot;\n\n u"></p>',
        '![x\ny \\*z\\*](<a \\(b\\).png> "t \\"q\\"\nu")',
      ],
      ['<p><a href="u<v>" title="say &quot;hi&quot;">x</a></p>', '[x](u\\<v\\> "say \\"hi\\"")'],
      ["<p>1. not a list *x* _y_ [z] `w` \\</p>", "1\\. not a list \\*x\\* \\_y\\_ \\[z\\] \\`w\\` \\\\"],
      ["<p>==== heading?</p>", "\\==== heading?"],
      ["<pre><code>```\nx\n````\n</code></pre>", "`````\n```\nx\n````\n`````"],
    ];
    for (const [html, expected] of cases) {
      expect(await md(html)).toBe(expected);
      // The chunked paths (patch j) give the same output: force them with tiny chunks.
      for (const chunkSize of [1, 2, 3, 5]) {
        const td = makeTurndown();
        td.chunkSize = chunkSize;
        expect(td.turndown(parseRoot(html))).toBe(expected);
      }
    }
  });

  // Every deadline check reads `deadline`; count the reads while one huge
  // text node, attribute or rule's content is converted. The old code
  // charged such a string once and then ran it as one operation (a handful of
  // reads in all); patch (j) runs it 64 Ki characters at a time, checking
  // between chunks.
  const MiB = 1024 * 1024;
  const deadlineReads = (html: string) => {
    const td = makeTurndown();
    let reads = 0;
    Object.defineProperty(td, "deadline", {
      get: () => {
        reads++;
        return Number.POSITIVE_INFINITY;
      },
    });
    td.visited = 0;
    td.turndown(parseRoot(html));
    return reads;
  };
  it.each([
    ["one text node's escape", `<p>${"*_".repeat(MiB)}</p>`],
    ["an image's alt", `<img src="s.png" alt="${"*_\n ".repeat(MiB / 2)}">`],
    ["an image's src", `<img src="${"()".repeat(MiB)}">`],
    ["a link's href", `<a href="${"<>".repeat(MiB)}">x</a>`],
    ["a link's title", `<a href="u" title='${'"x'.repeat(MiB)}'>x</a>`],
    ["the blockquote rewrite of one <pre>", `<blockquote><pre>${"x\n".repeat(MiB)}</pre></blockquote>`],
    ["the list-item indent of one <pre>", `<ul><li><pre>${"x\n".repeat(MiB)}</pre></li></ul>`],
    ["inline code's newline rewrite", `<p><code>${"a\n".repeat(MiB)}</code></p>`],
    ["the whitespace collapse of one text node", `<p>${"a  ".repeat(MiB)}</p>`],
  ])("checks the deadline while it works through %s (patch j)", (_, html) => {
    // 2 MiB of work is 32 chunks of 64 Ki, two reads per check: 82-238 reads
    // in all here, against 14-52 (the per-node checks) without the chunking.
    expect(deadlineReads(html)).toBeGreaterThan(75);
  });

  it("stops one 8 MiB text node's escape near its budget (patch j; was: a ~1 s single replace, ~2 s at 16 MiB)", async () => {
    const { result, ms, maxGapMs } = await timed(`<p>${"*_[]`\\".repeat((MAX_MARKDOWN_INPUT - 7) / 6)}</p>`, 250);
    expect(result).toEqual({ error: expect.stringMatching(BUDGET_ERROR) });
    expect(ms).toBeLessThan(250 + 1_500);
    expect(maxGapMs).toBeLessThan(1_500);
  });

  it(`refuses more than ${MAX_TAG_NAMES} distinct tag names (domino caches each one for the life of the process)`, async () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `<x-n${i}>a</x-n${i}>`).join("");
    // The wrapper element is one of the names.
    expect(await md(names(MAX_TAG_NAMES - 1))).toBe("a".repeat(MAX_TAG_NAMES - 1));
    expect(await err(names(MAX_TAG_NAMES))).toContain(`more than ${MAX_TAG_NAMES} distinct tag names`);
    expect(await err(`<${"q".repeat(MAX_TAG_NAME_CHARS + 1)}>a`)).toContain(`${MAX_TAG_NAME_CHARS} characters of them`);
  });
});

describe("htmlToMarkdown -- whitespace nesting is linear in time and heap (patch k)", () => {
  // Found in the third review: a blank element still converted its whole
  // subtree and trimmed the result, both discarded, and the per-node
  // whitespace runs (ropes shared with every ancestor's) were flattened in
  // place once per level, so time AND retained heap grew as depth x text:
  // 2.5 MB of 250 nested whitespace-only <span>s took 9.7 s and 678 MB, and
  // 20 MB OOM-killed the process. Numbers are the previous version's, Node 22.
  const NBSP = "\u00a0";
  const MiB = 1024 * 1024;
  /** `depth` elements, each opening with `text` and holding the next. */
  const nest = (open: string, close: string, text: string, depth: number, inner = "") =>
    `${(open + text).repeat(depth)}${inner}${close.repeat(depth)}`;

  // node:vm hands out the gc() that --expose-gc defines once the flag is set.
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  /** Heap the conversion leaves reachable from the (still referenced) tree, in bytes. */
  const retainedBy = (html: string) => {
    const root = parseRoot(html);
    gc();
    const before = process.memoryUsage().heapUsed;
    const td = makeTurndown();
    const out = td.turndown(root);
    gc();
    const retained = process.memoryUsage().heapUsed - before;
    expect(root.firstChild).not.toBeNull(); // keeps the tree, and its cached runs, alive
    return { out, retained };
  };

  it("converts a blank subtree without visiting it (was: every node, then discarded)", () => {
    const td = makeTurndown();
    td.deadline = performance.now() + 60_000;
    td.visited = 0;
    expect(td.turndown(parseRoot(`<p>a${nest("<span>", "</span>", NBSP, 200)}b</p>`))).toBe(`a${NBSP.repeat(200)}b`);
    // <p>, "a", the outermost <span>, "b": the 399 nodes under that <span> are skipped,
    // and likewise the 2,000 under a removed <nav>.
    expect(td.visited).toBe(4);
    const removed = makeTurndown();
    removed.deadline = performance.now() + 60_000;
    removed.visited = 0;
    expect(removed.turndown(parseRoot(`<div>a<nav>${"<b>x</b>".repeat(1_000)}</nav>b</div>`))).toBe("ab");
    expect(removed.visited).toBe(4);
  });

  it("converts 4 MiB of whitespace nested 250 deep quickly (was: ~10 s+, 1 GB+)", async () => {
    const html = nest("<span>", "</span>", NBSP.repeat((4 * MiB) / 250), 250);
    const { result, ms } = await timed(html, 5_000);
    expect(result).toEqual({ markdown: "" });
    expect(ms).toBeLessThan(5_000);
  });

  it.each([
    ["an element whose rule gives '' (empty emphasis)", nest("<i>", "</i>", NBSP.repeat(10_000), 100, "<a></a>")],
    [
      "leading runs inside <pre>, flanked by spaces",
      `<pre>${nest("<i>", "</i>", ` ${NBSP.repeat(10_000)} `, 100, "x")}</pre>`,
    ],
    [
      "trailing runs inside <pre>, flanked by spaces",
      `<pre>${"<i>".repeat(100)}x${` ${NBSP.repeat(10_000)} </i>`.repeat(100)}</pre>`,
    ],
    ["a blank subtree", nest("<span>", "</span>", NBSP.repeat(10_000), 100)],
  ])("keeps the heap it retains linear in the page for %s (was: one copy per level)", (_, html) => {
    // 1 MB of text 100 deep: one flat copy per level kept ~50 MB alive.
    const { retained } = retainedBy(html);
    expect(retained).toBeLessThan(10 * html.length);
  });

  it("keeps whitespace, blank and removed-element output (patch k; expected strings from the previous vendored Turndown)", async () => {
    const cases: Array<[string, string]> = [
      [`<p>a<span>${NBSP}<i> </i>${NBSP}</span>b</p>`, `a${NBSP} ${NBSP}b`],
      [`<p>x<i>${NBSP}<i>${NBSP}<a></a></i></i>y</p>`, `x${NBSP}${NBSP}y`],
      [`<pre> <i> ${NBSP} <i> ${NBSP}x</i></i></pre>`, ` ${NBSP}  ${NBSP}__x__`],
      [`<pre><i><i>x ${NBSP} </i> ${NBSP} </i> y</pre>`, `__x__ ${NBSP}  ${NBSP} y`],
      [`<p>a <span> ${NBSP} </span> b</p>`, `a ${NBSP} b`],
      ["<p>a<nav> <b>x</b> </nav>b <svg><g>y</g></svg> c</p>", "a\n\nb  c"],
      [`<div>${NBSP}<p> </p>${NBSP}</div><p>z</p>`, "z"],
    ];
    for (const [html, expected] of cases) expect(await md(html)).toBe(expected);
  });
});

describe("domino internals the bounds rely on", () => {
  const parseIncrementally = (html: string) => {
    const parser = domino.createIncrementalHTMLParser();
    parser.end(`<x-turndown id="turndown-root">${html}</x-turndown>`);
    while (parser.process(() => false)) {
      // runs to completion
    }
    return parser.document();
  };

  it.each([
    ["misnested formatting", "<b><i>one</b>two</i>three"],
    ["foster-parented table content", "<table>loose<tr><td>cell</td></tr>text</table>after"],
    ["template content", "<template><p>hidden</p></template><p>shown</p>"],
    ["unclosed list items", "<ul><li>a<li>b<ul><li>c</ul>"],
  ])("the incremental parser builds the same tree as createDocument: %s", (_label, html) => {
    const incremental = parseIncrementally(html).getElementById("turndown-root")!;
    const whole = domino
      .createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`)
      .getElementById("turndown-root")!;
    expect(incremental.outerHTML).toBe(whole.outerHTML);
  });

  it("doc._nextnid counts nodes as they are built (the node budget reads it)", () => {
    const parser = domino.createIncrementalHTMLParser();
    parser.end(`<x-turndown id="turndown-root">${"<p>x</p>".repeat(100)}</x-turndown>`);
    const doc = parser.document();
    const before = doc._nextnid;
    expect(typeof before).toBe("number");
    while (parser.process(() => false)) {
      // runs to completion
    }
    // 100 <p>s plus 100 text nodes at least.
    expect(doc._nextnid - before).toBeGreaterThanOrEqual(200);
  });

  it("_nodes holds each rooted node by its id, with its attributes in _attrKeys (the budget counts them)", () => {
    const parser = domino.createIncrementalHTMLParser();
    parser.end(`<x-turndown id="turndown-root"><p a b c>x</p></x-turndown>`);
    const doc = parser.document() as unknown as DocInternals;
    while (parser.process(() => false)) {
      // runs to completion
    }
    const attrCounts = doc._nodes.map((n) => n?._attrKeys?.length ?? 0);
    expect(doc._nodes.length).toBe(doc._nextnid);
    // The wrapper's id, and <p>'s three.
    expect(attrCounts.filter((c) => c > 0).sort()).toEqual([1, 3]);
  });

  it.each([
    ["template content", "<template><p>hidden</p></template><p>shown</p>"],
    ["nested templates", "<template><b a=1><template><i>x</i></template></b></template>y"],
    ["a template in a table", "<table><template><tr><td>t</td></tr>loose</template><tr><td>c</td></tr></table>"],
    ["misnesting in a template", "<template><b><i>one</b>two</i><b id=1><p>x<b id=2><p>y</template>z"],
  ])("countedTemplateDoc builds the same tree and numbers every template node: %s", (_label, html) => {
    const parser = domino.createIncrementalHTMLParser();
    parser.end(`<x-turndown id="turndown-root">${html}</x-turndown>`);
    const doc = parser.document() as unknown as DocInternals;
    const inert = countedTemplateDoc(doc);
    const start = inert._nextnid;
    while (parser.process(() => false)) {
      // runs to completion
    }
    const whole = domino
      .createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`)
      .getElementById("turndown-root")!;
    // A template's outerHTML serializes its content.
    expect(parser.document().getElementById("turndown-root")!.outerHTML).toBe(whole.outerHTML);
    expect(inert._nextnid - start).toBeGreaterThanOrEqual(3);
  });
});

describe("vendor guards", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "tests" ? [] : sourceFiles(p);
      return /\.(ts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith(".d.ts") && !e.name.includes(".test.") ? [p] : [];
    });
  const rel = (p: string) => relative(SRC, p).split("\\").join("/");

  it("the vendored Turndown has no require( and no cloneNode", () => {
    const vendored = readFileSync(join(SRC, "vendor", "turndown", "turndown.js"), "utf8");
    expect(vendored).not.toContain("require(");
    expect(vendored).not.toContain("cloneNode");
  });

  it("only src/markdown.ts imports domino or the vendored Turndown, and nothing imports npm turndown", () => {
    const files = sourceFiles(SRC);
    expect(files.map(rel)).toContain("markdown.ts");
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const name = rel(file);
      expect(text, name).not.toMatch(/from\s+["']turndown["']|require\(\s*["']turndown["']\s*\)/);
      if (name === "markdown.ts" || name.startsWith("vendor/")) continue;
      expect(text, name).not.toMatch(/["']@mixmark-io\/domino["']/);
      expect(text, name).not.toMatch(/vendor\/turndown/);
    }
  });
});
