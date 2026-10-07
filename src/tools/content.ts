import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import TurndownService from "turndown";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
import { decodeHtmlEntities, findTagEnd } from "./html.js";

export function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
  });
  td.addRule("removeScriptStyle", {
    filter: ["script", "style", "noscript", "iframe", "svg", "canvas"],
    replacement: () => "",
  });
  td.addRule("removeNav", {
    filter: (node) => {
      const el = node as unknown as { tagName?: string };
      return el.tagName === "NAV" || el.tagName === "FOOTER" || el.tagName === "ASIDE";
    },
    replacement: () => "",
  });
  return td;
}

/** Elements dropped with their content: raw text a browser does not render. */
const DROPPED_ELEMENTS = new Set(["script", "style", "noscript", "iframe", "noembed", "noframes"]);
/** Elements whose content is text, never markup: a `<script>` inside a `<title>` is just words. */
const TEXT_ELEMENTS = new Set(["title", "textarea", "xmp"]);
/** Elements whose closing tag ends a line of text. */
const BLOCK_ELEMENTS = new Set(["p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"]);

/** A tag name runs, as in a browser, to whitespace, `/` or `>`; `<scr<script>` is one tag. */
const TAG_NAME_RE = /[a-zA-Z][^\t\n\f\r />]*/y;

/** The end tag of each dropped or text element, built once from the fixed names above. */
const END_TAG_RE = new Map(
  [...DROPPED_ELEMENTS, ...TEXT_ELEMENTS].map((name) => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, "gi")]),
);

/** Comment ends: `-->`, or `--!>`, which a browser also accepts. */
const COMMENT_END_RE = /--!?>/g;

/** Elements that open an island, and are tracked when nested in one. */
const ISLAND_ROOTS = new Set(["svg", "math"]);
/** Raw text or RCDATA in HTML. Inside an island a browser may read them either way. */
const RAW_IN_HTML = new Set([...DROPPED_ELEMENTS, ...TEXT_ELEMENTS, "plaintext"]);
/**
 * SVG and MathML elements whose content a browser parses as HTML again. SVG's
 * `<title>` is one too, but it is tracked as RCDATA first (RAW_IN_HTML).
 */
const INTEGRATION_POINTS = new Set(["foreignobject", "desc", "mi", "mo", "mn", "ms", "mtext", "annotation-xml"]);

interface IslandEntry {
  name: string;
  /** Its text is not rendered. */
  hidden: boolean;
  /**
   * Where its raw-text reading ends (the `</name` a browser reading it as
   * HTML raw text stops at), or -1 when there is none to wait for. Its own
   * end tag closes it only at or past this point.
   */
  rawEnd: number;
}

interface ScanState {
  /**
   * Inside an `<svg>` or `<math>`: the tracked elements open in it, the root
   * first. Empty outside one. Only the innermost entry's own end tag closes
   * anything, and the island ends when the root closes.
   */
  island: IslandEntry[];
  /** How many hidden entries the island holds; text is dropped while any is open. */
  hidden: number;
  /** Open island entries per name. */
  islandOpen: Map<string, number>;
  /** How many island entries could hold a `</template>` as raw text, or are templates themselves. */
  rawOpen: number;
  /** How many `<template>`s are open outside an island; their content is never rendered. */
  template: number;
  /** A `<select>` is open, where a classic parser ignores title / xmp / plaintext tags and reads on as markup. */
  select: boolean;
  /** Text before this offset is not emitted: a raw-text extent hidden while the markup inside it is still read. */
  hideUntil: number;
  /** End tags before this offset close nothing: inside an island they may sit in CDATA, where SVG reads them as text. */
  cdataUntil: number;
  /** The last `</name` found per raw-text name and where its search began, so overlapping searches are not repeated. */
  rawClose: Map<string, { from: number; at: number }>;
}

function pushIsland(st: ScanState, name: string, hidden: boolean, rawEnd: number): void {
  st.island.push({ name, hidden, rawEnd });
  st.islandOpen.set(name, (st.islandOpen.get(name) ?? 0) + 1);
  if (hidden) st.hidden++;
  if (RAW_IN_HTML.has(name) || name === "template") st.rawOpen++;
}

function popIsland(st: ScanState): void {
  const entry = st.island.pop()!;
  st.islandOpen.set(entry.name, st.islandOpen.get(entry.name)! - 1);
  if (entry.hidden) st.hidden--;
  if (RAW_IN_HTML.has(entry.name) || entry.name === "template") st.rawOpen--;
}

function leaveIsland(st: ScanState): void {
  st.island.length = 0;
  st.islandOpen.clear();
  st.hidden = 0;
  st.rawOpen = 0;
}

/**
 * Reduce HTML to its readable text: tags removed, `<br>` and the closing tags
 * of block elements turned into newlines, entities decoded.
 *
 * A single left-to-right scan, the way a browser tokenizes, rather than a
 * chain of regex replacements. The regex chain missed `</script >` and
 * `</SCRIPT\n>` (so script source leaked into the text), let a removal splice
 * a new tag together out of the pieces around it, and decoded `&amp;lt;` to
 * `<`. Entities are now decoded once, after every tag is gone, so decoded text
 * is never read as markup.
 *
 * The invariant: nothing inside a comment or a script, style, noscript,
 * iframe, noembed, noframes or template element is ever emitted. Where the
 * scan cannot tell how a browser would build the tree -- malformed SVG or
 * MathML, mostly -- it hides rather than shows. It models the tokenizer, plus
 * the few tree-builder rules that decide what is hidden (`<template>`,
 * `<select>`, leaving an `<svg>` or `<math>`), not the whole tree builder. Inside an `<svg>` or `<math>` a browser reads markup by
 * SVG rules until something (an integration point, an HTML tag that breaks
 * out) sends it back to HTML; the scan does not decide which, so it tracks the
 * elements whose reading differs and closes each only where both readings
 * agree it has ended.
 */
export function stripHtmlToText(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  const st: ScanState = {
    island: [],
    hidden: 0,
    islandOpen: new Map(),
    rawOpen: 0,
    template: 0,
    select: false,
    hideUntil: 0,
    cdataUntil: 0,
    rawClose: new Map(),
  };
  // `at` is where the text starts in the input, for `hideUntil`.
  const emit = (text: string, at: number) => {
    if (st.hidden !== 0 || st.template !== 0) return;
    if (at < st.hideUntil) {
      if (st.hideUntil - at >= text.length) return;
      out += text.slice(st.hideUntil - at);
      return;
    }
    out += text;
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      emit(html.slice(i), i);
      break;
    }
    emit(html.slice(i, lt), i);
    i = skipMarkup(html, lt, st, emit);
  }
  return trimLineEnds(decodeHtmlEntities(out))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip spaces and tabs from the end of every line. By hand: `/[ \t]+\n/g`
 * retries at every blank of a long run with no newline after it, so a page of
 * blanks took quadratic time.
 */
function trimLineEnds(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let end = line.length;
      while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
      return end === line.length ? line : line.slice(0, end);
    })
    .join("\n");
}

/**
 * `html[lt]` is `<`. Consume the markup that starts there and return the index
 * just past it, handing any text it stands for (a newline for `<br>`) to
 * `emit`. A `<` that does not start markup is text, as in a browser.
 */
function skipMarkup(html: string, lt: number, st: ScanState, emit: (text: string, at: number) => void): number {
  const n = html.length;
  const next = html[lt + 1];

  if (html.startsWith("<!--", lt)) return commentEnd(html, lt + 4);
  // <!DOCTYPE>, <?xml ?> and other bogus comments run to the next `>`. So does
  // <![CDATA[ in HTML. It is real CDATA only in SVG / MathML, where its content
  // up to `]]>` is text. Inside an island a browser may read it either way, so
  // the scan takes what each reading hides: the bogus comment, the start tags
  // after it (they may open hidden content), but no end tag before the `]]>`
  // (in CDATA it closes nothing).
  if (st.island.length > 0 && html.startsWith("<![CDATA[", lt)) {
    const close = html.indexOf("]]>", lt + 9);
    st.cdataUntil = Math.max(st.cdataUntil, close === -1 ? n : close + 3);
  }
  if (next === "!" || next === "?") {
    const gt = html.indexOf(">", lt + 2);
    return gt === -1 ? n : gt + 1;
  }

  const closing = next === "/";
  TAG_NAME_RE.lastIndex = lt + (closing ? 2 : 1);
  const m = TAG_NAME_RE.exec(html);
  if (m === null) {
    if (closing) {
      // `</>` is dropped; `</ ...>` and friends are bogus comments.
      const gt = html.indexOf(">", lt + 2);
      return gt === -1 ? n : gt + 1;
    }
    emit("<", lt);
    return lt + 1;
  }

  const name = m[0].toLowerCase();
  const end = findTagEnd(html, TAG_NAME_RE.lastIndex);
  // A tag cut off by the end of the input is dropped with everything after it.
  if (end === null) return n;
  const after = end.pos + 1;

  if (closing) {
    if (lt < st.cdataUntil) return after;
    if (st.island.length > 0) {
      const top = st.island[st.island.length - 1]!;
      if (name === top.name && lt >= top.rawEnd) {
        popIsland(st);
      } else if (name === "template" && st.template > 0 && st.rawOpen === 0) {
        // A `</template>` closes the template around the island, and the
        // island with it -- unless an element open in the island could be
        // raw text that holds the `</template>`, or is a template itself.
        leaveIsland(st);
        st.template--;
      }
    } else if (name === "template" && st.template > 0) {
      st.template--;
    } else if (name === "select") {
      st.select = false;
    }
    if (BLOCK_ELEMENTS.has(name)) emit("\n", lt);
    return after;
  }

  if (name === "br") {
    emit("\n", lt);
    return after;
  }

  // Inside SVG / MathML the tokenizer never switches to raw text, but past an
  // integration point or a breakout a browser is reading HTML again. So the
  // elements that differ are tracked whichever way they appear: one that is
  // raw text in HTML opens even when self-closed (HTML ignores the slash on
  // it) and stays open until its raw-text reading has ended too.
  if (st.island.length > 0) {
    if (RAW_IN_HTML.has(name)) {
      // The raw-text end is searched once per region: an element of the same
      // name already open covers this one.
      let rawEnd = -1;
      if (!st.islandOpen.get(name)) {
        const close =
          name === "script" ? scriptEndTag(html, after) : name === "plaintext" ? -1 : endTag(html, after, name, st);
        rawEnd = close === -1 ? n : close;
      }
      // Raw-text elements stay hidden in SVG too, where `<script>` and
      // `<style>` are markup whose text is still not rendered.
      pushIsland(st, name, DROPPED_ELEMENTS.has(name), rawEnd);
    } else if (name === "template") {
      pushIsland(st, name, true, -1);
    } else if (!end.selfClosing && (ISLAND_ROOTS.has(name) || INTEGRATION_POINTS.has(name))) {
      pushIsland(st, name, false, -1);
    }
    return after;
  }

  if (ISLAND_ROOTS.has(name)) {
    if (!end.selfClosing) pushIsland(st, name, false, -1);
    return after;
  }
  // A classic parser closes an open <select> at these, and ignores title,
  // xmp and plaintext inside one, reading on as markup.
  if (name === "select") {
    st.select = !st.select;
    return after;
  }
  if (name === "input" || name === "keygen" || name === "textarea") st.select = false;
  if (st.select && (name === "title" || name === "xmp" || name === "plaintext")) return after;
  // A browser ignores the self-closing flag on these, as on every non-void
  // HTML element: `<script src=x />` still hides everything to `</script>`.
  if (name === "template") {
    st.template++;
    return after;
  }
  if (name === "plaintext") {
    emit(html.slice(after), after);
    return n;
  }
  if (st.select && DROPPED_ELEMENTS.has(name) && name !== "script") {
    // A classic parser ignores these inside a <select> and reads on as
    // markup, where a <template> may open; a customizable select reads them
    // as raw text. Hide the raw extent and read the markup inside it too.
    const close = endTag(html, after, name, st);
    st.hideUntil = Math.max(st.hideUntil, close === -1 ? n : endTagEnd(html, close, name));
    return after;
  }
  if (DROPPED_ELEMENTS.has(name)) {
    const close = name === "script" ? scriptEndTag(html, after) : endTag(html, after, name);
    return close === -1 ? n : endTagEnd(html, close, name);
  }
  if (TEXT_ELEMENTS.has(name)) {
    const close = endTag(html, after, name);
    if (close === -1) {
      emit(html.slice(after), after);
      return n;
    }
    emit(`${html.slice(after, close)}\n`, after);
    return endTagEnd(html, close, name);
  }
  return after;
}

/** Index just past the comment whose body starts at `from` (after `<!--`). */
function commentEnd(html: string, from: number): number {
  // `<!-->` and `<!--->` are complete (empty) comments.
  if (html[from] === ">") return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  // One forward search for whichever end comes first: searching for each
  // separately reads to the end of the input once per comment when a page
  // never uses one of them, which made a page of short comments quadratic.
  COMMENT_END_RE.lastIndex = from;
  const m = COMMENT_END_RE.exec(html);
  return m === null ? html.length : m.index + m[0].length;
}

/**
 * Index of the end tag `</name` (followed by whitespace, `/`, `>` or the end
 * of the input, in any case) at or after `from`, or -1 when there is none.
 * Searched in place: a lowercased copy of the input can differ in length
 * ("\u0130" lowercases to two code units) and shift every index.
 */
function endTag(html: string, from: number, name: string, st?: ScanState): number {
  // A search that began earlier found the first `</name` past its start, so
  // it is also the first past any later start before it; and none found
  // means none past any later start either. Reusing it keeps nested or
  // overlapping searches linear.
  const memo = st?.rawClose.get(name);
  if (memo !== undefined && memo.from <= from && (memo.at === -1 || memo.at >= from)) return memo.at;
  const re = END_TAG_RE.get(name)!;
  re.lastIndex = from;
  const m = re.exec(html);
  const at = m === null ? -1 : m.index;
  st?.rawClose.set(name, { from, at });
  return at;
}

/**
 * Index of the `</script` that ends a script whose content starts at `from`,
 * or -1. Script content has escape states a plain search misses: inside
 * `<!-- ... -->`, a `<script` opens a nested ("double-escaped") region whose
 * own `</script>` does not end the element, as legacy
 * `document.write("<!--<script>...</script>")` code relies on.
 */
function scriptEndTag(html: string, from: number): number {
  let state: "data" | "escaped" | "double" = "data";
  let i = from;
  for (;;) {
    const nextLt = html.indexOf("<", i);
    // Only `-->` leaves an escaped region inside a script; `--!>` does not.
    // A `-->` holds no `<`, so the one that matters lies before the next `<`:
    // searching just that stretch keeps the scan linear, where a search to the
    // end of the input for each script made a page of short scripts quadratic.
    if (state !== "data") {
      const escapeEnd = indexOfBefore(html, "-->", i, nextLt === -1 ? html.length : nextLt);
      if (escapeEnd !== -1) {
        state = "data";
        i = escapeEnd + 3;
        continue;
      }
    }
    if (nextLt === -1) return -1;
    const lt = nextLt;
    i = lt + 1;
    if (html.startsWith("<!--", lt)) {
      if (state === "data") state = "escaped";
      // Resume inside the `<!--` so the `-->` of `<!-->` and `<!--->` closes it at once.
      i = lt + 2;
      continue;
    }
    const closing = html[lt + 1] === "/";
    const at = lt + (closing ? 2 : 1);
    if (html.slice(at, at + 6).toLowerCase() !== "script" || !isScriptNameEnd(html[at + 6])) continue;
    if (closing) {
      if (state !== "double") return lt;
      state = "escaped";
    } else if (state === "escaped") {
      state = "double";
    }
  }
}

/** `html.indexOf(needle, from)`, but only for a match that ends by `end`. */
function indexOfBefore(html: string, needle: string, from: number, end: number): number {
  for (let k = from; k + needle.length <= end; k++) {
    if (html.startsWith(needle, k)) return k;
  }
  return -1;
}

function isScriptNameEnd(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    ch === "/" ||
    ch === ">" ||
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\f" ||
    ch === "\r"
  );
}

/** Index just past the end tag of `name` that starts at `close`. */
function endTagEnd(html: string, close: number, name: string): number {
  const end = findTagEnd(html, close + 2 + name.length);
  return end === null ? html.length : end.pos + 1;
}

const commonPageSchema = {
  url: z.string().url().describe("URL to fetch"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe("Timeout in ms for the request, covering DNS, every redirect hop and the body (default 10000)"),
  max_bytes: z.number().int().positive().optional().describe("Max response size in bytes (default 5MiB)"),
  max_redirects: z.number().int().min(0).max(20).optional().describe("Max redirect hops (default 5)"),
  allow_private_hosts: z.boolean().optional().describe(ALLOW_PRIVATE_HOSTS_DESCRIPTION),
  user_agent: z.string().optional().describe("User-Agent override"),
};

export function registerContentTools(server: McpServer, request: HttpRequester) {
  server.tool(
    "fetch_html_to_markdown",
    "GET a URL, decode the HTML, and convert to clean markdown (headings, lists, links, code fences). Scripts, styles, iframes, nav, footer, and aside elements are stripped. Intended for feeding web pages into an LLM cheaply -- markdown is usually 3-8x smaller than raw HTML. Follows redirects, respects size/timeout limits, and blocks private-host requests by default.",
    commonPageSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, timeout_ms, max_bytes, max_redirects, allow_private_hosts, user_agent }, extra) => {
      const res = await request({
        signal: extra.signal,
        method: "GET",
        url,
        timeoutMs: timeout_ms,
        maxBytes: max_bytes,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      if (!res.bodyText) return formatError("response body was empty");
      try {
        const markdown = makeTurndown().turndown(res.bodyText);
        return formatJson(markdown.trim());
      } catch (err) {
        return formatError(`HTML-to-markdown conversion failed: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "fetch_html_to_text",
    "GET a URL, decode the HTML, and return plain text with block-level structure preserved as newlines. Scripts, styles, and comments stripped; HTML entities decoded. Lighter than markdown when you only need the reading content.",
    commonPageSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, timeout_ms, max_bytes, max_redirects, allow_private_hosts, user_agent }, extra) => {
      const res = await request({
        signal: extra.signal,
        method: "GET",
        url,
        timeoutMs: timeout_ms,
        maxBytes: max_bytes,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      if (!res.bodyText) return formatError("response body was empty");
      return formatJson(stripHtmlToText(res.bodyText));
    },
  );
}
