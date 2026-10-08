import type { HttpResponse } from "./http.js";

/** Characters of tool output shown before the truncation marker. */
export const DISPLAY_MAX_CHARS = 50_000;

/**
 * Once the display cap is reached, the serializer keeps walking only to count
 * the characters it cuts. Past this many more values it stops counting (a
 * shared-reference graph can be far larger than any input that built it) and
 * the marker says "more than".
 */
const MAX_VALUES_PAST_CAP = 2_000_000;

function truncationMarker(cut: number, atLeast = false): string {
  return `\n\n[... truncated ${atLeast ? "more than " : ""}${cut} chars ...]`;
}

function truncateForDisplay(s: string, max = DISPLAY_MAX_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}${truncationMarker(s.length - max)}`;
}

const OMIT = Symbol("omit");

/**
 * One value as `JSON.stringify` sees it: `toJSON` applied, boxed primitives
 * unwrapped. Returns the literal text of a primitive, the object or array
 * itself, or `OMIT` for what JSON leaves out (undefined, functions, symbols).
 */
function prepare(input: unknown, key: string): string | object | typeof OMIT {
  let v = input;
  if ((typeof v === "object" && v !== null) || typeof v === "bigint") {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") v = toJSON.call(v, key);
  }
  if (typeof v === "object" && v !== null) {
    if (v instanceof Number) v = Number(v);
    else if (v instanceof String) v = String(v);
    else if (v instanceof Boolean) v = v.valueOf();
    else return v;
  }
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      return Number.isFinite(v) ? String(v) : "null";
    case "boolean":
      return v ? "true" : "false";
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    default:
      return v === null ? "null" : OMIT;
  }
}

/** Collects output up to `max` characters and counts everything written. */
class CappedWriter {
  private readonly parts: string[] = [];
  emitted = 0;
  total = 0;
  constructor(readonly max: number) {}

  write(s: string): void {
    this.total += s.length;
    if (this.emitted >= this.max) return;
    const room = this.max - this.emitted;
    const part = s.length <= room ? s : s.slice(0, room);
    this.parts.push(part);
    this.emitted += part.length;
  }

  /** A newline plus two spaces per level; the string is built only while it can be shown. */
  newline(depth: number): void {
    if (this.emitted >= this.max) this.total += 1 + 2 * depth;
    else this.write(`\n${"  ".repeat(depth)}`);
  }

  text(): string {
    return this.parts.join("");
  }
}

interface Frame {
  value: object;
  /** null for an array. */
  keys: string[] | null;
  i: number;
  depth: number;
  members: number;
}

/**
 * Exactly `truncateForDisplay(JSON.stringify(value, null, 2), max)`, built
 * without the full string: it stops writing at `max` characters and only
 * counts the rest, so a result whose pretty-printed form runs to hundreds of
 * megabytes (deeply nested JSON-LD indents every level) costs `max`
 * characters of output. Iterative, so nesting depth cannot overflow the stack.
 * Returns undefined where `JSON.stringify` does (a top-level undefined,
 * function or symbol) and throws where it throws (a cycle, a BigInt).
 */
export function stringifyForDisplay(value: unknown, max = DISPLAY_MAX_CHARS): string | undefined {
  const w = new CappedWriter(max);
  const stack: Frame[] = [];
  const open = new Set<object>();

  const emit = (v: string | object, depth: number): void => {
    if (typeof v === "string") {
      w.write(v);
      return;
    }
    if (open.has(v)) throw new TypeError("Converting circular structure to JSON");
    if (Array.isArray(v)) {
      if (v.length === 0) {
        w.write("[]");
        return;
      }
      w.write("[");
      stack.push({ value: v, keys: null, i: 0, depth, members: 0 });
    } else {
      const keys = Object.keys(v);
      if (keys.length === 0) {
        w.write("{}");
        return;
      }
      // "{" is written with the first member: an object whose members are
      // all omitted prints as "{}".
      stack.push({ value: v, keys, i: 0, depth, members: 0 });
    }
    open.add(v);
  };

  const first = prepare(value, "");
  if (first === OMIT) return undefined;
  emit(first, 0);

  let pastCap = 0;
  let abandoned = false;
  while (stack.length > 0) {
    if (w.emitted >= max && ++pastCap > MAX_VALUES_PAST_CAP) {
      abandoned = true;
      break;
    }
    const f = stack[stack.length - 1] as Frame;
    if (f.keys === null) {
      const arr = f.value as unknown[];
      if (f.i >= arr.length) {
        w.newline(f.depth);
        w.write("]");
        stack.pop();
        open.delete(f.value);
        continue;
      }
      const idx = f.i++;
      if (idx > 0) w.write(",");
      w.newline(f.depth + 1);
      const v = prepare(arr[idx], String(idx));
      emit(v === OMIT ? "null" : v, f.depth + 1);
    } else {
      if (f.i >= f.keys.length) {
        if (f.members === 0) w.write("{}");
        else {
          w.newline(f.depth);
          w.write("}");
        }
        stack.pop();
        open.delete(f.value);
        continue;
      }
      const k = f.keys[f.i++] as string;
      const v = prepare((f.value as Record<string, unknown>)[k], k);
      if (v === OMIT) continue;
      w.write(f.members++ === 0 ? "{" : ",");
      w.newline(f.depth + 1);
      w.write(JSON.stringify(k));
      w.write(": ");
      emit(v, f.depth + 1);
    }
  }

  if (!abandoned && w.total <= max) return w.text();
  return `${w.text()}${truncationMarker(w.total - max, abandoned)}`;
}

export function formatHttpResponse(res: HttpResponse): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (res.error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Request failed: ${res.error}` }],
    };
  }

  const lines: string[] = [];
  lines.push(`HTTP/1.1 ${res.status} ${res.statusText}`.trimEnd());
  lines.push(`URL: ${res.url}`);
  if (res.redirects.length > 0) lines.push(`Redirects: ${res.redirects.length} hop(s)`);
  lines.push(`Duration: ${res.durationMs}ms`);
  lines.push("");
  lines.push("--- Headers ---");
  const keys = Object.keys(res.headers).sort();
  for (const k of keys) lines.push(`${k}: ${res.headers[k]}`);
  lines.push("");
  if (res.truncated) lines.push(`[body truncated at response-size cap]`);
  let jsonText: string | undefined;
  if (res.json !== undefined) {
    try {
      jsonText = stringifyForDisplay(res.json);
    } catch {
      // Parsed JSON has no cycles or BigInts; should it ever fail, show the raw body instead.
      jsonText = undefined;
    }
  }
  if (jsonText !== undefined) {
    lines.push("--- Body (parsed JSON) ---");
    lines.push(jsonText);
  } else if (res.bodyText !== undefined) {
    lines.push("--- Body ---");
    lines.push(truncateForDisplay(res.bodyText));
  } else if (res.bodyBase64 !== undefined) {
    lines.push(`--- Body (base64, ${res.bodyBase64.length} chars) ---`);
    lines.push(truncateForDisplay(res.bodyBase64));
  }
  return {
    isError: !res.ok,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

/**
 * A tool result as pretty-printed JSON, cut at the display cap. Bounded for
 * any value (see `stringifyForDisplay`) and never throws: a value JSON cannot
 * represent comes back as `formatError`.
 */
export function formatJson(value: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (typeof value === "string") return { content: [{ type: "text", text: truncateForDisplay(value) }] };
  let text: string | undefined;
  try {
    text = stringifyForDisplay(value);
  } catch (e) {
    return formatError(`could not format the result: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (text === undefined) return formatError("could not format the result: it has no JSON form");
  return { content: [{ type: "text", text }] };
}

export function formatError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}
