// Operator-level policy. The LLM that calls this server's tools is untrusted
// (SECURITY.md threat model), so anything that weakens the SSRF guard must be
// switched on by whoever LAUNCHES the server, not by a tool argument the model
// chooses. A prompt-injected model can set `allow_private_hosts: true` as easily
// as it can pick the URL; before 0.7.1 that was all it took to reach
// http://169.254.169.254/ with the guard "on".

/** Env var the operator sets to let tool calls opt into private / loopback hosts. */
export const ALLOW_PRIVATE_HOSTS_ENV = "FETCH_MCP_ALLOW_PRIVATE_HOSTS";

export type AllowPrivateHostsSetting = "on" | "off" | "unrecognised";

/**
 * How FETCH_MCP_ALLOW_PRIVATE_HOSTS reads. Same grammar as the launcher's
 * FETCH_MCP_SANDBOX parser: 1/true/yes/on (trimmed, case-insensitive) is on;
 * 0/false/no/off, empty and unset are off; anything else is `unrecognised`,
 * which the caller treats as OFF and names on stderr. This one fails CLOSED --
 * a typo must never widen what the model can reach.
 */
export function parseAllowPrivateHostsSetting(value: string | undefined): AllowPrivateHostsSetting {
  if (value === undefined) return "off";
  const v = value.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return "off";
  if (v === "1" || v === "true" || v === "yes" || v === "on") return "on";
  return "unrecognised";
}

/** The stderr line for an unrecognised value, or null when there is nothing to say. */
export function allowPrivateHostsWarning(value: string | undefined): string | null {
  if (parseAllowPrivateHostsSetting(value) !== "unrecognised") return null;
  return (
    `fetch-mcp: ${ALLOW_PRIVATE_HOSTS_ENV}=${(value ?? "").trim()} is not recognised and is treated as off; ` +
    "set it to 1 to let tool calls opt into private hosts with allow_private_hosts, or 0 to refuse them.\n"
  );
}

/** Returned to the model when it sets allow_private_hosts and the operator has not enabled it. */
export const PRIVATE_HOSTS_DISABLED =
  `allow_private_hosts is disabled on this server: the operator has not set ${ALLOW_PRIVATE_HOSTS_ENV}=1. ` +
  "Requests to loopback, private and link-local addresses are refused. Retry without allow_private_hosts for a public URL.";

/** Shared zod `.describe()` text for every tool's allow_private_hosts parameter. */
export const ALLOW_PRIVATE_HOSTS_DESCRIPTION =
  "Allow loopback / private / link-local targets for this call (default false). Refused unless the server operator " +
  `launched fetch-mcp with ${ALLOW_PRIVATE_HOSTS_ENV}=1 -- SSRF protection stays on by default either way.`;
