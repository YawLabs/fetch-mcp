# Security policy

## Reporting a vulnerability

Email **support@mcp.hosting** with:

- a description of the issue,
- reproduction steps or a PoC,
- which version you found it on.

We aim to acknowledge within 2 business days and have a fix scheduled within 14 days for confirmed reports.

Please don't open a public issue for security problems until the fix has shipped.

## Scope

In-scope for this repo:

- SSRF bypasses in the pre-flight URL validator or per-hop redirect re-validator (`src/security.ts`, `src/http.ts`)
- Leakage of request headers or body between requests, or across cross-origin redirects
- Response-size cap bypass (`max_bytes`) leading to OOM or DOS
- Timeout bypass that allows a slow-loris request to hold a worker indefinitely
- DNS-rebinding techniques that evade the pre-flight IP check
- Any path that lets an attacker-controlled URL cause the MCP host process to exfil or mutate local-filesystem/network resources

Out of scope:

- Rate limiting, DoS protection of the upstream server you're fetching (that's your responsibility)
- User-supplied `allow_private_hosts: true` then being surprised that private hosts are reachable
- Vulnerabilities in the MCP client, transport, or LLM you plug this into

## Threat model (what this server is designed to defend)

The MCP host (your editor, your agent) runs this server. An LLM talks to the server over stdio and can call tools with arguments the LLM itself chose. The LLM is **not trusted** -- a malicious prompt injected via a previously-fetched page could try to coerce the LLM into calling `http_get` against `http://169.254.169.254/latest/meta-data/` to exfiltrate cloud credentials, or `file:///etc/passwd`, or `http://10.0.0.1/admin` to reach an internal dashboard.

The server refuses those calls by default.

## Defenses layered here

1. **Scheme allow-list.** Only `http:` and `https:` are allowed. `file:`, `gopher:`, `ftp:`, `data:`, `javascript:` are refused before any network call.
2. **IP literal check.** URLs whose host is a literal IP are rejected if the IP falls into a loopback, RFC1918 private, link-local (incl. 169.254.169.254 cloud metadata), CGNAT, ULA, multicast, or reserved range. IPv4-mapped IPv6 literals are re-checked against the IPv4 rules.
3. **`localhost*` hostname check.** The names `localhost` and `*.localhost` are refused even though DNS could map them anywhere.
4. **DNS pre-resolve with IP pinning.** For every non-literal host we resolve via `dns.lookup` and check every returned address. If any address is in a blocked range, the request is refused. The IP we verified is then pinned into an undici dispatcher so the subsequent TCP connection dials THAT address -- not a different one returned by a concurrent DNS query. This closes the classic DNS-rebinding TOCTOU window.
5. **Per-hop redirect re-validation.** Redirect responses are handled manually with `redirect: "manual"`. Every `Location` target goes through steps 1-4 before we dial it. A 302 from a public host to `http://127.0.0.1` is caught.
6. **Cross-origin auth stripping.** `Authorization` headers (from either explicit `headers`, `basic_auth`, or `bearer_token`) are stripped when a redirect leaves the initial origin. Matches the behavior of `curl` / fetch.
7. **Streaming size cap with `AbortController`.** Response bodies are read as a stream and the request is aborted once `max_bytes` is hit. We never buffer a full response and then truncate. Hard ceiling: 100 MiB.
8. **Request timeout via `AbortController`.** Every hop carries a per-hop timeout; defaults to 10s, capped at 120s by the tool schema.
9. **Redirect body drain.** 3xx response bodies are cancelled (not buffered) before following the `Location`, preventing a hostile server from ballooning memory use via a large redirect body.
10. **JSON auto-parse is content-type gated.** The response is only auto-parsed into `.json` when the server declares `application/json` or `+json`. An HTML page containing a JSON fragment never ends up in `.json`.

## Known non-goals / limitations

- We do not perform full HTML parsing for SSRF-adjacent threats (e.g. SSRF via `<img>` in reader mode) because this server does not fetch subresources -- only the URL the tool was asked to fetch.
- `allow_private_hosts: true` bypasses defenses 2-5 entirely. Use only for intentional local-development fetches.
- We rely on the operating system resolver. If the resolver itself is compromised (e.g. `/etc/hosts` poisoning), the pinning step still only dials an address we were handed -- the blast radius is bounded to what that resolver already allows.

## Disclosure policy

Researchers acting in good faith will not face legal action from Yaw Labs. If you find something, tell us and we will credit you in the release notes.
