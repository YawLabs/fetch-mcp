import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Per-hop redirect re-validation (src/http.ts:sendHop).
//
// Reported 2026-09-20 against 0.6.2 (present since 0.3.0, whose IP-pinning refactor
// added the literal-IP skip; 0.1.0/0.2.0 ran the DNS check on literals too): httpRequest
// ran validateUrl on the INITIAL URL only. A redirect `Location` reached the network
// through sendHop, which skipped resolveAndPin/checkIpAddress whenever the hop host
// was a literal IP, on the false premise that literal IPs "are covered by validateUrl".
// So `http://1.2.3.4/` -> `302 Location: http://169.254.169.254/latest/meta-data/...`
// was fetched with the SSRF guard on. The scheme allow-list was not re-checked per hop
// either, so a redirect to `ftp://1.2.3.4/` also reached fetch.
//
// Hostname redirect targets were always re-validated (resolveAndPin). The gap was
// exactly: redirect hop + literal-IP target, or redirect hop + non-http(s) scheme.
//
// Fix: sendHop runs validateUrl on every URL it dials. These tests mock node:dns and
// undici's fetch (the one http.ts calls) so no packet leaves the box; every "refused"
// case asserts that fetch was called ONCE (the hop that issued the redirect) and
// never with the target.

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// http.ts dials through undici's own fetch (paired with its pinned Agent); that
// is what we intercept. The real Agent is kept: pinnedAgent() still builds one.
const fetchSpy = vi.fn();

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: (...args: unknown[]) => fetchSpy(...args),
}));

// Import AFTER vi.mock is registered (hoisted) so http.ts binds the mocked lookup.
const { httpRequest, setHttpContext } = await import("../http.js");

setHttpContext({ version: "test" });

const PUBLIC_IP = "93.184.216.34";
const SECRET = "SECRET-METADATA";

/**
 * Make fetch answer `redirects[from]` with a 302 to `to`, and everything else
 * with a 200 whose body is SECRET. `seen` records every URL fetch was asked for.
 */
function mockRedirectChain(redirects: Record<string, string>): string[] {
  const seen: string[] = [];
  fetchSpy.mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    const to = redirects[url];
    if (to !== undefined) return new Response(null, { status: 302, headers: { location: to } });
    return new Response(SECRET, { status: 200, headers: { "content-type": "text/plain" } });
  });
  return seen;
}

beforeEach(() => {
  lookupMock.mockReset();
  fetchSpy.mockReset();
  // No test reaches the real network: an unmocked dial fails loudly.
  fetchSpy.mockRejectedValue(new Error("network disabled: fetch not mocked in this test"));
  // Any hostname that does get resolved is public, so a refusal can only come
  // from the per-hop literal / scheme check under test, not from DNS.
  lookupMock.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});

afterEach(() => {
  vi.clearAllMocks();
  setHttpContext({ version: "test" });
});

/** The operator's FETCH_MCP_ALLOW_PRIVATE_HOSTS=1, for tests of the per-call opt-in. */
function operatorAllowsPrivateHosts() {
  setHttpContext({ version: "test", allowPrivateHosts: true });
}

describe("redirect SSRF -- a redirect to a literal blocked IP is refused before it is dialed", () => {
  // [target, what the reason must mention]
  const blockedLiterals: Array<[string, RegExp]> = [
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/role", /169\.254\.169\.254.*reserved/],
    ["http://127.0.0.1:8080/admin", /127\.0\.0\.1.*reserved/],
    ["http://10.0.0.5/", /10\.0\.0\.5.*reserved/],
    ["http://192.168.1.1/", /192\.168\.1\.1.*reserved/],
    ["http://172.16.5.5/", /172\.16\.5\.5.*reserved/],
    ["http://100.64.0.1/", /100\.64\.0\.1.*reserved/],
    ["http://0.0.0.0/", /0\.0\.0\.0.*reserved/],
    ["http://[::1]/", /::1.*loopback/],
    ["http://[fc00::1]/", /unique-local/],
    ["http://[fe80::1]/", /link-local/],
    // IPv4-mapped IPv6, dotted and hex spellings -- both must unmap to the v4 block list.
    ["http://[::ffff:169.254.169.254]/", /maps to 169\.254\.169\.254/],
    ["http://[::ffff:a9fe:a9fe]/", /maps to 169\.254\.169\.254/],
    ["http://[::ffff:7f00:1]/", /maps to 127\.0\.0\.1/],
    // WHATWG URL normalises these to 127.0.0.1 before sendHop sees them; the
    // normalised literal must still be checked.
    ["http://0x7f000001/", /127\.0\.0\.1.*reserved/],
    ["http://2130706433/", /127\.0\.0\.1.*reserved/],
    ["http://127.1/", /127\.0\.0\.1.*reserved/],
    ["http://0x7f.1/", /127\.0\.0\.1.*reserved/],
    ["http://017700000001/", /127\.0\.0\.1.*reserved/],
  ];

  it.each(blockedLiterals)("public literal -> 302 -> %s is refused", async (target, reason) => {
    const seen = mockRedirectChain({ "http://1.2.3.4/": target });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toMatch(reason);
    expect(res.bodyText).toBeUndefined();
    // Only the hop that issued the redirect was dialed.
    expect(seen).toEqual(["http://1.2.3.4/"]);
    // The refused hop is reported as the terminal URL, with the chain intact.
    expect(res.url).toBe(new URL(target).toString());
    expect(res.redirects).toEqual([new URL(target).toString()]);
    // A literal target never goes to DNS.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("public HOSTNAME -> 302 -> literal metadata IP is refused (the initial hop was pinned, the redirect was not)", async () => {
    const target = "http://169.254.169.254/latest/meta-data/";
    const seen = mockRedirectChain({ "http://public.example.com/": target });
    const res = await httpRequest({ method: "GET", url: "http://public.example.com/" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/169\.254\.169\.254.*reserved/);
    expect(seen).toEqual(["http://public.example.com/"]);
    // resolveAndPin ran once, for the public hostname -- never for the literal.
    expect(lookupMock).toHaveBeenCalledOnce();
    expect(lookupMock).toHaveBeenCalledWith("public.example.com", expect.objectContaining({ all: true }));
  });

  it("a multi-hop chain is checked at EVERY hop, not just the first redirect", async () => {
    const target = "http://169.254.169.254/latest/meta-data/";
    const seen = mockRedirectChain({
      "http://chain.example.com/": "http://5.6.7.8/",
      "http://5.6.7.8/": target,
    });
    const res = await httpRequest({ method: "GET", url: "http://chain.example.com/" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/169\.254\.169\.254.*reserved/);
    expect(seen).toEqual(["http://chain.example.com/", "http://5.6.7.8/"]);
    expect(res.redirects).toEqual(["http://5.6.7.8/", target]);
  });

  it("a protocol-relative Location (//169.254.169.254/x) is resolved against the hop and then refused", async () => {
    const seen = mockRedirectChain({ "http://1.2.3.4/": "//169.254.169.254/x" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/169\.254\.169\.254.*reserved/);
    expect(res.url).toBe("http://169.254.169.254/x");
    expect(seen).toEqual(["http://1.2.3.4/"]);
  });

  it("a path-only Location (/moved) on a public literal is still followed -- same vetted host", async () => {
    // Positive control: a relative Location only re-targets the path; the host
    // is the one that was already vetted, so this one is FOLLOWED. Pins that the
    // fix does not refuse same-host relative redirects on public literals.
    const seen = mockRedirectChain({ "http://1.2.3.4/": "/moved" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe(SECRET);
    expect(seen).toEqual(["http://1.2.3.4/", "http://1.2.3.4/moved"]);
  });

  it("a redirect to a blocked literal is refused on the retry attempt too", async () => {
    // The retry loop re-runs the redirect chain from the initial URL. Every
    // attempt's hops go through sendHop, so the refusal must hold on attempt 2.
    const target = "http://127.0.0.1/";
    let calls = 0;
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls++;
      if (url === "http://1.2.3.4/" && calls === 1) return new Response("busy", { status: 503 });
      if (url === "http://1.2.3.4/") return new Response(null, { status: 302, headers: { location: target } });
      return new Response(SECRET, { status: 200 });
    });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/", retries: 1 });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/127\.0\.0\.1.*reserved/);
    expect(calls).toBe(2);
  });
});

describe("redirect SSRF -- a redirect to a non-http(s) scheme or localhost is refused", () => {
  it.each([
    ["ftp://1.2.3.4/", /scheme "ftp:" is not allowed/],
    ["file:///etc/passwd", /scheme "file:" is not allowed/],
    ["data:text/plain,hello", /scheme "data:" is not allowed/],
    ["gopher://1.2.3.4:70/", /scheme "gopher:" is not allowed/],
  ])("public literal -> 302 -> %s is refused by the scheme allow-list", async (target, reason) => {
    const seen = mockRedirectChain({ "http://1.2.3.4/": target });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(reason);
    expect(seen).toEqual(["http://1.2.3.4/"]);
  });

  it("the scheme allow-list holds on a redirect even with allowPrivateHosts: true", async () => {
    // allowPrivateHosts bypasses the IP checks (SECURITY.md defenses 2-5), never the
    // scheme allow-list (defense 1).
    operatorAllowsPrivateHosts();
    const seen = mockRedirectChain({ "http://1.2.3.4/": "file:///etc/passwd" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/", allowPrivateHosts: true });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/scheme "file:" is not allowed/);
    expect(seen).toEqual(["http://1.2.3.4/"]);
  });

  it.each([
    "http://localhost/",
    "http://localhost:3000/admin",
    "http://foo.localhost/",
  ])("public literal -> 302 -> %s is refused by name, before any DNS lookup", async (target) => {
    const seen = mockRedirectChain({ "http://1.2.3.4/": target });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/resolves to loopback/);
    expect(seen).toEqual(["http://1.2.3.4/"]);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("redirect SSRF -- legitimate redirects still follow (the fix does not over-block)", () => {
  it("public literal -> 302 -> a different public literal is followed", async () => {
    const seen = mockRedirectChain({ "http://1.2.3.4/": "http://5.6.7.8/landing" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe(SECRET);
    expect(res.url).toBe("http://5.6.7.8/landing");
    expect(res.redirects).toEqual(["http://5.6.7.8/landing"]);
    expect(seen).toEqual(["http://1.2.3.4/", "http://5.6.7.8/landing"]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("public literal -> 302 -> a public HOSTNAME is resolved, pinned and followed", async () => {
    const seen = mockRedirectChain({ "http://1.2.3.4/": "https://www.example.com/" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe(SECRET);
    expect(seen).toEqual(["http://1.2.3.4/", "https://www.example.com/"]);
    expect(lookupMock).toHaveBeenCalledOnce();
    expect(lookupMock).toHaveBeenCalledWith("www.example.com", expect.objectContaining({ all: true }));
    // The hostname hop carried a pinned dispatcher; the literal hop did not.
    const literalInit = fetchSpy.mock.calls[0]![1] as Record<string, unknown>;
    const hostnameInit = fetchSpy.mock.calls[1]![1] as Record<string, unknown>;
    expect(literalInit.dispatcher).toBeUndefined();
    expect(hostnameInit.dispatcher).toBeDefined();
  });

  it("public literal -> 302 -> a public IPv6 literal is followed", async () => {
    const seen = mockRedirectChain({ "http://1.2.3.4/": "http://[2606:4700:4700::1111]/" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(true);
    expect(seen).toEqual(["http://1.2.3.4/", "http://[2606:4700:4700::1111]/"]);
  });

  it("with allowPrivateHosts: true a redirect to a private literal IS followed (documented opt-out)", async () => {
    operatorAllowsPrivateHosts();
    const seen = mockRedirectChain({ "http://1.2.3.4/": "http://127.0.0.1:8080/" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/", allowPrivateHosts: true });

    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe(SECRET);
    expect(seen).toEqual(["http://1.2.3.4/", "http://127.0.0.1:8080/"]);
  });
});

describe("operator gate -- allowPrivateHosts is refused unless the operator enabled it", () => {
  it("refuses a per-call opt-in when the operator has not set FETCH_MCP_ALLOW_PRIVATE_HOSTS, before any dial", async () => {
    // A prompt-injected model setting allow_private_hosts: true used to be all it
    // took to reach the metadata endpoint with the guard nominally on.
    const seen = mockRedirectChain({});
    const res = await httpRequest({
      method: "GET",
      url: "http://169.254.169.254/latest/meta-data/",
      allowPrivateHosts: true,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/allow_private_hosts is disabled on this server/);
    expect(res.error).toContain("FETCH_MCP_ALLOW_PRIVATE_HOSTS=1");
    expect(seen).toEqual([]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses the opt-in even for a public URL -- the flag itself is what is gated", async () => {
    const seen = mockRedirectChain({});
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/", allowPrivateHosts: true });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/allow_private_hosts is disabled/);
    expect(seen).toEqual([]);
  });

  it("with the operator opt-in, a call that does NOT set allowPrivateHosts is still guarded", async () => {
    // The operator switch permits the per-call opt-in; it does not turn the guard off.
    operatorAllowsPrivateHosts();
    const seen = mockRedirectChain({ "http://1.2.3.4/": "http://169.254.169.254/latest/meta-data/" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/169.254.169.254.*reserved/);
    expect(seen).toEqual(["http://1.2.3.4/"]);
  });
});

describe("cross-origin redirects drop credential headers", () => {
  const CREDENTIALS = {
    Authorization: "Bearer HEADER-TOKEN",
    Cookie: "session=COOKIE-SECRET",
    "Proxy-Authorization": "Basic PROXY-SECRET",
  };

  function headersOfCall(i: number): Headers {
    return (fetchSpy.mock.calls[i]![1] as { headers: Headers }).headers;
  }

  it("strips Authorization, Cookie and Proxy-Authorization when the redirect leaves the origin", async () => {
    mockRedirectChain({ "http://1.2.3.4/export": "http://5.6.7.8/collect" });
    const res = await httpRequest({ method: "GET", url: "http://1.2.3.4/export", headers: { ...CREDENTIALS } });

    expect(res.ok).toBe(true);
    const first = headersOfCall(0);
    expect(first.get("authorization")).toBe("Bearer HEADER-TOKEN");
    expect(first.get("cookie")).toBe("session=COOKIE-SECRET");
    expect(first.get("proxy-authorization")).toBe("Basic PROXY-SECRET");
    const second = headersOfCall(1);
    expect(second.get("authorization")).toBeNull();
    expect(second.get("cookie")).toBeNull();
    expect(second.get("proxy-authorization")).toBeNull();
  });

  it("strips a bearer_token Authorization cross-origin too", async () => {
    mockRedirectChain({ "http://1.2.3.4/": "http://5.6.7.8/" });
    await httpRequest({ method: "GET", url: "http://1.2.3.4/", bearerToken: "OPT-TOKEN" });

    expect(headersOfCall(0).get("authorization")).toBe("Bearer OPT-TOKEN");
    expect(headersOfCall(1).get("authorization")).toBeNull();
  });

  it("strips a basic_auth Authorization cross-origin too", async () => {
    mockRedirectChain({ "http://1.2.3.4/": "http://5.6.7.8/" });
    await httpRequest({
      method: "GET",
      url: "http://1.2.3.4/",
      basicAuth: { username: "user", password: "BASIC-SECRET" },
    });

    const expected = `Basic ${Buffer.from("user:BASIC-SECRET", "utf8").toString("base64")}`;
    expect(headersOfCall(0).get("authorization")).toBe(expected);
    expect(headersOfCall(1).get("authorization")).toBeNull();
  });

  it("treats a same-host scheme or port change as cross-origin", async () => {
    mockRedirectChain({ "https://www.example.com/": "http://www.example.com:8080/" });
    await httpRequest({ method: "GET", url: "https://www.example.com/", headers: { ...CREDENTIALS } });

    expect(headersOfCall(1).get("cookie")).toBeNull();
    expect(headersOfCall(1).get("authorization")).toBeNull();
  });

  it("keeps credential headers on a same-origin redirect", async () => {
    mockRedirectChain({ "http://1.2.3.4/a": "/b" });
    await httpRequest({ method: "GET", url: "http://1.2.3.4/a", headers: { ...CREDENTIALS } });

    const second = headersOfCall(1);
    expect(second.get("authorization")).toBe("Bearer HEADER-TOKEN");
    expect(second.get("cookie")).toBe("session=COOKIE-SECRET");
    expect(second.get("proxy-authorization")).toBe("Basic PROXY-SECRET");
  });

  it("does not strip arbitrary custom headers -- documented limitation, pinned so a change is deliberate", async () => {
    mockRedirectChain({ "http://1.2.3.4/": "http://5.6.7.8/" });
    await httpRequest({ method: "GET", url: "http://1.2.3.4/", headers: { "X-Api-Key": "KEY123" } });

    expect(headersOfCall(1).get("x-api-key")).toBe("KEY123");
  });
});
