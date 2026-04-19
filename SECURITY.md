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
- Leakage of request headers or body between requests
- Response-size cap bypass (`max_bytes`) leading to OOM or DOS
- Timeout bypass that allows a slow-loris request to hold a worker indefinitely
- Any path that lets an attacker-controlled URL cause the MCP host process to exfil or mutate local-filesystem/network resources

Out of scope:

- Rate limiting, DoS protection of the upstream server you're fetching (that's your responsibility)
- User-supplied `allow_private_hosts: true` then being surprised that private hosts are reachable
- Vulnerabilities in the MCP client, transport, or LLM you plug this into

## Threat model (what this server is designed to defend)

The MCP host (your editor, your agent) runs this server. An LLM talks to the server over stdio and can call tools with arguments the LLM itself chose. The LLM is **not trusted** — a malicious prompt injected via a previously-fetched page could try to coerce the LLM into calling `http_get` against `http://169.254.169.254/latest/meta-data/` to exfiltrate cloud credentials, or `file:///etc/passwd`, or `http://10.0.0.1/admin` to reach an internal dashboard.

The server refuses those calls by default. SSRF protection is enforced both at URL-validation time and on every redirect hop (DNS is resolved fresh and re-checked, so an open redirect on a public host that 302s to `127.0.0.1` still gets caught).

## Disclosure policy

Researchers acting in good faith will not face legal action from Yaw Labs. If you find something, tell us and we will credit you in the release notes.
