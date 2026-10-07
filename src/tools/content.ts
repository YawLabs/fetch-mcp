import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { htmlToMarkdown } from "../markdown.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
import { decodeHtmlEntities, findTagEnd, type TagMask } from "./html.js";

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
/**
 * Start tags that break out of SVG / MathML back into HTML. `<font>` breaks
 * out only with a color, face or size attribute; it is listed whole, since
 * this set only ever makes the scan less sure of the reading.
 */
const BREAKOUT_ELEMENTS = new Set([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
]);

interface IslandEntry {
  name: string;
  /** Its text is not rendered. */
  hidden: boolean;
  /**
   * Where its raw-text reading ends (the `</name` a browser reading it as
   * HTML raw text stops at, or the end of the input), or -1 for an element
   * that is never raw text. Its own end tag closes it only at or past this
   * point.
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
  /**
   * A `<select>` may be open in the current template level (or the
   * document), where a classic parser ignores title / xmp / plaintext tags
   * and reads on as markup. Every rule it drives reads both ways, so it is
   * safe to over-approximate.
   */
  select: boolean;
  /**
   * `select` was set by a `<select>` inside an island, which SVG / MathML may
   * read as a plain foreign element: a later `<select>` may open one or close
   * one, so it leaves `select` on instead of toggling it.
   */
  selectMaybe: boolean;
  /**
   * `select` and `selectMaybe` of each enclosing level (bit 1 and bit 2),
   * saved when a `<template>` opens. A template's content is parsed in its
   * own mode, where a `<style>` is raw text even inside a `<select>`: reading
   * it as a select's markup let a `</template>` in that raw text close the
   * template, and the hidden content after it was emitted.
   */
  selectOuter: number[];
  /**
   * Offsets where another reading of the page resumes tokenizing: the end tag
   * of a raw-text element the scan reads as markup (in an island, or in a
   * `<select>`). The scan and that reading agree on the tokens after such a
   * point only if the scan also starts a token there; a comment, tag or
   * bogus comment that runs across it desynchronizes them, and the scan
   * hides the rest of the input (`skipMarkup`).
   */
  sync: number[];
  /** Text before this offset is not emitted: a raw-text extent hidden while the markup inside it is still read. */
  hideUntil: number;
  /** End tags before this offset close nothing: inside an island they may sit in CDATA, where SVG reads them as text. */
  cdataUntil: number;
  /** The last `</name` found per raw-text name and where its search began, so overlapping searches are not repeated. */
  rawClose: Map<string, { from: number; at: number }>;
  /** The last `]]>` found and where its search began, for the same reason. */
  cdataClose: { from: number; at: number } | undefined;
  /**
   * The end of every end tag measured for a `<select>`'s raw extent, by its
   * offset. A map, not a single slot: openers of two names that alternate
   * (`<style><iframe>` x k) each evicted the other's entry and re-measured
   * the same end tag per opener, quadratic when its attribute quote is open.
   */
  closeEnd: Map<number, number>;
  /**
   * The island is certainly read by SVG / MathML rules: only its root is
   * open, it opened in plain HTML (not in a `<select>` or a hidden extent),
   * and no end tag or breakout start tag has been read since. Any end tag
   * clears it, since one can close an HTML element around the island and
   * leave it.
   */
  foreign: boolean;
  /** Set by `visibleTagMask`: marks the offset of every tag read while nothing hides it. */
  tags: TagMask | undefined;
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

function openTemplate(st: ScanState): void {
  st.template++;
  st.selectOuter.push((st.select ? 1 : 0) | (st.selectMaybe ? 2 : 0));
  setSelect(st, false);
}

function closeTemplate(st: ScanState): void {
  st.template--;
  const saved = st.selectOuter.pop() ?? 0;
  st.select = (saved & 1) !== 0;
  st.selectMaybe = (saved & 2) !== 0;
}

function setSelect(st: ScanState, on: boolean): void {
  st.select = on;
  st.selectMaybe = false;
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
 * `<select>`, leaving an `<svg>` or `<math>`), not the whole tree builder.
 * Inside an `<svg>` or `<math>` a browser reads markup by SVG rules until
 * something (an integration point, an HTML tag that breaks out) sends it back
 * to HTML; the scan does not decide which, so it tracks the elements whose
 * reading differs, hides every one of them (an SVG `<title>` tooltip too),
 * and closes each only where both readings agree it has ended. Where the
 * readings stop agreeing on where the markup is -- a comment or tag running
 * across the HTML end tag of one -- it hides the rest of the input.
 */
export function stripHtmlToText(html: string): string {
  let out = "";
  const st = newScanState(undefined);
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
  scan(html, st, emit);
  return trimLineEnds(decodeHtmlEntities(out))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The offsets of the tags `stripHtmlToText` reads as rendered markup, for a
 * caller that slices the page by tag (fetch_reader's `<article>`, `<main>`):
 * an `<article>` in a script, a comment, a template or other hidden text
 * never starts or ends a slice. Same scan, same rules; a tag in an extent the
 * scan cannot place is left unmarked, so it hides rather than shows here too.
 * So is a `<title>`, `<script>` or other raw-text tag in an `<svg>` or
 * `<math>`, and a `<title>` in a `<select>` (`readingDiffers`): a caller that
 * reads one to its end tag would read markup as its text.
 */
export function visibleTagMask(html: string): TagMask {
  const st = newScanState(new Uint8Array(html.length));
  scan(html, st, () => {});
  return st.tags!;
}

function newScanState(tags: TagMask | undefined): ScanState {
  return {
    island: [],
    hidden: 0,
    islandOpen: new Map(),
    rawOpen: 0,
    template: 0,
    select: false,
    selectMaybe: false,
    selectOuter: [],
    sync: [],
    hideUntil: 0,
    cdataUntil: 0,
    rawClose: new Map(),
    cdataClose: undefined,
    closeEnd: new Map(),
    foreign: false,
    tags,
  };
}

function scan(html: string, st: ScanState, emit: (text: string, at: number) => void): void {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      emit(html.slice(i), i);
      break;
    }
    emit(html.slice(i, lt), i);
    i = skipMarkup(html, lt, st, emit);
  }
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
 * A tag whose element a caller would read wrongly, so the mask leaves it out.
 * A caller reads a marked `<title>` or `<script>` as HTML RCDATA or raw text
 * to its end tag (`extractTitle`, fetch_meta's JSON-LD). In an `<svg>` or
 * `<math>` it may be a foreign element whose content is markup -- comments,
 * templates, scripts -- and an SVG `<title>` is never `document.title`. In a
 * `<select>` a classic parser ignores `<title>`, `<xmp>` and `<plaintext>`.
 */
function readingDiffers(st: ScanState, name: string): boolean {
  if (st.island.length > 0) return RAW_IN_HTML.has(name) || name === "template";
  return st.select && (name === "title" || name === "xmp" || name === "plaintext");
}

/**
 * `html[lt]` is `<`. Consume the markup that starts there and return the index
 * just past it, handing any text it stands for (a newline for `<br>`) to
 * `emit`. A `<` that does not start markup is text, as in a browser.
 *
 * Where the scan reads markup that another reading of the page takes as raw
 * text or CDATA, the two tokenizations meet again at that text's end (a
 * `sync` point, or `cdataUntil`). Markup that runs across such a point --
 * `<title><!--</title><script>-->` -- hides from the scan the tokens the other
 * reading starts there, which may open hidden content. The scan cannot follow
 * both from there, so it hides the rest of the input.
 */
function skipMarkup(html: string, lt: number, st: ScanState, emit: (text: string, at: number) => void): number {
  const next = readMarkup(html, lt, st, emit);
  return crossesSyncPoint(st, lt, next) ? html.length : next;
}

/** Whether markup over `[lt, next)` runs across a point where another reading resumes. Drops the points passed. */
function crossesSyncPoint(st: ScanState, lt: number, next: number): boolean {
  let crosses = st.cdataUntil > lt && st.cdataUntil < next;
  const sync = st.sync;
  if (sync.length === 0) return crosses;
  // At most one live point per raw-text name, so this stays short.
  let kept = 0;
  for (const at of sync) {
    if (at <= lt) continue;
    if (at < next) crosses = true;
    sync[kept++] = at;
  }
  sync.length = kept;
  return crosses;
}

/**
 * Every live point is the next end tag of one raw-text name past the scan, so
 * many openers share each one; storing it once keeps the list short.
 */
function addSyncPoint(st: ScanState, at: number): void {
  if (!st.sync.includes(at)) st.sync.push(at);
}

function readMarkup(html: string, lt: number, st: ScanState, emit: (text: string, at: number) => void): number {
  const n = html.length;
  const next = html[lt + 1];

  if (html.startsWith("<!--", lt)) return commentEnd(html, lt + 4);
  // <!DOCTYPE>, <?xml ?> and other bogus comments run to the next `>`. So does
  // <![CDATA[ in HTML. It is real CDATA only in SVG / MathML, where its content
  // up to `]]>` is text. Inside an island a browser may read it either way, so
  // the scan takes what each reading hides: the bogus comment, the start tags
  // after it (they may open hidden content), but no end tag before the `]]>`
  // (in CDATA it closes nothing). Where the island is certainly read as SVG /
  // MathML it is CDATA, and the scan skips it whole.
  if (st.island.length > 0 && html.startsWith("<![CDATA[", lt)) {
    const close = cdataEnd(html, lt + 9, st);
    if (st.foreign && st.island.length === 1) return close === -1 ? n : close + 3;
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
  if (
    st.tags !== undefined &&
    st.hidden === 0 &&
    st.template === 0 &&
    lt >= st.hideUntil &&
    lt >= st.cdataUntil &&
    !readingDiffers(st, name)
  ) {
    st.tags[lt] = 1;
  }

  if (closing) {
    if (lt < st.cdataUntil) return after;
    if (st.island.length > 0) {
      st.foreign = false;
      const top = st.island[st.island.length - 1]!;
      if (name === top.name && lt >= top.rawEnd) {
        popIsland(st);
      } else if (name === "template" && st.template > 0 && st.rawOpen === 0) {
        // A `</template>` closes the template around the island, and the
        // island with it -- unless an element open in the island could be
        // raw text that holds the `</template>`, or is a template itself.
        leaveIsland(st);
        closeTemplate(st);
      }
    } else if (name === "template" && st.template > 0) {
      closeTemplate(st);
    } else if (name === "select") {
      setSelect(st, false);
    }
    if (BLOCK_ELEMENTS.has(name)) emit("\n", lt);
    return after;
  }

  if (st.island.length > 0 && BREAKOUT_ELEMENTS.has(name)) st.foreign = false;
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
    // Past a breakout or in an integration point this opens a real select,
    // whose rules apply after the island too; SVG may read it as a plain
    // element, so `select` is only maybe on.
    if (name === "select") {
      st.select = true;
      st.selectMaybe = true;
    } else if (RAW_IN_HTML.has(name)) {
      // Where the island is certainly read as SVG / MathML (only its root
      // open), this is a foreign element with no raw-text reading: empty when
      // self-closed, else closed by its own end tag. It is still hidden.
      if (st.foreign && st.island.length === 1) {
        if (!end.selfClosing) pushIsland(st, name, true, -1);
        return after;
      }
      // Anywhere less sure, HTML may ignore the slash and read raw text to its
      // end tag, or to the end of the input when there is none. One of the
      // same name already open: the two raw-text readings overlap and end at
      // different end tags. Rare enough to give up on.
      if (st.islandOpen.get(name)) return n;
      const close =
        name === "script" ? scriptEndTag(html, after) : name === "plaintext" ? -1 : endTag(html, after, name, st);
      const rawEnd = close === -1 ? n : close;
      // Hidden whichever way it is read, `<title>` and `<textarea>` too: read
      // as markup, a comment or a quoted attribute in it can swallow its HTML
      // end tag and the tags after it, so nothing in it is ever shown. Where
      // the HTML reading resumes is a sync point.
      pushIsland(st, name, true, rawEnd);
      addSyncPoint(st, rawEnd);
    } else if (name === "template") {
      pushIsland(st, name, true, -1);
    } else if (!end.selfClosing && (ISLAND_ROOTS.has(name) || INTEGRATION_POINTS.has(name))) {
      pushIsland(st, name, false, -1);
    }
    return after;
  }

  if (ISLAND_ROOTS.has(name)) {
    if (!end.selfClosing) {
      pushIsland(st, name, false, -1);
      st.foreign = !st.select && lt >= st.hideUntil;
    }
    return after;
  }
  // A classic parser closes an open <select> at these, and ignores title,
  // xmp and plaintext inside one, reading on as markup. A `<select>` after
  // one that only maybe opened may open one or close one: it stays on.
  if (name === "select") {
    if (!st.selectMaybe) st.select = !st.select;
    return after;
  }
  if (name === "input" || name === "keygen" || name === "textarea") setSelect(st, false);
  // In a select, a classic parser ignores these and reads on as markup; a
  // customizable select, or a page whose select only maybe opened, reads
  // their content as text. Read as markup it shows less, so the scan reads it
  // so; the text reading resumes at the end tag, a sync point.
  if (st.select && (name === "title" || name === "xmp" || name === "plaintext")) {
    const close = name === "plaintext" ? -1 : endTag(html, after, name, st);
    if (close !== -1) addSyncPoint(st, close);
    return after;
  }
  // A browser ignores the self-closing flag on these, as on every non-void
  // HTML element: `<script src=x />` still hides everything to `</script>`.
  if (name === "template") {
    openTemplate(st);
    return after;
  }
  if (name === "plaintext") {
    emit(html.slice(after), after);
    return n;
  }
  if (st.select && DROPPED_ELEMENTS.has(name) && name !== "script") {
    // A classic parser ignores these inside a <select> and reads on as
    // markup, where a <template> may open; a customizable select, or a page
    // whose select only maybe opened, reads them as raw text. Hide the raw
    // extent and read the markup inside it too; the raw reading resumes at
    // the end tag, a sync point.
    const close = endTag(html, after, name, st);
    if (close === -1) {
      st.hideUntil = n;
      return after;
    }
    addSyncPoint(st, close);
    // Measured once per end tag: many openers share one, and measuring an end
    // tag with an unclosed quoted attribute reads to the end of the input.
    // Nothing to measure once the hidden extent already runs to the end.
    if (st.hideUntil >= n) return after;
    let closeEnd = st.closeEnd.get(close);
    if (closeEnd === undefined) {
      closeEnd = endTagEnd(html, close, name);
      st.closeEnd.set(close, closeEnd);
    }
    st.hideUntil = Math.max(st.hideUntil, closeEnd);
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
 * Index of the first `]]>` at or after `from`, or -1. Memoized like `endTag`:
 * every `<![CDATA[` in an island searches, and one with no `]]>` after it
 * read to the end of the input each time, so a page of them was quadratic.
 */
function cdataEnd(html: string, from: number, st: ScanState): number {
  const memo = st.cdataClose;
  if (memo !== undefined && memo.from <= from && (memo.at === -1 || memo.at >= from)) return memo.at;
  const at = html.indexOf("]]>", from);
  st.cdataClose = { from, at };
  return at;
}

/**
 * Index of the `</script` that ends a script whose content starts at `from`,
 * or -1. Script content has escape states a plain search misses: inside
 * `<!-- ... -->`, a `<script` opens a nested ("double-escaped") region whose
 * own `</script>` does not end the element, as legacy
 * `document.write("<!--<script>...</script>")` code relies on.
 */
export function scriptEndTag(html: string, from: number): number {
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

const TIMEOUT_MS_DESCRIPTION =
  "Timeout in ms for the request, covering DNS, every redirect hop and the body (default 10000)";
const timeoutMsSchema = z.number().int().positive().max(120_000).optional();

const commonPageSchema = {
  url: z.string().url().describe("URL to fetch"),
  timeout_ms: timeoutMsSchema.describe(TIMEOUT_MS_DESCRIPTION),
  max_bytes: z.number().int().positive().optional().describe("Max response size in bytes (default 5MiB)"),
  max_redirects: z.number().int().min(0).max(20).optional().describe("Max redirect hops (default 5)"),
  allow_private_hosts: z.boolean().optional().describe(ALLOW_PRIVATE_HOSTS_DESCRIPTION),
  user_agent: z.string().optional().describe("User-Agent override"),
};

const markdownPageSchema = {
  ...commonPageSchema,
  timeout_ms: timeoutMsSchema.describe(
    `${TIMEOUT_MS_DESCRIPTION}; the HTML-to-markdown step gets its own budget of the same length`,
  ),
};

export function registerContentTools(server: McpServer, request: HttpRequester) {
  server.tool(
    "fetch_html_to_markdown",
    "GET a URL, decode the HTML, and convert to clean markdown (headings, lists, links, code fences). Scripts, styles, iframes, nav, footer, and aside elements are stripped. Intended for feeding web pages into an LLM cheaply -- markdown is usually 3-8x smaller than raw HTML. Follows redirects, respects size/timeout limits, and blocks private-host requests by default.",
    markdownPageSchema,
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
      // The fetch has spent its time by now, so the conversion gets a budget of its own.
      const converted = await htmlToMarkdown(res.bodyText, { signal: extra.signal, budgetMs: timeout_ms });
      if ("error" in converted) return formatError(converted.error);
      return formatJson(converted.markdown.trim());
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
