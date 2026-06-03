import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DNS-rebinding SSRF coverage for resolveAndPin / pinnedAgent (src/http.ts:133-164,281-290).
//
// The production default is allowPrivateHosts UNSET. For a non-literal hostname,
// httpRequest must resolve A/AAAA records itself and refuse the request if ANY
// resolved address lands in a blocked (private/loopback/metadata) range -- BEFORE
// any socket is dialed. This closes the DNS-rebinding TOCTOU window.
//
// We mock node:dns/promises so a public-looking hostname resolves to attacker-
// controlled internal IPs, then assert httpRequest refuses with the resolveAndPin
// "DNS: <host> -> <ip>" reason. fetch must never be reached in the refusal cases.

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// Spy on global fetch so we can prove it is never dialed on a refused host.
const fetchSpy = vi.spyOn(globalThis, "fetch");

// Import AFTER vi.mock is registered (hoisted) so http.ts binds the mocked lookup.
const { httpRequest, setHttpContext } = await import("../http.js");

setHttpContext({ version: "test" });

beforeEach(() => {
  lookupMock.mockReset();
  fetchSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DNS-rebinding SSRF -- resolveAndPin refuses blocked resolved addresses", () => {
  it("refuses a hostname that resolves to an RFC1918 private IPv4", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const res = await httpRequest({ method: "GET", url: "http://rebind.example.com/" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^DNS: rebind\.example\.com -> 10\.1\.2\.3/);
    expect(res.error).toMatch(/reserved\/private range/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a hostname that resolves to loopback (127.0.0.1)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const res = await httpRequest({ method: "GET", url: "http://loopback.example.com/" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("DNS: loopback.example.com -> 127.0.0.1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a hostname that resolves to the cloud metadata endpoint (169.254.169.254)", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const res = await httpRequest({ method: "GET", url: "http://metadata.example.com/latest/" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("DNS: metadata.example.com -> 169.254.169.254");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a hostname that resolves to an IPv6 unique-local address", async () => {
    lookupMock.mockResolvedValue([{ address: "fc00::1", family: 6 }]);
    const res = await httpRequest({ method: "GET", url: "http://v6.example.com/" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("DNS: v6.example.com -> fc00::1");
    expect(res.error).toMatch(/unique-local/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses when ANY record in a multi-address answer is blocked (public first, private second)", async () => {
    // A public A record followed by a private one -- the loop must reject on the private one.
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.0.5", family: 4 },
    ]);
    const res = await httpRequest({ method: "GET", url: "http://mixed.example.com/" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("DNS: mixed.example.com -> 192.168.0.5");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses when DNS returns no addresses", async () => {
    lookupMock.mockResolvedValue([]);
    const res = await httpRequest({ method: "GET", url: "http://empty.example.com/" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("DNS: empty.example.com returned no addresses");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a DNS lookup failure as a request error (NXDOMAIN-style)", async () => {
    lookupMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND nope.example.com"));
    const res = await httpRequest({ method: "GET", url: "http://nope.example.com/" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/DNS lookup failed for "nope\.example\.com"/);
    expect(res.error).toContain("ENOTFOUND");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("DNS-rebinding SSRF -- resolveAndPin is bypassed where it should be", () => {
  it("does NOT call DNS lookup for a literal private IP (validateUrl rejects it first)", async () => {
    const res = await httpRequest({ method: "GET", url: "http://127.0.0.1/" });
    expect(res.ok).toBe(false);
    // validateUrl's literal check fires before resolveAndPin -> lookup never runs.
    expect(lookupMock).not.toHaveBeenCalled();
    expect(res.error).toMatch(/reserved|loopback|private/);
  });

  it("does NOT resolve-and-pin when allowPrivateHosts is true (lookup is skipped entirely)", async () => {
    // With allowPrivateHosts set, the resolveAndPin guard is skipped. We don't need a
    // live server: prove the DNS-pin path is bypassed by asserting lookup was not called.
    // fetch will be attempted against a non-routable .invalid host and fail at the socket,
    // but resolveAndPin must NOT have run.
    const res = await httpRequest({
      method: "GET",
      url: "http://skip-pin.invalid/",
      allowPrivateHosts: true,
      timeoutMs: 200,
    });
    expect(lookupMock).not.toHaveBeenCalled();
    // The request fails at the transport layer (host doesn't resolve), not via resolveAndPin.
    expect(res.ok).toBe(false);
    expect(res.error).not.toMatch(/^DNS: skip-pin\.invalid ->/);
  });
});

describe("DNS-rebinding SSRF -- resolveAndPin pins and dials the verified IP", () => {
  it("pins the resolved public IP and the request reaches fetch (positive path)", async () => {
    // Resolve a public-looking hostname to a public IP that passes checkIpAddress.
    // pinnedAgent will be built and fetch will be invoked with that dispatcher.
    // We intercept fetch so no real network call leaves the box; the assertion is
    // that resolveAndPin accepted the address and handed off to fetch.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchSpy.mockResolvedValue(new Response("pinned-ok", { status: 200, headers: { "content-type": "text/plain" } }));
    const res = await httpRequest({ method: "GET", url: "http://pin-me.example.com/" });
    expect(lookupMock).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    // The fetch init carries a pinned dispatcher (undici Agent) built from the verified IP.
    const init = fetchSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(init.dispatcher).toBeDefined();
    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("pinned-ok");
  });
});
