import { describe, expect, it } from "vitest";
import { formatHttpResponse } from "../format.js";
import type { HttpResponse } from "../http.js";

// Minimal builder so each test only states the fields it cares about.
// Mirrors the HttpResponse shape produced by http.ts:sendHop / failure.
function makeResponse(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    url: "https://example.com/",
    redirects: [],
    durationMs: 12,
    ...overrides,
  };
}

describe("formatHttpResponse -- error branch", () => {
  it("renders Request failed and sets isError when res.error is present", () => {
    const out = formatHttpResponse(makeResponse({ ok: false, status: 0, statusText: "", error: "DNS lookup failed" }));
    expect(out.isError).toBe(true);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]!.type).toBe("text");
    expect(out.content[0]!.text).toBe("Request failed: DNS lookup failed");
  });

  it("does not emit status/headers/body lines on the error branch", () => {
    const out = formatHttpResponse(
      makeResponse({ ok: false, error: "boom", headers: { "x-test": "v" }, bodyText: "ignored" }),
    );
    const text = out.content[0]!.text;
    expect(text).not.toContain("HTTP/1.1");
    expect(text).not.toContain("--- Headers ---");
    expect(text).not.toContain("--- Body");
    expect(text).not.toContain("ignored");
  });
});

describe("formatHttpResponse -- ok status line and isError flag", () => {
  it("omits isError (falsy) for a 2xx response", () => {
    const out = formatHttpResponse(makeResponse({ ok: true, status: 200, statusText: "OK" }));
    expect(out.isError).toBe(false);
    expect(out.content[0]!.text).toContain("HTTP/1.1 200 OK");
  });

  it("sets isError=true for a non-2xx response that has no transport error (isError = !res.ok)", () => {
    const out = formatHttpResponse(
      makeResponse({ ok: false, status: 404, statusText: "Not Found", bodyText: "missing" }),
    );
    // The error branch only fires on res.error; a 404 body still renders.
    expect(out.isError).toBe(true);
    const text = out.content[0]!.text;
    expect(text).toContain("HTTP/1.1 404 Not Found");
    expect(text).toContain("--- Body ---");
    expect(text).toContain("missing");
  });

  it("trims a trailing space when statusText is empty", () => {
    const out = formatHttpResponse(makeResponse({ status: 204, statusText: "" }));
    const firstLine = out.content[0]!.text.split("\n")[0]!;
    expect(firstLine).toBe("HTTP/1.1 204");
  });
});

describe("formatHttpResponse -- URL, Duration, and Redirects lines", () => {
  it("always includes URL and Duration lines", () => {
    const out = formatHttpResponse(makeResponse({ url: "https://host/path", durationMs: 73 }));
    const text = out.content[0]!.text;
    expect(text).toContain("URL: https://host/path");
    expect(text).toContain("Duration: 73ms");
  });

  it("omits the Redirects line when there were no hops", () => {
    const out = formatHttpResponse(makeResponse({ redirects: [] }));
    expect(out.content[0]!.text).not.toContain("Redirects:");
  });

  it("emits 'Redirects: N hop(s)' with the chain length", () => {
    const out = formatHttpResponse(makeResponse({ redirects: ["https://a/", "https://b/", "https://c/"] }));
    expect(out.content[0]!.text).toContain("Redirects: 3 hop(s)");
  });
});

describe("formatHttpResponse -- headers block", () => {
  it("renders headers sorted by key", () => {
    const out = formatHttpResponse(makeResponse({ headers: { "x-zed": "z", "a-first": "1", "m-mid": "m" } }));
    const text = out.content[0]!.text;
    const headerLines = text.split("\n");
    const aIdx = headerLines.indexOf("a-first: 1");
    const mIdx = headerLines.indexOf("m-mid: m");
    const zIdx = headerLines.indexOf("x-zed: z");
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });
});

describe("formatHttpResponse -- body variants and precedence", () => {
  it("renders parsed-JSON body pretty-printed under the JSON banner", () => {
    const out = formatHttpResponse(makeResponse({ json: { foo: "bar", n: 42 } }));
    const text = out.content[0]!.text;
    expect(text).toContain("--- Body (parsed JSON) ---");
    expect(text).toContain(JSON.stringify({ foo: "bar", n: 42 }, null, 2));
    // The JSON banner wins; no plain text/base64 banners present.
    expect(text).not.toContain("--- Body ---");
    expect(text).not.toContain("--- Body (base64");
  });

  it("renders a text body under the text banner", () => {
    const out = formatHttpResponse(makeResponse({ bodyText: "<p>hi</p>" }));
    const text = out.content[0]!.text;
    expect(text).toContain("--- Body ---");
    expect(text).toContain("<p>hi</p>");
    expect(text).not.toContain("(parsed JSON)");
    expect(text).not.toContain("(base64");
  });

  it("renders a base64 body under the base64 banner with its char count", () => {
    const b64 = Buffer.from([0, 1, 2, 255]).toString("base64");
    const out = formatHttpResponse(makeResponse({ bodyBase64: b64 }));
    const text = out.content[0]!.text;
    expect(text).toContain(`--- Body (base64, ${b64.length} chars) ---`);
    expect(text).toContain(b64);
    expect(text).not.toContain("(parsed JSON)");
  });

  it("prefers json over bodyText when both are present (json branch first)", () => {
    const out = formatHttpResponse(makeResponse({ json: { a: 1 }, bodyText: "raw json text" }));
    const text = out.content[0]!.text;
    expect(text).toContain("--- Body (parsed JSON) ---");
    expect(text).not.toContain("--- Body ---");
    expect(text).not.toContain("raw json text");
  });

  it("prefers bodyText over bodyBase64 when both are present", () => {
    const out = formatHttpResponse(makeResponse({ bodyText: "decoded text", bodyBase64: "ZGVjb2RlZA==" }));
    const text = out.content[0]!.text;
    expect(text).toContain("--- Body ---");
    expect(text).toContain("decoded text");
    expect(text).not.toContain("(base64");
  });

  it("emits no body banner when no body fields are set (e.g. HEAD)", () => {
    const out = formatHttpResponse(makeResponse({ status: 200, statusText: "OK" }));
    const text = out.content[0]!.text;
    expect(text).not.toContain("--- Body");
  });
});

describe("formatHttpResponse -- truncation banner", () => {
  it("emits the [body truncated] banner above the body when res.truncated is set", () => {
    const out = formatHttpResponse(makeResponse({ truncated: true, bodyText: "partial" }));
    const lines = out.content[0]!.text.split("\n");
    const bannerIdx = lines.indexOf("[body truncated at response-size cap]");
    const bodyHeaderIdx = lines.indexOf("--- Body ---");
    expect(bannerIdx).toBeGreaterThan(-1);
    // Banner precedes the body section.
    expect(bannerIdx).toBeLessThan(bodyHeaderIdx);
  });

  it("does not emit the truncation banner when res.truncated is falsy", () => {
    const out = formatHttpResponse(makeResponse({ truncated: false, bodyText: "whole" }));
    expect(out.content[0]!.text).not.toContain("[body truncated");
  });
});
