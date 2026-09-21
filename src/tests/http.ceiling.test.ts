import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The call-wide ceiling and the per-attempt budget, on a fake clock.
//
// fetch is mocked (no sockets), so vitest's fake timers can drive every timer
// httpRequest arms -- the attempt deadline, the retry wait, the ceiling --
// without waiting five real minutes. Each mocked response honours the abort
// signal the way undici's fetch does.

const fetchSpy = vi.fn();

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: (...args: unknown[]) => fetchSpy(...args),
}));

const { ABSOLUTE_MAX_TOTAL_MS, httpRequest, setHttpContext } = await import("../http.js");

setHttpContext({ version: "test" });

/** A fetch reply that arrives after `ms` of (fake) time, or rejects when the request is aborted. */
function replyAfter(ms: number, make: () => Response) {
  return (_url: string, init: { signal: AbortSignal }) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(make()), ms);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
}

const busy = (retryAfter: string) => new Response("busy", { status: 503, headers: { "retry-after": retryAfter } });
const ok = () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  fetchSpy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retries get a fresh budget", () => {
  it("a retry is not charged for the time the first attempt used", async () => {
    // Two attempts of 700ms each under timeout_ms 1000: a budget shared across
    // attempts would abort the second at 300ms.
    fetchSpy.mockImplementationOnce(replyAfter(700, () => busy("0"))).mockImplementationOnce(replyAfter(700, ok));
    const pending = httpRequest({ method: "GET", url: "http://1.2.3.4/", timeoutMs: 1000, retries: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("each attempt still has only timeout_ms", async () => {
    fetchSpy.mockImplementationOnce(replyAfter(1500, ok));
    const pending = httpRequest({ method: "GET", url: "http://1.2.3.4/", timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);

    expect((await pending).error).toBe("request exceeded 1000ms");
  });
});

describe("the five-minute call ceiling", () => {
  it("does not start a retry that could not finish before the ceiling -- it returns the answer it has", async () => {
    // First attempt comes back 503 when the call is ~4m55s old: the 1s wait
    // plus a full 10s attempt would cross the ceiling, so no second attempt.
    fetchSpy.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + ABSOLUTE_MAX_TOTAL_MS - 5_000);
      return busy("1");
    });
    const pending = httpRequest({ method: "GET", url: "http://1.2.3.4/", timeoutMs: 10_000, retries: 3 });
    await vi.advanceTimersByTimeAsync(10);
    const res = await pending;

    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still retries when the wait and a full attempt fit", async () => {
    fetchSpy.mockImplementationOnce(async () => busy("1")).mockImplementationOnce(async () => ok());
    const pending = httpRequest({ method: "GET", url: "http://1.2.3.4/", timeoutMs: 10_000, retries: 1 });
    await vi.advanceTimersByTimeAsync(1500);

    expect((await pending).ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("caps an attempt whose timeout_ms exceeds the ceiling, and says which limit it hit", async () => {
    // The tool schemas stop at 120s; a library caller can ask for more.
    fetchSpy.mockImplementationOnce(replyAfter(10 * ABSOLUTE_MAX_TOTAL_MS, ok));
    const pending = httpRequest({ method: "GET", url: "http://1.2.3.4/", timeoutMs: 2 * ABSOLUTE_MAX_TOTAL_MS });
    await vi.advanceTimersByTimeAsync(ABSOLUTE_MAX_TOTAL_MS + 1000);

    expect((await pending).error).toBe(
      `request exceeded the ${ABSOLUTE_MAX_TOTAL_MS}ms total limit (all attempts, redirects and retry waits)`,
    );
  });
});
