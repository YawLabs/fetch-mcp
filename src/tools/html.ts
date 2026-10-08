/**
 * Small, pragmatic HTML utilities shared by the reader / meta / links tools.
 * We intentionally avoid pulling in a full DOM parser — the markdown path
 * (src/markdown.ts, domino plus vendored Turndown) already carries that weight, and these helpers
 * only need to survive real-world HTML well enough to find head metadata,
 * anchor tags, and article bodies.
 *
 * Key correctness points:
 *   - attribute values may contain `>` inside quotes, so we can't use the
 *     naive `<tag[^>]+>` regex
 *   - article / main / section can nest, so non-greedy regex picks the wrong
 *     closing tag; we pair openers and closers in one bracket-matching pass
 *   - a `<article>` written inside a script, a comment or other raw text is
 *     not a tag: callers that slice content out of a page pass a `TagMask`
 *     (`visibleTagMask()` in content.ts), and only the tags it marks count
 */

/**
 * `mask[i] === 1` when a start or end tag that a browser reads as rendered
 * markup begins at offset `i`; 0 inside comments, raw text (script, style,
 * ...), template content and other hidden extents, and 0 for a raw-text or
 * RCDATA tag (`<title>`, `<script>`) whose content a browser may read as
 * markup there (inside `<svg>` / `<math>`, a `<title>` in a `<select>`). Built by
 * `visibleTagMask()` in content.ts, from the same scan as `stripHtmlToText`.
 */
export type TagMask = Uint8Array;

/**
 * A tag name ends, as in a browser, at whitespace, `/`, `>` or the end of the
 * input: `<article-list>` and `<a.b>` are other elements, which `\b` matched.
 */
const NAME_END = "(?=[\\t\\n\\f\\r />]|$)";

/**
 * Parse a single tag's attribute text ("name=\"foo\" content=\"a > b\"")
 * into a lowercase-keyed record. Empty attributes resolve to "".
 *
 * Reads it the way the HTML tokenizer does, each character once: a name runs
 * to whitespace, `/`, `>` or `=`; a value is quoted only when its first
 * character is a quote. A duplicate attribute is ignored, as in a browser.
 * The regex this replaced backtracked over a long name at every offset, so
 * one long attribute name took quadratic time. The record has no prototype,
 * so a page's `__proto__` or `constructor` attribute is just a key.
 */
export function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  const n = s.length;
  let i = 0;
  for (;;) {
    while (i < n && (isTagSpace(s[i]) || s[i] === "/" || s[i] === ">")) i++;
    if (i >= n) return attrs;
    const nameStart = i;
    i++;
    while (i < n && !isTagSpace(s[i]) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") i++;
    const name = s.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && isTagSpace(s[j])) j++;
    let value = "";
    if (s[j] === "=") {
      j++;
      while (j < n && isTagSpace(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, j + 1);
        value = s.slice(j + 1, close === -1 ? n : close);
        i = close === -1 ? n : close + 1;
      } else {
        const valueStart = j;
        while (j < n && !isTagSpace(s[j]) && s[j] !== ">") j++;
        value = s.slice(valueStart, j);
        i = j;
      }
      value = decodeHtmlEntities(value);
    }
    if (!Object.hasOwn(attrs, name)) attrs[name] = value;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Pieces joined into one chunk at a time, so a million one-character pieces never sit in one array. */
const PIECES_PER_CHUNK = 4096;

/**
 * Builds a string out of ranges of `src` and literal pieces, for output the
 * size of a whole page. Adjacent ranges merge, so text copied through in
 * order costs one slice (or `src` itself), and pieces are joined a few
 * thousand at a time: `out += piece` per piece, or one array of every piece,
 * kept 30-40 bytes per input character alive on a page of one-character text
 * runs or dense entities.
 */
export class TextBuilder {
  private parts: string[] = [];
  private readonly chunks: string[] = [];
  private from = -1;
  private to = -1;

  constructor(private readonly src: string) {}

  /** Append `src.slice(from, to)`. */
  range(from: number, to: number): void {
    if (from >= to) return;
    if (from === this.to) {
      this.to = to;
      return;
    }
    this.flushRange();
    this.from = from;
    this.to = to;
  }

  /** Append a piece that is not a range of `src`. */
  literal(s: string): void {
    this.flushRange();
    this.push(s);
  }

  done(): string {
    if (this.parts.length === 0 && this.chunks.length === 0) {
      if (this.to <= this.from) return "";
      return this.from === 0 && this.to === this.src.length ? this.src : this.src.slice(this.from, this.to);
    }
    this.flushRange();
    if (this.parts.length > 0) this.chunks.push(this.parts.join(""));
    this.parts = [];
    return this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join("");
  }

  private flushRange(): void {
    if (this.to > this.from) this.push(this.src.slice(this.from, this.to));
    this.from = -1;
    this.to = -1;
  }

  private push(s: string): void {
    this.parts.push(s);
    if (this.parts.length === PIECES_PER_CHUNK) {
      this.chunks.push(this.parts.join(""));
      this.parts = [];
    }
  }
}

const NAMED_ENTITY_NAMES = Object.keys(NAMED_ENTITIES);

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/**
 * Decode the narrow set of HTML entities we encounter in attribute values and
 * short runs of text. This is not a full entity decoder — it covers the named
 * entities that matter (&amp; &lt; &gt; &quot; &apos; &nbsp;) plus the
 * numeric forms &#N; and &#xN;, each with its `;`.
 *
 * One pass over the input, so the output of one entity is never read as the
 * start of another: `&amp;lt;` decodes to the text `&lt;`, not to `<`. Code
 * points the HTML spec refuses (NUL, surrogates, past U+10FFFF) decode to
 * U+FFFD instead of reaching `String.fromCodePoint`, which throws past U+10FFFF.
 *
 * By hand rather than `String.replace` with a callback: stripHtmlToText runs
 * it over a whole page, and a page of `&amp;` built millions of match arrays
 * and one-character strings (3.8 GB for 100 MiB). Text between entities is
 * copied as ranges; a page with no `&` comes back as is.
 */
export function decodeHtmlEntities(s: string): string {
  let amp = s.indexOf("&");
  if (amp === -1) return s;
  const out = new TextBuilder(s);
  let copied = 0;
  const n = s.length;
  while (amp !== -1) {
    let end = -1;
    let decoded = "";
    let j = amp + 1;
    if (s.charCodeAt(j) === 35 /* # */) {
      j++;
      const x = s.charCodeAt(j);
      let hex = false;
      if ((x === 120 || x === 88) /* x X */ && isHexDigit(s.charCodeAt(j + 1))) {
        hex = true;
        j++;
      }
      const digits = j;
      while (j < n && (hex ? isHexDigit(s.charCodeAt(j)) : isDigit(s.charCodeAt(j)))) j++;
      if (j > digits && s.charCodeAt(j) === 59 /* ; */) {
        end = j + 1;
        decoded = codePointToString(Number.parseInt(s.slice(digits, j), hex ? 16 : 10));
      }
    } else {
      for (const name of NAMED_ENTITY_NAMES) {
        if (s.startsWith(name, j) && s.charCodeAt(j + name.length) === 59) {
          end = j + name.length + 1;
          decoded = NAMED_ENTITIES[name]!;
          break;
        }
      }
    }
    if (end === -1) {
      amp = s.indexOf("&", amp + 1);
      continue;
    }
    out.range(copied, amp);
    out.literal(decoded);
    copied = end;
    amp = s.indexOf("&", end);
  }
  out.range(copied, n);
  return out.done();
}

function codePointToString(n: number): string {
  if (!Number.isSafeInteger(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(n);
}

export interface FoundTag {
  /** The raw attribute text between `<tagName ` and `>` (no enclosing brackets). */
  attrsText: string;
  /** Byte offset in the source where the opening tag begins. */
  start: number;
  /** Byte offset just after the closing `>` of the opening tag. */
  contentStart: number;
  /** Whether the tag is self-closing (`<br/>`) -- always false for normal pairs. */
  selfClosing: boolean;
}

/**
 * Scan a chunk of HTML for every `<tagName ...>` opener and yield its
 * position + attribute text. Tolerates `>` inside quoted attribute values.
 * Yields self-closing tags too so callers can treat e.g. <link .../> naturally.
 */
export function* findTags(html: string, tagName: string, mask?: TagMask): Generator<FoundTag> {
  const name = tagName.toLowerCase();
  const pattern = new RegExp(`<${name}${NAME_END}`, "gi");
  pattern.lastIndex = 0;
  for (;;) {
    const m = pattern.exec(html);
    if (m === null) break;
    const start = m.index;
    if (mask !== undefined && mask[start] !== 1) continue;
    const end = findTagEnd(html, start + m[0].length);
    if (end === null) return;
    const rawAttrs = html.slice(start + m[0].length, end.pos);
    // Drop only a self-closing `/`: in `<a href=/blog/>` the slash belongs to the value.
    const attrsText = end.selfClosing ? rawAttrs.slice(0, -1) : rawAttrs;
    yield {
      start,
      contentStart: end.pos + 1,
      attrsText,
      selfClosing: end.selfClosing,
    };
    pattern.lastIndex = end.pos + 1;
  }
}

export interface TagEnd {
  pos: number;
  selfClosing: boolean;
}

const isTagSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";

/**
 * Given the index just past the tag name, find the `>` that closes the
 * opening tag while skipping `>` inside quoted attribute values. Returns
 * null when the tag never closes (malformed input).
 *
 * Follows the HTML tokenizer's attribute states: a quote opens a quoted value
 * only as the first non-space character after `=`. Anywhere else -- in a name,
 * inside an unquoted value (`alt=Bob's`) -- it is an ordinary character, so it
 * cannot swallow the `>` that really ends the tag and hide the markup after it.
 */
export function findTagEnd(html: string, from: number): TagEnd | null {
  const n = html.length;
  let i = from;
  for (;;) {
    // Before an attribute name.
    while (i < n && (isTagSpace(html[i]) || html[i] === "/")) {
      if (html[i] === "/" && html[i + 1] === ">") return { pos: i + 1, selfClosing: true };
      i++;
    }
    if (i >= n) return null;
    if (html[i] === ">") return { pos: i, selfClosing: false };
    // Attribute name: its first character may be `=`; quotes are literal.
    i++;
    while (i < n && !isTagSpace(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    while (i < n && isTagSpace(html[i])) i++;
    if (html[i] !== "=") continue;
    // Attribute value.
    i++;
    while (i < n && isTagSpace(html[i])) i++;
    if (i >= n) return null;
    const q = html[i];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, i + 1);
      if (close === -1) return null;
      i = close + 1;
    } else {
      // Unquoted (or missing, when the next character is `>`): runs to space or `>`.
      while (i < n && !isTagSpace(html[i]) && html[i] !== ">") i++;
    }
  }
}

/**
 * Called by `forEachBalancedTag` for each pair as it closes. `contentEnd` is
 * the offset of the close tag's `<` (`contentStart` for a self-closing
 * opener); `depth` is how many openers of the name enclose the pair. Return
 * true to stop the walk.
 */
export type BalancedTagVisitor = (
  start: number,
  contentStart: number,
  contentEnd: number,
  depth: number,
) => boolean | undefined;

/**
 * Pair every `<tagName>` opener with its matching close in one pass over the
 * input, matching openers and closers like brackets -- the close a
 * depth-counting walk from each opener would find; walking from each opener
 * separately made a page of many unclosed openers quadratic. Each pair is
 * reported as it closes, a self-closing opener at once, so the pairs at
 * depth 0 come in document order; an opener that never closes is never
 * reported, and neither is anything inside it. The open openers are held as
 * offsets in a typed array and nothing is kept per pair: materializing a
 * record per opener took 2.8 GB for 100 MiB of `<div>`.
 *
 * A tag cut off by the end of the input ends the walk, as it swallows
 * everything after it in a browser. An end tag is `</name` followed by
 * whitespace, `/` or `>`, attributes and all (`</ name>` is a bogus comment).
 * With `mask`, a tag counts only where the mask marks it, so an `<article>`
 * inside a `<script>` or a comment neither opens nor closes anything.
 */
export function forEachBalancedTag(
  html: string,
  tagName: string,
  mask: TagMask | undefined,
  visit: BalancedTagVisitor,
): void {
  const name = tagName.toLowerCase();
  const re = new RegExp(`</?${name}${NAME_END}`, "gi");
  let open = new Int32Array(64);
  let depth = 0;
  for (;;) {
    const m = re.exec(html);
    if (m === null) return;
    if (mask !== undefined && mask[m.index] !== 1) continue;
    const end = findTagEnd(html, m.index + m[0].length);
    if (end === null) return;
    // Past the whole tag: `</article x="<article>">` opens nothing.
    re.lastIndex = end.pos + 1;
    if (m[0][1] === "/") {
      if (depth === 0) continue;
      depth--;
      const start = open[depth]!;
      // Measured again rather than stored: only an opener that closes pays.
      const contentStart = findTagEnd(html, start + 1 + name.length)!.pos + 1;
      if (visit(start, contentStart, m.index, depth) === true) return;
    } else if (end.selfClosing) {
      if (visit(m.index, end.pos + 1, end.pos + 1, depth) === true) return;
    } else {
      if (depth === open.length) {
        const grown = new Int32Array(open.length * 2);
        grown.set(open);
        open = grown;
      }
      open[depth++] = m.index;
    }
  }
}

/** The attribute text of an opener `forEachBalancedTag` reported with a close tag (not self-closing). */
export function balancedTagAttrs(html: string, tagName: string, start: number, contentStart: number): string {
  return html.slice(start + 1 + tagName.length, contentStart - 1);
}

/**
 * The raw content of the first `<tagName>` element, up to its first close tag,
 * or undefined when there is no such element or it never closes. One search
 * from the first opener: a lazy `<title>([\s\S]*?)</title>` regex retried
 * from every opener, so a page of unclosed `<title>`s was quadratic.
 */
export function findFirstTagText(html: string, tagName: string, mask?: TagMask): string | undefined {
  const first = findTags(html, tagName, mask).next();
  if (first.done) return undefined;
  // The text runs to the first `</name`, as an RCDATA element's does in a browser.
  const close = new RegExp(`</${tagName.toLowerCase()}${NAME_END}`, "gi");
  close.lastIndex = first.value.contentStart;
  const m = close.exec(html);
  return m === null ? undefined : html.slice(first.value.contentStart, m.index);
}

/**
 * Find the content of every balanced `<tagName>...</tagName>` pair in the
 * order they open, outermost only: for `<article><article>inner</article></article>`
 * the result is the outer article's content, which holds the inner tag. A
 * self-closing opener gives "". Stops at the first opener that never closes.
 * Built on `forEachBalancedTag`, so it is one linear pass; the depth walk it
 * replaced re-searched the input from every nested opener.
 */
export function findBalancedTagContents(html: string, tagName: string, mask?: TagMask): string[] {
  const results: string[] = [];
  forEachBalancedTag(html, tagName, mask, (_start, contentStart, contentEnd, depth) => {
    if (depth === 0) results.push(html.slice(contentStart, contentEnd));
    return undefined;
  });
  return results;
}

/** The first of `findBalancedTagContents`, without walking past it. */
export function firstBalancedTagContent(html: string, tagName: string, mask?: TagMask): string | undefined {
  let found: string | undefined;
  forEachBalancedTag(html, tagName, mask, (_start, contentStart, contentEnd, depth) => {
    if (depth !== 0) return undefined;
    found = html.slice(contentStart, contentEnd);
    return true;
  });
  return found;
}

/**
 * Find the first balanced tag whose content (trimmed) passes `accept`.
 * Returns the raw inner HTML, or null if no block qualifies.
 */
export function findFirstBalancedTagWhere(
  html: string,
  tagName: string,
  accept: (content: string) => boolean,
  mask?: TagMask,
): string | null {
  for (const content of findBalancedTagContents(html, tagName, mask)) {
    if (accept(content)) return content;
  }
  return null;
}
