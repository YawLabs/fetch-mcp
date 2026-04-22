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
 *     closing tag; we use a depth-aware scanner instead
 */

/**
 * Parse a single tag's attribute text ("name=\"foo\" content=\"a > b\"")
 * into a lowercase-keyed record. Empty attributes resolve to "".
 */
export function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?=\s|\/|$)/g;
  for (const m of s.matchAll(re)) {
    if (m[1]) {
      attrs[m[1].toLowerCase()] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? "");
    } else if (m[5]) {
      attrs[m[5].toLowerCase()] = "";
    }
  }
  return attrs;
}

/**
 * Decode the narrow set of HTML entities we encounter in attribute values and
 * short runs of text. This is not a full entity decoder — it covers the named
 * entities that matter (&amp; &lt; &gt; &quot; &apos; &#39; &nbsp;) plus the
 * numeric forms &#N; and &#xN;.
 */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => {
      const n = Number.parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number.parseInt(d, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
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
    const attrsText = rawAttrs.replace(/\/\s*$/, "");
    yield {
      start,
      contentStart: end.pos + 1,
      attrsText,
      selfClosing: end.selfClosing,
    };
    pattern.lastIndex = end.pos + 1;
  }
}

interface TagEnd {
  pos: number;
  selfClosing: boolean;
}

/**
 * Given the index just past the tag name, find the `>` that closes the
 * opening tag while skipping `>` inside quoted attribute values. Returns
 * null when the tag never closes (malformed input).
 */
function findTagEnd(html: string, from: number): TagEnd | null {
  let i = from;
  let quote: '"' | "'" | null = null;
  let prevIsSlash = false;
  while (i < html.length) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch as '"' | "'";
      else if (ch === ">") return { pos: i, selfClosing: prevIsSlash };
    }
    prevIsSlash = ch === "/" && !quote;
    i++;
  }
  return null;
}

/**
 * Find the content of every balanced `<tagName>...</tagName>` pair in the
 * order they open. Respects nesting: for `<article><article>inner</article></article>`
 * the inner article is its own entry and the outer entry contains the whole
 * inner tag inside its content. Malformed / unclosed tags are silently skipped.
 */
export function findBalancedTagContents(html: string, tagName: string): string[] {
  const openerSeeker = new RegExp(`<${tagName.toLowerCase()}\\b`, "gi");
  const closeRe = new RegExp(`</\\s*${tagName.toLowerCase()}\\s*>`, "gi");
  const openRe = new RegExp(`<${tagName.toLowerCase()}\\b`, "gi");
  const results: string[] = [];

  openerSeeker.lastIndex = 0;
  for (;;) {
    const outer = openerSeeker.exec(html);
    if (outer === null) break;
    const headerEnd = findTagEnd(html, outer.index + outer[0].length);
    if (headerEnd === null) break;
    if (headerEnd.selfClosing) {
      results.push("");
      openerSeeker.lastIndex = headerEnd.pos + 1;
      continue;
    }
    const contentStart = headerEnd.pos + 1;
    // Walk forward matching opens against closes, tracking depth.
    let depth = 1;
    let scan = contentStart;
    while (depth > 0) {
      openRe.lastIndex = scan;
      closeRe.lastIndex = scan;
      const nextOpen = openRe.exec(html);
      const nextClose = closeRe.exec(html);
      if (!nextClose) break; // malformed
      if (nextOpen && nextOpen.index < nextClose.index) {
        const innerHead = findTagEnd(html, nextOpen.index + nextOpen[0].length);
        if (innerHead === null) {
          scan = nextOpen.index + nextOpen[0].length;
          continue;
        }
        if (!innerHead.selfClosing) depth++;
        scan = innerHead.pos + 1;
      } else {
        depth--;
        if (depth === 0) {
          results.push(html.slice(contentStart, nextClose.index));
          openerSeeker.lastIndex = nextClose.index + nextClose[0].length;
          break;
        }
        scan = nextClose.index + nextClose[0].length;
      }
    }
    if (depth > 0) break;
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
