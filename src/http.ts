import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
// fetch comes from the same undici as the pinned Agent, NOT the runtime's global
// fetch. Node's bundled undici (6.x on Node 22, 7.x on Node 24) drives a
// dispatcher through the legacy handler API; undici 8's Agent rejects that with
// UND_ERR_INVALID_ARG ("invalid onRequestStart method"), so every guarded
// hostname request failed with "fetch failed" on plain Node from 0.4.0 through
// 0.7.0 (Node 20 could not load undici 8 at all). Pairing fetch and Agent from
// one package makes the handler API match on every runtime.
import { Agent, type Response, fetch as undiciFetch } from "undici";
import { PRIVATE_HOSTS_DISABLED } from "./policy.js";
import { checkIpAddress, defaultUserAgent, validateUrl } from "./security.js";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const DEFAULT_MAX_REDIRECTS = 5;
export const ABSOLUTE_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB — hard ceiling
/**
 * Ceiling on one whole httpRequest() call: every attempt, redirect hop and
 * retry wait. Without it the schema maxima (6 attempts x 21 hops x 120s, plus
 * Retry-After sleeps) let one call run for hours.
 */
export const ABSOLUTE_MAX_TOTAL_MS = 5 * 60 * 1000;

const CANCELLED = "request cancelled by the client";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface HttpRequestOptions {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  contentType?: string;
  /**
   * Budget for each ATTEMPT, end to end: DNS, every redirect hop, headers and
   * body. Retries get a fresh budget; the whole call is also capped at
   * ABSOLUTE_MAX_TOTAL_MS. Default 10s.
   */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowPrivateHosts?: boolean;
  basicAuth?: { username: string; password: string };
  bearerToken?: string;
  /**
   * true  — always decode body as text (respecting Content-Type charset).
   * false — return base64 regardless of content-type.
   * undefined — auto: text for text/*, JSON, XML, form-urlencoded; binary otherwise.
   */
  decodeText?: boolean;
  userAgent?: string;
  /** Retry on 408/425/429/5xx with exponential backoff (honors Retry-After). Default 0. */
  retries?: number;
  /**
   * Caller cancellation -- the MCP request's signal. Aborting stops the hop in
   * flight (DNS included), any retry wait, and every later attempt.
   */
  signal?: AbortSignal;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  redirects: string[];
  bodyText?: string;
  bodyBase64?: string;
  json?: unknown;
  truncated?: boolean;
  durationMs: number;
  error?: string;
}

interface InternalContext {
  version: string;
}

let context: InternalContext = { version: "0.0.0" };

export function setHttpContext(ctx: InternalContext) {
  context = ctx;
}

/**
 * One server's operator policy. `allowPrivateHosts` is the operator's opt-in
 * (FETCH_MCP_ALLOW_PRIVATE_HOSTS): whether a request may set `allowPrivateHosts`
 * at all. It travels with each call rather than living in module state, so two
 * servers in one process cannot change each other's policy.
 */
export interface HttpPolicy {
  allowPrivateHosts: boolean;
}

const REFUSE_PRIVATE_HOSTS: HttpPolicy = Object.freeze({ allowPrivateHosts: false });

export type HttpRequester = (opts: HttpRequestOptions) => Promise<HttpResponse>;

/**
 * A request function bound to one server's policy -- what createFetchServer
 * hands its tools. The policy is copied and frozen, so the caller cannot widen
 * it afterwards.
 */
export function createRequester(policy: HttpPolicy): HttpRequester {
  const bound: HttpPolicy = Object.freeze({ allowPrivateHosts: policy.allowPrivateHosts === true });
  return (opts) => httpRequest(opts, bound);
}

/**
 * Decide whether to decode a response as text based on Content-Type.
 * Returns true for text, JSON, XML, JS, CSS, and form-urlencoded responses.
 */
export function shouldDecodeAsText(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (!ct) return true; // No CT — assume text; caller may override with decodeText=false
  if (ct.startsWith("text/")) return true;
  if (ct === "application/json" || ct.endsWith("+json")) return true;
  if (ct === "application/xml" || ct === "application/xhtml+xml" || ct.endsWith("+xml")) return true;
  if (ct === "application/javascript" || ct === "application/ecmascript") return true;
  if (ct === "application/x-www-form-urlencoded") return true;
  return false;
}

/**
 * Pull the charset declaration out of a Content-Type header.
 * Returns "utf-8" when absent or unrecognized.
 */
export function extractCharset(contentType: string): string {
  const m = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  if (!m) return "utf-8";
  const raw = m[1]!.toLowerCase();
  // Common alias fixups for TextDecoder
  if (raw === "utf8") return "utf-8";
  if (raw === "iso8859-1") return "iso-8859-1";
  return raw;
}

/**
 * Decode bytes as text using the charset from Content-Type, falling back
 * to utf-8 when the label is not supported by the platform.
 */
export function decodeBytes(buf: Uint8Array, contentType: string): string {
  const charset = extractCharset(contentType);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

/**
 * Parse a Retry-After header value. Accepts:
 *   - delta-seconds: "30"
 *   - HTTP-date:    "Wed, 21 Oct 2025 07:28:00 GMT"
 * Returns ms, or undefined when unparseable.
 */
export function parseRetryAfter(raw: string | undefined, now = Date.now()): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, 60_000);
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, Math.min(asDate - now, 60_000));
  return undefined;
}

/**
 * Removed from every hop whose origin differs from the initial URL's. The fetch
 * spec and curl both drop Authorization cross-origin; Cookie and
 * Proxy-Authorization carry the same kind of secret. Arbitrary custom headers
 * (X-Api-Key and friends) cannot be recognised by name and still follow --
 * SECURITY.md says so.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "proxy-authorization", "cookie"] as const;

function headersToRecord(h: Response["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/**
 * Resolve hostname to IP(s), refuse any that land in a blocked range, and
 * return the first safe address so we can dial it directly. Dialing the
 * pre-resolved IP closes the DNS-rebinding TOCTOU window that exists when
 * we re-lookup inside `fetch`.
 */
async function resolveAndPin(
  hostname: string,
): Promise<{ ok: true; ip: string; family: 4 | 6 } | { ok: false; reason: string }> {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    if (results.length === 0) return { ok: false, reason: `DNS: ${hostname} returned no addresses` };
    for (const r of results) {
      // The resolved address is deliberately NOT in the message: it goes back
      // to the model, and naming it (`jenkins.corp -> 10.20.30.40`) turned every
      // refusal into a way to map internal hosts and addresses.
      if (checkIpAddress(r.address)) {
        return {
          ok: false,
          reason: `DNS: ${hostname} resolves to a private, loopback, link-local or otherwise reserved address -- refused`,
        };
      }
    }
    const first = results[0]!;
    return { ok: true, ip: first.address, family: first.family === 6 ? 6 : 4 };
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed for "${hostname}": ${(err as Error).message}` };
  }
}

/**
 * Build an undici Agent whose `lookup` hook hard-pins to a specific IP.
 * This ensures the kernel dials the IP we verified, not one a racing
 * DNS server returns a millisecond later. The original hostname still
 * flows through SNI and the Host header for correct TLS + vhosting.
 *
 * `connectTimeoutMs` is what is left of the attempt's budget. undici's own
 * default is 10s, which let a SYN that is never answered (or a TLS handshake a
 * server never finishes) outlive both timeout_ms and a cancellation.
 */
function pinnedAgent(ip: string, family: 4 | 6, connectTimeoutMs: number): Agent {
  return new Agent({
    connect: {
      timeout: Math.max(1, connectTimeoutMs),
      // Node 22 always calls lookup with { all: true } internally and passes the
      // result through lookupAndConnectMultiple, which expects an array of address
      // objects: cb(null, [{address, family}]).  The old single-address form
      // cb(null, ipString, familyNumber) causes "Invalid IP address: undefined"
      // because lookupAndConnectMultiple reads addresses[0]?.address where
      // addresses[0] is the first character of the string.
      lookup: (_hostname, _options, cb) => {
        (cb as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(null, [
          { address: ip, family },
        ]);
      },
    },
  });
}

function buildHeaders(
  opts: HttpRequestOptions,
  ctx: { stripAuth: boolean; method: HttpMethod; hasBody: boolean; contentType?: string },
): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  if (!h.has("user-agent")) h.set("user-agent", opts.userAgent ?? defaultUserAgent(context.version));
  if (!h.has("accept")) h.set("accept", "*/*");
  if (ctx.stripAuth) {
    // Cross-origin hop: drop the standard credential headers, whether they came
    // from basic_auth / bearer_token or from caller `headers`. Because redirects
    // are followed by hand (`redirect: "manual"`), undici's own cross-origin
    // stripping never runs -- this is the only place it happens.
    for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) h.delete(name);
  } else if (opts.basicAuth) {
    const token = Buffer.from(`${opts.basicAuth.username}:${opts.basicAuth.password}`, "utf8").toString("base64");
    h.set("authorization", `Basic ${token}`);
  } else if (opts.bearerToken) {
    h.set("authorization", `Bearer ${opts.bearerToken}`);
  }
  if (ctx.hasBody && !h.has("content-type") && ctx.contentType) {
    h.set("content-type", ctx.contentType);
  }
  // No-body requests must not carry an explicit content-type from a prior hop.
  if (!ctx.hasBody) h.delete("content-type");
  return h;
}

async function readLimitedBody(
  res: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<{ buf: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { buf: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      abortController.abort();
      try {
        await reader.cancel();
      } catch {
        // best-effort cancel
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { buf, truncated };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 504);
}

/** Wait `ms`; resolves false early if `signal` aborts (true when the wait completed). */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Settle with `promise`, or reject with the signal's reason as soon as it
 * aborts. dns.lookup cannot be cancelled; losing the race only stops waiting
 * for it, which is what keeps DNS inside the attempt budget.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Discard a response body without buffering it. Prevents socket leak / OOM. */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // best-effort
  }
}

interface HopResult {
  kind: "response";
  response: HttpResponse;
}
interface HopRedirect {
  kind: "redirect";
  status: number;
  location: string;
}
interface HopError {
  kind: "error";
  response: HttpResponse;
}

/**
 * Per-hop request. Resolves + IP-pins the host, sends the request, and
 * returns either a final response, a redirect instruction, or a failure.
 */
async function sendHop(params: {
  url: string;
  method: HttpMethod;
  body: string | Uint8Array | undefined;
  contentType: string | undefined;
  opts: HttpRequestOptions;
  /** Epoch ms by which this hop -- DNS, headers, body -- must finish (the attempt's budget). */
  deadline: number;
  /** The abort reason when `deadline` passes. */
  timeoutMessage: string;
  maxBytes: number;
  stripAuth: boolean;
  redirects: string[];
  start: number;
}): Promise<HopResult | HopRedirect | HopError> {
  const { url, method, body, contentType, opts, deadline, timeoutMessage, maxBytes, stripAuth, redirects, start } =
    params;

  // Every URL this function dials goes through the pre-flight validator:
  // scheme allow-list, literal-IP block list, `localhost*`. httpRequest runs
  // it on the initial URL too, but a redirect `Location` only ever reaches the
  // network through here, so this is the check that makes SECURITY.md's
  // "per-hop redirect re-validation" true. Before this ran per hop, a public
  // URL that 302'd to a literal blocked IP (`http://169.254.169.254/...`,
  // `http://127.0.0.1/`, `http://[::1]/`, `http://2130706433/`) or to a
  // non-http(s) scheme was fetched with no SSRF check at all.
  const urlCheck = validateUrl(url, { allowPrivateHosts: opts.allowPrivateHosts });
  if (!urlCheck.ok)
    return { kind: "error", response: failure(url, urlCheck.reason ?? "URL rejected", redirects, start) };

  const parsed = new URL(url);
  const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;

  // One controller for the whole hop, armed BEFORE the DNS lookup: the
  // attempt's deadline and the caller's cancellation both cover resolution as
  // well as the request. (The lookup used to run before the timer started, so
  // a resolver that never answered added its full OS timeout to every hop.)
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(new Error(timeoutMessage)), Math.max(0, deadline - Date.now()));
  const onCallerAbort = () => abortController.abort(new Error(CANCELLED));
  if (opts.signal?.aborted) onCallerAbort();
  else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let dispatcher: Agent | undefined;
  try {
    if (!opts.allowPrivateHosts) {
      // A literal IP was just vetted by validateUrl -> checkIpAddress above. For
      // hostnames we must resolve and pin so fetch can't race us to a rebound
      // address. Use isIP() (node:net) -- the same check validateUrl uses --
      // rather than a hand-rolled regex. The old regex matched partial addresses
      // like "127" or "192.168" as literals, skipping pinning; on Windows "127"
      // connects to 127.0.0.1, making this a real SSRF bypass path.
      const literal = isIP(host) !== 0;
      if (!literal) {
        const resolved = await raceAbort(resolveAndPin(host), abortController.signal);
        if (!resolved.ok) return { kind: "error", response: failure(url, resolved.reason, redirects, start) };
        dispatcher = pinnedAgent(resolved.ip, resolved.family, deadline - Date.now());
      }
    }

    const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";
    const headers = buildHeaders(opts, { stripAuth, method, hasBody, contentType });
    const res = await undiciFetch(url, {
      method,
      headers,
      body: hasBody ? body : null,
      redirect: "manual",
      signal: abortController.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await drain(res);
      const next = new URL(res.headers.get("location")!, url).toString();
      return { kind: "redirect", status: res.status, location: next };
    }

    const respContentType = res.headers.get("content-type") ?? "";
    const decodeText = opts.decodeText ?? shouldDecodeAsText(respContentType);

    let bodyText: string | undefined;
    let bodyBase64: string | undefined;
    let json: unknown;
    let truncated = false;

    if (method === "HEAD") {
      await drain(res);
    } else {
      const { buf, truncated: t } = await readLimitedBody(res, maxBytes, abortController);
      truncated = t;
      if (decodeText) {
        bodyText = decodeBytes(buf, respContentType);
        const ctLower = respContentType.toLowerCase().split(";")[0]!.trim();
        const isJsonCt = ctLower === "application/json" || ctLower.endsWith("+json");
        if (isJsonCt && bodyText.length > 0 && !truncated) {
          try {
            json = JSON.parse(bodyText);
          } catch {
            // leave as text
          }
        }
      } else {
        bodyBase64 = Buffer.from(buf).toString("base64");
      }
    }

    return {
      kind: "response",
      response: {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.statusText,
        headers: headersToRecord(res.headers),
        url,
        redirects: [...redirects],
        bodyText,
        bodyBase64,
        json,
        truncated,
        durationMs: Date.now() - start,
      },
    };
  } catch (err) {
    return { kind: "error", response: failure(url, (err as Error).message, redirects, start) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
    // destroy(), not close(): each pinned Agent serves exactly one hop, and by
    // now its body has been read, drained or abandoned. close() waits for a
    // connect still in progress -- after a timeout or cancellation mid-connect
    // that held the call for undici's 10s connect timeout, whatever timeout_ms
    // said. destroy() drops it at once.
    if (dispatcher) await dispatcher.destroy().catch(() => {});
  }
}

/**
 * Top-level HTTP request. Applies SSRF pre-flight, then for each retry
 * attempt runs a fresh follow-redirects loop (so retry state doesn't
 * accumulate across attempts). On cross-origin redirect we strip the
 * credential headers (CROSS_ORIGIN_STRIPPED_HEADERS). On 303 we downgrade to GET; on 301/302 from
 * non-GET/HEAD we also downgrade (WHATWG fetch standard).
 *
 * `policy` is the server's operator policy; the default refuses the private-
 * hosts opt-in, so only a requester built by createRequester() can grant it.
 */
export async function httpRequest(
  opts: HttpRequestOptions,
  policy: HttpPolicy = REFUSE_PRIVATE_HOSTS,
): Promise<HttpResponse> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const retries = Math.max(0, opts.retries ?? 0);
  const callDeadline = start + ABSOLUTE_MAX_TOTAL_MS;

  // The one choke point for the operator gate: every tool reaches the network
  // through here, so no tool can forget it.
  if (opts.allowPrivateHosts && !policy.allowPrivateHosts) return failure(opts.url, PRIVATE_HOSTS_DISABLED, [], start);

  const urlCheck = validateUrl(opts.url, { allowPrivateHosts: opts.allowPrivateHosts });
  if (!urlCheck.ok) return failure(opts.url, urlCheck.reason ?? "URL rejected", [], start);

  const initialOrigin = new URL(opts.url).origin;
  let lastResponse: HttpResponse | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) return failure(opts.url, CANCELLED, [], start);
    // timeout_ms bounds the whole attempt -- every hop of its redirect chain --
    // not each hop separately, and never past the call-wide ceiling.
    const attemptEnd = Date.now() + timeoutMs;
    const deadline = Math.min(attemptEnd, callDeadline);
    const timeoutMessage =
      deadline < attemptEnd
        ? `request exceeded the ${ABSOLUTE_MAX_TOTAL_MS}ms total limit (all attempts, redirects and retry waits)`
        : `request exceeded ${timeoutMs}ms`;
    let currentUrl = opts.url;
    let currentMethod: HttpMethod = opts.method;
    let currentBody: string | Uint8Array | undefined = opts.body;
    let currentContentType = opts.contentType;
    const redirects: string[] = [];
    let hops = 0;

    // Follow redirects for this attempt.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const stripAuth = new URL(currentUrl).origin !== initialOrigin;
      const hop = await sendHop({
        url: currentUrl,
        method: currentMethod,
        body: currentBody,
        contentType: currentContentType,
        opts,
        deadline,
        timeoutMessage,
        maxBytes,
        stripAuth,
        redirects,
        start,
      });

      if (hop.kind === "redirect") {
        if (++hops > maxRedirects) {
          return failure(currentUrl, `exceeded ${maxRedirects} redirects`, redirects, start);
        }
        redirects.push(hop.location);
        // Method/body downgrade per WHATWG fetch standard.
        const bodyPreservingMethod = currentMethod === "GET" || currentMethod === "HEAD";
        const downgrade = hop.status === 303 || ((hop.status === 301 || hop.status === 302) && !bodyPreservingMethod);
        if (downgrade) {
          currentMethod = "GET";
          currentBody = undefined;
          currentContentType = undefined;
        }
        currentUrl = hop.location;
        continue;
      }

      // Final response or pre-flight error.
      const res = hop.response;
      if (res.ok) return res;
      if (attempt < retries && isRetryableStatus(res.status)) {
        const delay = parseRetryAfter(res.headers["retry-after"]) ?? Math.min(2 ** attempt * 500, 8000);
        // Retry only if the wait AND a full attempt fit under the ceiling.
        // Otherwise return the response we have: a retry that starts with a
        // sliver of budget can only time out, and would throw this answer away.
        if (Date.now() + delay + timeoutMs > callDeadline) return res;
        if (!(await sleepUnlessAborted(delay, opts.signal))) return failure(opts.url, CANCELLED, [], start);
        lastResponse = res;
        break; // next retry attempt
      }
      return res;
    }
  }
  return lastResponse ?? failure(opts.url, "all retries exhausted", [], start);
}

function failure(url: string, error: string, redirects: string[], start: number): HttpResponse {
  return {
    ok: false,
    status: 0,
    statusText: "",
    headers: {},
    url,
    redirects: [...redirects],
    durationMs: Date.now() - start,
    error,
  };
}
