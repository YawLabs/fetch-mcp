/**
 * Small, pragmatic HTML utilities shared by the reader / meta / links tools.
 * We intentionally avoid pulling in a full DOM parser — the turndown library
 * used by the markdown path already carries that weight, and these helpers
 * only need to survive real-world HTML well enough to find head metadata,
 * anchor tags, and article bodies.
 *
 * Key correctness points:
 *   - attribute values may contain `>` inside quotes, so we can't use the
 *     naive `<tag[^>]+>` regex
 *   - article / main / section can nest, so non-greedy regex picks the wrong
 *     closing tag; we pair openers and closers in one bracket-matching pass
 */

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

const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos|nbsp));/g;

/**
 * Decode the narrow set of HTML entities we encounter in attribute values and
 * short runs of text. This is not a full entity decoder — it covers the named
 * entities that matter (&amp; &lt; &gt; &quot; &apos; &nbsp;) plus the
 * numeric forms &#N; and &#xN;.
 *
 * One pass over the input, so the output of one entity is never read as the
 * start of another: `&amp;lt;` decodes to the text `&lt;`, not to `<`. Code
 * points the HTML spec refuses (NUL, surrogates, past U+10FFFF) decode to
 * U+FFFD instead of reaching `String.fromCodePoint`, which throws past U+10FFFF.
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(ENTITY_RE, (_, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name]!;
    return codePointToString(hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec!, 10));
  });
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
export function* findTags(html: string, tagName: string): Generator<FoundTag> {
  const name = tagName.toLowerCase();
  const pattern = new RegExp(`<${name}\\b`, "gi");
  pattern.lastIndex = 0;
  for (;;) {
    const m = pattern.exec(html);
    if (m === null) break;
    const start = m.index;
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

export interface BalancedTag {
  /** Offset of the opening tag's `<`. */
  start: number;
  /** Offset just past the opening tag's `>`. */
  contentStart: number;
  /** Offset of the matching close tag's `<`, or -1 when the element never closes. */
  contentEnd: number;
  /** The opening tag's attribute text, as `findTags` gives it. */
  attrsText: string;
  /** The opening tag ended in `/>`. */
  selfClosing: boolean;
}

/**
 * Every `<tagName>` opener paired with its matching close, in one pass over
 * the input: openers and closers are matched like brackets, which pairs each
 * opener with the same close a depth-counting walk from it would find. Walking
 * from each opener separately made a page of many unclosed openers quadratic.
 * An opening tag cut off by the end of the input ends the scan, as it swallows
 * everything after it in a browser.
 */
export function matchBalancedTags(html: string, tagName: string): BalancedTag[] {
  const name = tagName.toLowerCase();
  const re = new RegExp(`<${name}\\b|</\\s*${name}\\s*>`, "gi");
  const all: BalancedTag[] = [];
  const open: BalancedTag[] = [];
  for (;;) {
    const m = re.exec(html);
    if (m === null) break;
    if (m[0][1] === "/") {
      const opener = open.pop();
      if (opener) opener.contentEnd = m.index;
      continue;
    }
    const end = findTagEnd(html, m.index + m[0].length);
    if (end === null) break;
    const rawAttrs = html.slice(m.index + m[0].length, end.pos);
    const tag: BalancedTag = {
      start: m.index,
      contentStart: end.pos + 1,
      contentEnd: -1,
      attrsText: end.selfClosing ? rawAttrs.slice(0, -1) : rawAttrs,
      selfClosing: end.selfClosing,
    };
    all.push(tag);
    if (end.selfClosing) tag.contentEnd = tag.contentStart;
    else open.push(tag);
    re.lastIndex = end.pos + 1;
  }
  return all;
}

/**
 * The raw content of the first `<tagName>` element, up to its first close tag,
 * or undefined when there is no such element or it never closes. One search
 * from the first opener: a lazy `<title>([\s\S]*?)</title>` regex retried
 * from every opener, so a page of unclosed `<title>`s was quadratic.
 */
export function findFirstTagText(html: string, tagName: string): string | undefined {
  const first = findTags(html, tagName).next();
  if (first.done) return undefined;
  const close = new RegExp(`</${tagName.toLowerCase()}\\s*>`, "gi");
  close.lastIndex = first.value.contentStart;
  const m = close.exec(html);
  return m === null ? undefined : html.slice(first.value.contentStart, m.index);
}

/**
 * Find the content of every balanced `<tagName>...</tagName>` pair in the
 * order they open, outermost only: for `<article><article>inner</article></article>`
 * the result is the outer article's content, which holds the inner tag. A
 * self-closing opener gives "". Stops at the first opener that never closes.
 * Built on `matchBalancedTags`, so it is one linear pass; the depth walk it
 * replaced re-searched the input from every nested opener.
 */
export function findBalancedTagContents(html: string, tagName: string): string[] {
  const results: string[] = [];
  let outerEnd = 0;
  for (const tag of matchBalancedTags(html, tagName)) {
    if (tag.start < outerEnd) continue;
    if (tag.selfClosing) {
      results.push("");
      continue;
    }
    if (tag.contentEnd === -1) break;
    results.push(html.slice(tag.contentStart, tag.contentEnd));
    outerEnd = tag.contentEnd;
  }
  return results;
}

/**
 * Find the first balanced tag whose content (trimmed) passes `accept`.
 * Returns the raw inner HTML, or null if no block qualifies.
 */
export function findFirstBalancedTagWhere(
  html: string,
  tagName: string,
  accept: (content: string) => boolean,
): string | null {
  for (const content of findBalancedTagContents(html, tagName)) {
    if (accept(content)) return content;
  }
  return null;
}
