/**
 * HTML-to-markdown, bounded. Security-critical: the page is attacker-chosen.
 *
 * Through 0.8.3 the tools handed the page to the npm `turndown` package, which
 * parsed it with domino in ONE synchronous call that neither `timeout_ms` nor
 * cancellation could interrupt, so a single fetched page stalled the whole
 * stdio server: misnested markup is quadratic in domino, 35 KB of
 * `<b id=N><p>x` exhausted a 4 GB heap, about 1,150 levels of nesting threw a
 * stack overflow, and Turndown itself was quadratic on large flat pages.
 *
 * Here the page is parsed with domino's incremental parser in PARSE_SLICE_MS
 * slices that yield to the event loop, under a deadline, the caller's signal
 * and a DOM budget (nodes, attributes and template content). A page longer
 * than MAX_MARKDOWN_INPUT is refused outright, and at most
 * MAX_CONCURRENT_CONVERSIONS conversions, holding at most MAX_INPUT_IN_FLIGHT
 * input characters between them, run at once, and only one synchronous step
 * (tree walk plus Turndown) runs per event-loop turn; nesting deeper than
 * MAX_MARKDOWN_DEPTH, and more than MAX_TAG_NAMES distinct tag names, are
 * refused before Turndown sees the tree;
 * and the vendored Turndown (src/vendor/turndown, eleven patches) converts it
 * with O(1) work per node, under the same deadline, cut to MAX_TURNDOWN_MS
 * from the start of this synchronous step (checked at every node, as
 * replacement work accumulates, and every 64 Ki characters of any one string
 * operation, however long the text node, attribute or content it works on),
 * an output cap of OUTPUT_FACTOR x the page plus OUTPUT_SLACK characters and a
 * work cap of WORK_FACTOR x the page plus WORK_SLACK characters. It
 * skips the subtrees whose output would be discarded (blank and removed
 * elements) and keeps no per-level copy of nested whitespace, so the heap it
 * retains stays linear in the page.
 *
 * This is the only module that may import @mixmark-io/domino or the vendored
 * Turndown. Never import the npm `turndown` package, and never call
 * `domino.createDocument` on fetched HTML (CLAUDE.md, Launch-critical #22).
 */
import domino, { type DomElement } from "@mixmark-io/domino";
import { CANCELLED, DEFAULT_TIMEOUT_MS } from "./http.js";
import TurndownService, { ConversionDeadlineError, ConversionLimitError } from "./vendor/turndown/turndown.js";

/**
 * Deepest element nesting converted. Turndown and domino recurse per level and
 * overflow the stack at about 1,150 on Node (1,250-2,000 on oam); the deepest
 * of 20 real pages measured was 34.
 */
export const MAX_MARKDOWN_DEPTH = 256;
/**
 * Most distinct tag names (and their total length) a converted page may use.
 * domino caches every HTML tag name it uppercases in a module-level map that
 * is never cleared, so each distinct name a page invents stays in the heap for
 * the life of the process. The 20 real pages measured used at most 68 names,
 * 685 characters in all.
 */
export const MAX_TAG_NAMES = 1024;
export const MAX_TAG_NAME_CHARS = 16_384;
/**
 * Output cap: the markdown collected for any one element's children may not
 * pass OUTPUT_FACTOR x the page length plus OUTPUT_SLACK characters (checked
 * before it is joined). The largest on the 20 real pages was 0.77x the page.
 * npm turndown had no cap, so this refuses some pages 0.8.3 converted:
 * nesting that re-prefixes a long block at every level, such as list items
 * or blockquotes nested a few dozen deep around one long <pre>.
 */
export const OUTPUT_FACTOR = 4;
export const OUTPUT_SLACK = 1024 * 1024;
/**
 * Work cap: Turndown's replacement work (characters escaped, trimmed,
 * re-prefixed and joined, counted before it runs) may not pass WORK_FACTOR x
 * the page length plus WORK_SLACK characters in all. Nested blockquotes or
 * list items re-prefix every line of their content at each level, so 200
 * levels around flat text multiply the work 1,000-30,000x without any one
 * parent's output passing the output cap. The 20 real pages measured charged
 * at most 8.4x their length (repeated to 4-6 MiB, the same).
 */
export const WORK_FACTOR = 64;
export const WORK_SLACK = 16 * 1024 * 1024;
/**
 * Longest the Turndown phase may run, whatever the budget. It is synchronous
 * (bounded by the deadline and the caps above, not by yielding), so it holds
 * the event loop, and every other request and cancellation, for as long as it
 * runs; with `timeout_ms` up to 120 s that was a 16-37 s stall. Measured on
 * Node 22, the slowest real page (the 20 pages, and each repeated to 4-8 MiB)
 * held the loop 1.2 s, parse slices and tree walk included; a third of this.
 * The worst hostile shape found holds it ~2.2 s. Concurrent conversions take
 * turns at this step (the step gate below), so the stall never adds up.
 */
export const MAX_TURNDOWN_MS = 4000;
/**
 * DOM budget: MIN_NODE_BUDGET plus one node per NODE_BUDGET_CHARS input
 * characters, at most MAX_NODE_BUDGET. Each attribute counts as
 * 1/ATTRS_PER_NODE of a node, and nodes inside <template> content count too.
 * Measured on Node 22, a parsed-and-converted node costs about 1 KB of peak
 * RSS and an attribute about 160-180 B, so the cap holds one conversion near
 * 250 MB. The 20 real pages measured built at most 42,440 nodes (0.05 per
 * character); their budgets were 6x or more of what they used.
 */
export const MIN_NODE_BUDGET = 100_000;
export const NODE_BUDGET_CHARS = 8;
export const MAX_NODE_BUDGET = 250_000;
export const ATTRS_PER_NODE = 4;
/**
 * Longest page (in UTF-16 code units) converted at all; longer is refused
 * before anything is built. Peak memory scales with the text as well as the
 * DOM: measured on Node 22's default heap, one 8 MiB conversion of the worst
 * shapes found (flat lines or paragraphs under 200 nested blockquotes, a
 * <pre> under 30 nested blockquotes or 100 list items, text-heavy tables,
 * escape-heavy text) raises peak RSS by 140-780 MB, most of it garbage V8 has
 * not collected yet: every one completes under --max-old-space-size=256,
 * peaking at 270-370 MB of RSS. One of 100 MiB took 1.5-3 GB. 8 MiB is above the 5 MiB default `max_bytes`, so a page
 * fetched with the defaults is never refused for size; the largest of the 20
 * real pages measured was 2.96 M characters.
 */
export const MAX_MARKDOWN_INPUT = 8 * 1024 * 1024;
/**
 * Conversions that may hold a DOM at once, and the input characters they may
 * hold between them; a call is always admitted when none is running. At 1.5x
 * MAX_MARKDOWN_INPUT, two pages near the ceiling never convert together (an
 * admitted pair of the worst shapes, 6 MiB each, raised peak RSS by 650-740
 * MB on the default heap and completed under --max-old-space-size=256 at
 * 300-390 MB of RSS), while pages of
 * ordinary size still run two at a time. A call past either limit waits in a
 * FIFO queue holding only its input string; the wait counts against its
 * budget and ends early on its signal or deadline. Sliced parses interleave,
 * so without these limits every concurrent call held a full DOM at once (8
 * calls of 1 MiB: 2.7 GB).
 */
export const MAX_CONCURRENT_CONVERSIONS = 2;
export const MAX_INPUT_IN_FLIGHT = MAX_MARKDOWN_INPUT + MAX_MARKDOWN_INPUT / 2;
/** Longest the parser runs before yielding to the event loop. */
const PARSE_SLICE_MS = 10;
/** The pause hook runs once per input character step; look at the clock every Nth call. */
const PAUSE_CHECK_EVERY = 64;
/** The tree-shape walk checks the deadline every Nth element. */
const DEPTH_DEADLINE_CHECK = 256;

/** The wrapper upstream Turndown parsed strings in; keeping it keeps output byte-identical. */
const ROOT_ID = "turndown-root";

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
    // PATCH (k): the subtree is dropped unconverted, not converted and discarded.
    ignoresContent: true,
  });
  td.addRule("removeNav", {
    filter: (node) => node.tagName === "NAV" || node.tagName === "FOOTER" || node.tagName === "ASIDE",
    replacement: () => "",
    ignoresContent: true,
  });
  return td;
}

type Stop = "deadline" | "nodes" | "cancelled";

interface ParseOptions {
  deadline: number;
  signal?: AbortSignal;
  maxNodes: number;
}

/**
 * domino's private document state the budget reads (pinned with the exact
 * domino version; src/tests/markdown.test.ts fails if any of it moves).
 * Rooting a node gives it the next `_nid` and stores it in `_nodes`, after
 * the parser has set its attributes, which live in `_attrKeys`.
 */
export interface DocInternals {
  _nextnid: number;
  _nodes: Array<{ _attrKeys?: unknown[]; _nid?: number } | null | undefined>;
  _templateDocCache: DocInternals | null;
  modclock: number;
  implementation: { createHTMLDocument(): DocInternals };
  createDocumentFragment(): { _nid?: number };
}

/**
 * The DOM a parse has built so far, in nodes: every rooted node of `doc` and
 * of its inert template document, plus 1/ATTRS_PER_NODE per attribute. Scans
 * only the nodes rooted since the last call, so it is O(1) per node overall.
 */
class DomWeight {
  private readonly docs: DocInternals[];
  private readonly scanned: number[];
  private attrs = 0;
  constructor(...docs: DocInternals[]) {
    this.docs = docs;
    this.scanned = docs.map((d) => d._nextnid);
  }
  get value(): number {
    let nodes = 0;
    for (let i = 0; i < this.docs.length; i++) {
      const d = this.docs[i]!;
      for (let nid = this.scanned[i]!; nid < d._nextnid; nid++) this.attrs += d._nodes[nid]?._attrKeys?.length ?? 0;
      this.scanned[i] = d._nextnid;
      nodes += d._nextnid;
    }
    return nodes + this.attrs / ATTRS_PER_NODE;
  }
}

/**
 * domino builds <template> content in an inert document whose nodes are
 * never rooted, so neither `_nextnid` nor `_nodes` saw them: 36 KB of
 * `<template>` then `<b id=N><p>x` built 2.6 GB. Give the parse its own inert
 * document whose content fragments are rooted in it, so every node and
 * attribute under a template is numbered and counted like the main tree's.
 * The trees built are unchanged (Turndown never reads template content).
 */
export function countedTemplateDoc(doc: DocInternals): DocInternals {
  const inert = doc.implementation.createHTMLDocument();
  inert.modclock = 0; // as in a parse: no per-insertion ancestor walk
  inert._templateDocCache = inert; // nested templates share it, as domino's own does
  const createFragment = inert.createDocumentFragment;
  Object.defineProperty(inert, "createDocumentFragment", {
    value() {
      const fragment = createFragment.call(inert);
      fragment._nid = inert._nextnid++;
      inert._nodes[fragment._nid] = fragment;
      return fragment;
    },
  });
  doc._templateDocCache = inert;
  return inert;
}

/**
 * Parse `html` (already wrapped) with domino's incremental parser, yielding
 * every PARSE_SLICE_MS. Stops at the deadline, on the signal, or once the
 * DOM weighs more than `maxNodes` (DomWeight).
 */
async function parseBounded(html: string, opts: ParseOptions): Promise<{ root: DomElement | null } | { stop: Stop }> {
  const parser = domino.createIncrementalHTMLParser();
  parser.end(html); // queues the input; nothing is parsed until process()
  const doc = parser.document() as unknown as DocInternals;
  const weight = new DomWeight(doc, countedTemplateDoc(doc));
  for (;;) {
    const sliceStart = performance.now();
    let calls = 0;
    // An object, not a `let`: TypeScript does not see the closure assign it.
    const slice: { stop: Stop | null } = { stop: null };
    const more = parser.process(() => {
      // Every step: one token can clone a whole list of formatting elements.
      if (weight.value > opts.maxNodes) {
        slice.stop = "nodes";
        return true;
      }
      if (++calls % PAUSE_CHECK_EVERY !== 0) return false;
      const now = performance.now();
      if (now >= opts.deadline) {
        slice.stop = "deadline";
        return true;
      }
      return now - sliceStart >= PARSE_SLICE_MS;
    });
    if (slice.stop) return { stop: slice.stop };
    if (weight.value > opts.maxNodes) return { stop: "nodes" };
    if (!more) return { root: parser.document().getElementById(ROOT_ID) };
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (opts.signal?.aborted) return { stop: "cancelled" };
    if (performance.now() >= opts.deadline) return { stop: "deadline" };
  }
}

interface TreeShape {
  /** Deepest element nesting under the root (its children are depth 1). */
  depth: number;
  /** Distinct tag names, and their total length, counted up to the limits. */
  names: number;
  nameChars: number;
}

/**
 * Walks the tree under `root` with an explicit stack (recursion is exactly
 * what a deep page attacks). Names come from `localName` and `prefix`, never
 * tagName/nodeName, which would fill domino's uppercase cache this walk exists
 * to protect. Stops counting names once past a limit. Returns null if the
 * deadline passes first.
 */
function treeShape(root: DomElement, deadline: number): TreeShape | null {
  let depthMax = 0;
  let seen = 0;
  const names = new Set<string>();
  let nameChars = 0;
  let countNames = true;
  const elements: DomElement[] = [root];
  const depths: number[] = [0];
  while (elements.length > 0) {
    const el = elements.pop()!;
    const depth = depths.pop()!;
    if (depth > depthMax) depthMax = depth;
    if (++seen % DEPTH_DEADLINE_CHECK === 0 && performance.now() > deadline) return null;
    if (countNames) {
      const name = el.prefix === null ? el.localName : `${el.prefix}:${el.localName}`;
      if (!names.has(name)) {
        names.add(name);
        nameChars += name.length;
        if (names.size > MAX_TAG_NAMES || nameChars > MAX_TAG_NAME_CHARS) countNames = false;
      }
    }
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      elements.push(child);
      depths.push(depth + 1);
    }
  }
  return { depth: depthMax, names: names.size, nameChars };
}

type SlotOutcome = "ok" | "deadline" | "cancelled";
interface Waiter {
  chars: number;
  deadline: number;
  signal?: AbortSignal;
  settle(outcome: SlotOutcome): void;
}
let activeConversions = 0;
let charsInFlight = 0;
const waiting: Waiter[] = [];
let pumpScheduled = false;

/** How many conversions hold a slot, their input characters, and how many wait (for tests and diagnostics). */
export function conversionSlots(): { active: number; waiting: number; chars: number } {
  return { active: activeConversions, waiting: waiting.length, chars: charsInFlight };
}

function admits(chars: number): boolean {
  if (activeConversions === 0) return true;
  return activeConversions < MAX_CONCURRENT_CONVERSIONS && charsInFlight + chars <= MAX_INPUT_IN_FLIGHT;
}

/**
 * Hand free capacity to the queue, in FIFO order. A waiter whose deadline has
 * passed or whose signal fired is settled and dropped, never granted: when a
 * conversion has blocked the loop, its timer has not fired yet. Runs from
 * setImmediate, so the event loop turns between one conversion and the next.
 */
function pump(): void {
  pumpScheduled = false;
  while (waiting.length > 0) {
    const head = waiting[0]!;
    if (head.signal?.aborted) {
      waiting.shift();
      head.settle("cancelled");
    } else if (performance.now() >= head.deadline) {
      waiting.shift();
      head.settle("deadline");
    } else if (admits(head.chars)) {
      waiting.shift();
      activeConversions++;
      charsInFlight += head.chars;
      head.settle("ok");
    } else {
      return;
    }
  }
}

function schedulePump(): void {
  if (pumpScheduled || waiting.length === 0) return;
  pumpScheduled = true;
  setImmediate(pump);
}

/**
 * Wait in `queue` until a pump settles this waiter, or leave it at the
 * deadline or on the signal (then `kick` the pump: the head may have been what
 * blocked the rest).
 */
function enqueue(
  queue: Waiter[],
  chars: number,
  deadline: number,
  signal: AbortSignal | undefined,
  kick: () => void,
): Promise<SlotOutcome> {
  return new Promise((resolve) => {
    const leave = (outcome: "deadline" | "cancelled") => {
      const i = queue.indexOf(waiter);
      if (i === -1) return; // already settled
      queue.splice(i, 1);
      waiter.settle(outcome);
      kick();
    };
    const onAbort = () => leave("cancelled");
    const timer = setTimeout(() => leave("deadline"), Math.max(0, deadline - performance.now()));
    const waiter: Waiter = {
      chars,
      deadline,
      signal,
      settle(outcome) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(waiter);
  });
}

/**
 * Take a slot for a `chars`-character conversion, waiting in FIFO order.
 * Gives up, leaving the queue, at the deadline or on the signal. The caller
 * must call releaseSlot(chars) once for every "ok".
 */
function acquireSlot(chars: number, deadline: number, signal?: AbortSignal): Promise<SlotOutcome> {
  if (waiting.length === 0 && admits(chars)) {
    activeConversions++;
    charsInFlight += chars;
    return Promise.resolve("ok");
  }
  return enqueue(waiting, chars, deadline, signal, schedulePump);
}

function releaseSlot(chars: number): void {
  activeConversions--;
  charsInFlight -= chars;
  schedulePump();
}

/*
 * The synchronous step gate. Each admitted conversion ends in one synchronous
 * step (tree-shape walk plus Turndown, up to MAX_TURNDOWN_MS). Two parses that
 * finish in the same check phase, or in one microtask drain, used to run their
 * steps back to back, so the loop stalled for the sum (two 6 MiB pages:
 * 3.2-4.1 s; a 100 ms abort timer fired at 4.1 s). Steps run one at a time,
 * each granted from its own setImmediate scheduled after the previous step
 * ended, so timers, I/O and cancellations run between any two steps, and a
 * parse that finished inside the caller's microtask yields before its step.
 */
const stepQueue: Waiter[] = [];
let stepRunning = false;
let stepPumpScheduled = false;

/** Whether a synchronous step runs, and how many wait for one (for tests and diagnostics). */
export function turndownSteps(): { running: boolean; waiting: number } {
  return { running: stepRunning, waiting: stepQueue.length };
}

function scheduleStepPump(): void {
  if (stepPumpScheduled || stepRunning || stepQueue.length === 0) return;
  stepPumpScheduled = true;
  setImmediate(stepPump);
}

/** Grants the step to the first live waiter; settles the expired and cancelled ones it passes. */
function stepPump(): void {
  stepPumpScheduled = false;
  while (!stepRunning && stepQueue.length > 0) {
    const head = stepQueue.shift()!;
    if (head.signal?.aborted) head.settle("cancelled");
    else if (performance.now() >= head.deadline) head.settle("deadline");
    else {
      stepRunning = true;
      head.settle("ok");
    }
  }
}

/** Wait for this conversion's turn at the synchronous step. Call releaseStep() once for every "ok". */
function acquireStep(deadline: number, signal?: AbortSignal): Promise<SlotOutcome> {
  const turn = enqueue(stepQueue, 0, deadline, signal, scheduleStepPump);
  scheduleStepPump();
  return turn;
}

function releaseStep(): void {
  stepRunning = false;
  scheduleStepPump();
}

export interface HtmlToMarkdownOptions {
  /** Cancels the conversion (tools pass the MCP request's `extra.signal`). */
  signal?: AbortSignal;
  /** Whole-conversion budget in ms, counted from the call (default DEFAULT_TIMEOUT_MS). */
  budgetMs?: number;
  /** Cap on the synchronous Turndown step, clamped to MAX_TURNDOWN_MS (the default); only tests lower it. */
  turndownMs?: number;
}

/**
 * Convert HTML to markdown within `budgetMs`. Never throws: a refusal, the
 * budget running out, cancellation and any unexpected failure all come back
 * as `{ error }`. A page over MAX_MARKDOWN_INPUT is refused at once. At most
 * MAX_CONCURRENT_CONVERSIONS run at once, holding at most MAX_INPUT_IN_FLIGHT
 * input characters; a call waits for a slot before it builds anything, and
 * the wait counts against its budget.
 */
export async function htmlToMarkdown(
  html: string,
  { signal, budgetMs = DEFAULT_TIMEOUT_MS, turndownMs = MAX_TURNDOWN_MS }: HtmlToMarkdownOptions = {},
): Promise<{ markdown: string } | { error: string }> {
  const budgetError = {
    error: `HTML-to-markdown conversion exceeded its ${budgetMs} ms budget; fetch_html_to_text handles this page in linear time`,
  };
  if (signal?.aborted) return { error: CANCELLED };
  if (html.length > MAX_MARKDOWN_INPUT) {
    return {
      error: `page is ${html.length} characters, over the ${MAX_MARKDOWN_INPUT}-character limit for markdown conversion; fetch_html_to_text handles this page in linear time`,
    };
  }
  const deadline = performance.now() + budgetMs;
  const slot = await acquireSlot(html.length, deadline, signal);
  if (slot === "cancelled") return { error: CANCELLED };
  if (slot === "deadline") return budgetError;
  try {
    return await convert(html, deadline, Math.min(turndownMs, MAX_TURNDOWN_MS), signal, budgetError);
  } catch (err) {
    if (err instanceof ConversionDeadlineError) return budgetError;
    return { error: `HTML-to-markdown conversion failed: ${(err as Error)?.message ?? String(err)}` };
  } finally {
    releaseSlot(html.length);
  }
}

/** The conversion itself, run while holding a slot. Throws only what htmlToMarkdown() maps to `{ error }`. */
async function convert(
  html: string,
  deadline: number,
  turndownMs: number,
  signal: AbortSignal | undefined,
  budgetError: { error: string },
): Promise<{ markdown: string } | { error: string }> {
  if (signal?.aborted) return { error: CANCELLED };
  if (performance.now() >= deadline) return budgetError; // before building the wrapped copy
  const maxNodes = Math.min(MAX_NODE_BUDGET, MIN_NODE_BUDGET + Math.floor(html.length / NODE_BUDGET_CHARS));

  const parsed = await parseBounded(`<x-turndown id="${ROOT_ID}">${html}</x-turndown>`, {
    deadline,
    signal,
    maxNodes,
  });
  if ("stop" in parsed) {
    if (parsed.stop === "cancelled") return { error: CANCELLED };
    if (parsed.stop === "nodes") {
      return {
        error: `page builds more than ${maxNodes} DOM nodes (the limit for a ${html.length}-character page; an attribute counts as 1/${ATTRS_PER_NODE} node), too many to convert to markdown; fetch_html_to_text handles this page in linear time`,
      };
    }
    return budgetError;
  }
  const root = parsed.root;
  if (!root) return { error: "HTML-to-markdown conversion failed: the parsed page has no root element" };

  const turn = await acquireStep(deadline, signal);
  if (turn === "cancelled") return { error: CANCELLED };
  if (turn === "deadline") return budgetError;
  try {
    // Granted on a later loop turn: re-check what may have changed meanwhile.
    if (signal?.aborted) return { error: CANCELLED };
    if (performance.now() >= deadline) return budgetError;
    return step(root, html.length, deadline, turndownMs, signal, budgetError);
  } finally {
    releaseStep();
  }
}

/** The synchronous step: the tree-shape refusals, then Turndown. Run only while holding the step gate. */
function step(
  root: DomElement,
  length: number,
  deadline: number,
  turndownMs: number,
  signal: AbortSignal | undefined,
  budgetError: { error: string },
): { markdown: string } | { error: string } {
  const shape = treeShape(root, deadline);
  if (shape === null) return budgetError;
  if (shape.depth > MAX_MARKDOWN_DEPTH) {
    return {
      error: `page nests elements ${shape.depth} deep (limit ${MAX_MARKDOWN_DEPTH}), too deep to convert to markdown; fetch_html_to_text handles this page in linear time`,
    };
  }
  if (shape.names > MAX_TAG_NAMES || shape.nameChars > MAX_TAG_NAME_CHARS) {
    return {
      error: `page uses more than ${MAX_TAG_NAMES} distinct tag names or ${MAX_TAG_NAME_CHARS} characters of them, too many to convert to markdown; fetch_html_to_text handles this page in linear time`,
    };
  }
  if (signal?.aborted) return { error: CANCELLED };

  const maxOutput = OUTPUT_FACTOR * length + OUTPUT_SLACK;
  const maxWork = WORK_FACTOR * length + WORK_SLACK;
  // The phase cap binds only when it falls before the budget's deadline.
  const phaseDeadline = performance.now() + turndownMs;
  const phaseCapped = phaseDeadline < deadline;
  const td = makeTurndown();
  td.deadline = phaseCapped ? phaseDeadline : deadline;
  td.visited = 0;
  td.maxOutput = maxOutput;
  td.maxWork = maxWork;
  try {
    return { markdown: td.turndown(root) };
  } catch (err) {
    if (err instanceof ConversionLimitError) {
      if (err.kind === "work") {
        return {
          error: `page's markdown takes more than ${maxWork} characters of conversion work (the limit for a ${length}-character page; nesting repeats the work at every level), too much to convert; fetch_html_to_text handles this page in linear time`,
        };
      }
      return {
        error: `page's markdown grows past ${maxOutput} characters while converting (the limit for a ${length}-character page), too large to convert; fetch_html_to_text handles this page in linear time`,
      };
    }
    if (err instanceof ConversionDeadlineError && phaseCapped) {
      return {
        error: `HTML-to-markdown conversion ran past its ${turndownMs} ms limit for the markdown step (whatever the budget: it holds the server while it runs); fetch_html_to_text handles this page in linear time`,
      };
    }
    throw err;
  }
}
