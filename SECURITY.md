# Security policy

## Reporting a vulnerability

Email **contact@yaw.sh** with:

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
- An operator launching with `FETCH_MCP_ALLOW_PRIVATE_HOSTS=1` and then being surprised that calls with `allow_private_hosts: true` reach private hosts
- Vulnerabilities in the MCP client, transport, or LLM you plug this into

## Threat model (what this server is designed to defend)

The MCP host (your editor, your agent) runs this server. An LLM talks to the server over stdio and can call tools with arguments the LLM itself chose. The LLM is **not trusted** -- a malicious prompt injected via a previously-fetched page could try to coerce the LLM into calling `http_get` against `http://169.254.169.254/latest/meta-data/` to exfiltrate cloud credentials, or `file:///etc/passwd`, or `http://10.0.0.1/admin` to reach an internal dashboard.

The server refuses those calls by default.

## Defenses layered here

1. **Scheme allow-list.** Only `http:` and `https:` are allowed. `file:`, `gopher:`, `ftp:`, `data:`, `javascript:` are refused before any network call.
2. **IP literal check.** URLs whose host is a literal IP are rejected if the IP falls into a loopback, RFC1918 private, link-local (incl. 169.254.169.254 cloud metadata), CGNAT, ULA, multicast, or reserved range. IPv4-mapped IPv6 literals are re-checked against the IPv4 rules.
3. **`localhost*` hostname check.** The names `localhost` and `*.localhost` are refused even though DNS could map them anywhere.
4. **DNS pre-resolve with IP pinning.** For every non-literal host we resolve via `dns.lookup` and check every returned address. If any address is in a blocked range, the request is refused. The IP we verified is then pinned into an undici dispatcher so the subsequent TCP connection dials THAT address -- not a different one returned by a concurrent DNS query. This closes the classic DNS-rebinding TOCTOU window.
5. **Per-hop redirect re-validation.** Redirect responses are handled manually with `redirect: "manual"`. Every `Location` target goes through steps 1-4 before we dial it: the scheme allow-list and the literal-IP / `localhost*` checks run inside `sendHop()` on every hop (not only on the initial URL), and hostnames are additionally resolved and pinned. A 302 from a public host to `http://127.0.0.1`, `http://169.254.169.254`, `http://[::1]`, `http://2130706433` or `ftp://...` is caught. (Versions 0.3.0-0.7.0 skipped the IP check for literal-IP redirect targets, and no version before 0.7.1 re-checked the scheme on a redirect -- the latter without practical impact, since the runtime's fetch rejects non-http(s) URLs. Fixed in 0.7.1.)
6. **Cross-origin credential stripping.** `Authorization` (from explicit `headers`, `basic_auth`, or `bearer_token`), `Cookie` and `Proxy-Authorization` headers are stripped when a redirect leaves the initial origin (scheme, host or port changes). Matches the behavior of `curl` / fetch for `Authorization`; `Cookie` and `Proxy-Authorization` joined it in 0.7.1.
7. **Streaming size cap with `AbortController`.** Response bodies are read as a stream and the request is aborted once `max_bytes` is hit. We never buffer a full response and then truncate. Hard ceiling: 100 MiB. A gzipped sitemap (`fetch_sitemap` decompresses `.xml.gz` itself) is also capped at `max_bytes` DECOMPRESSED, so a small gzip bomb cannot inflate past the limit.
8. **Request timeout via `AbortController`.** Every hop carries a per-hop timeout; defaults to 10s, capped at 120s by the tool schema.
9. **Redirect body drain.** 3xx response bodies are cancelled (not buffered) before following the `Location`, preventing a hostile server from ballooning memory use via a large redirect body.
10. **JSON auto-parse is content-type gated.** The response is only auto-parsed into `.json` when the server declares `application/json` or `+json`. An HTML page containing a JSON fragment never ends up in `.json`.
11. **Operator gate on `allow_private_hosts`.** The per-call `allow_private_hosts: true` opt-in is a tool argument, and the LLM chooses tool arguments -- so on its own it would hand the injected prompt above a one-flag bypass. It is refused (before any DNS or network work) unless the operator launched the server with `FETCH_MCP_ALLOW_PRIVATE_HOSTS=1`. The value is parsed strictly -- `1`/`true`/`yes`/`on`, anything unrecognised is OFF and named on stderr -- and under the oam sandbox (`FETCH_MCP_SANDBOX=1`) the launcher grants that one variable and no other. Enforced in `httpRequest()`, the single path every tool takes to the network. Before 0.7.1 the flag was honoured unconditionally.

## Known non-goals / limitations

- We do not perform full HTML parsing for SSRF-adjacent threats (e.g. SSRF via `<img>` in reader mode) because this server does not fetch subresources -- only the URL the tool was asked to fetch.
- `allow_private_hosts: true` bypasses defenses 2-5 entirely for that call. It only works when the operator set `FETCH_MCP_ALLOW_PRIVATE_HOSTS=1` (defense 11); set that only where the model may legitimately reach your internal network.
- Credential stripping (defense 6) recognises headers by name. Arbitrary custom headers that carry secrets (`X-Api-Key`, `X-Auth-Token`, ...) still follow a cross-origin redirect -- pass secrets through `bearer_token` / `basic_auth`, or set `max_redirects: 0`, when the target may redirect off-origin.
- A 307/308 redirect re-sends the request body to the new location, including a cross-origin one, as the fetch spec and `curl -L` do. Set `max_redirects: 0` for bodies that must not leave the origin.
- We rely on the operating system resolver. If the resolver itself is compromised (e.g. `/etc/hosts` poisoning), the pinning step still only dials an address we were handed -- the blast radius is bounded to what that resolver already allows.

## Disclosure policy

Researchers acting in good faith will not face legal action from Yaw Labs. If you find something, tell us and we will credit you in the release notes.
