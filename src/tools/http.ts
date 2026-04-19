import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatHttpResponse } from "../format.js";
import { type HttpMethod, type HttpRequestOptions, httpRequest } from "../http.js";

const commonSchema = {
  url: z.string().url().describe("Target URL (http:// or https://)"),
  headers: z.record(z.string(), z.string()).optional().describe("Extra request headers as a key/value object"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe("Request timeout in ms (default 10000, max 120000)"),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max response body size in bytes before the body is truncated (default 5MiB, ceiling 100MiB)"),
  max_redirects: z.number().int().min(0).max(20).optional().describe("Max redirect hops to follow (default 5)"),
  basic_auth: z
    .object({ username: z.string(), password: z.string() })
    .optional()
    .describe("HTTP Basic auth credentials"),
  bearer_token: z.string().optional().describe("Bearer token sent as Authorization: Bearer <token>"),
  user_agent: z.string().optional().describe("User-Agent override (default identifies as @yawlabs/fetch-mcp)"),
  retries: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("Retries on 408/425/429/500/502/503/504 with exponential backoff (default 0)"),
  allow_private_hosts: z
    .boolean()
    .optional()
    .describe(
      "Allow requests to loopback / private / link-local addresses. SSRF protection is on by default — only flip this when intentionally talking to localhost.",
    ),
  decode_text: z
    .boolean()
    .optional()
    .describe(
      "Force text decoding (true) or binary base64 (false). Defaults to auto — text for text/*, json, xml, etc; binary otherwise.",
    ),
};

const bodySchema = {
  body: z.string().optional().describe("Raw request body as a string"),
  body_json: z
    .any()
    .optional()
    .describe("Request body as a JSON value — sets content-type to application/json if none given"),
  content_type: z
    .string()
    .optional()
    .describe(
      "Content-Type header to send with the body (e.g. application/json, text/plain, application/x-www-form-urlencoded)",
    ),
};

function toRequestOptions(method: HttpMethod, input: Record<string, any>): HttpRequestOptions {
  const opts: HttpRequestOptions = {
    method,
    url: input.url,
    headers: input.headers,
    timeoutMs: input.timeout_ms,
    maxBytes: input.max_bytes,
    maxRedirects: input.max_redirects,
    basicAuth: input.basic_auth,
    bearerToken: input.bearer_token,
    userAgent: input.user_agent,
    retries: input.retries,
    allowPrivateHosts: input.allow_private_hosts,
    decodeText: input.decode_text,
  };
  if (input.body_json !== undefined) {
    opts.body = JSON.stringify(input.body_json);
    opts.contentType = input.content_type ?? "application/json";
  } else if (input.body !== undefined) {
    opts.body = input.body;
    opts.contentType = input.content_type;
  } else if (input.content_type) {
    opts.contentType = input.content_type;
  }
  return opts;
}

export function registerHttpTools(server: McpServer) {
  server.tool(
    "http_get",
    "Perform an HTTP GET. Returns status, headers, and body. Automatically parses JSON when the server responds with application/json. Follows redirects (each hop re-validated against SSRF rules). Refuses URLs that resolve to private/loopback/link-local addresses unless allow_private_hosts is set.",
    commonSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (input) => formatHttpResponse(await httpRequest(toRequestOptions("GET", input))),
  );

  server.tool(
    "http_post",
    "Perform an HTTP POST. Body can be given as a raw string (body) or as a JSON value (body_json — auto-sets content-type to application/json). NOT idempotent: calling twice submits twice.",
    { ...commonSchema, ...bodySchema },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (input) => formatHttpResponse(await httpRequest(toRequestOptions("POST", input))),
  );

  server.tool(
    "http_put",
    "Perform an HTTP PUT. Use for full-resource replacement. Idempotent: the same PUT applied twice leaves the resource in the same state.",
    { ...commonSchema, ...bodySchema },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async (input) => formatHttpResponse(await httpRequest(toRequestOptions("PUT", input))),
  );

  server.tool(
    "http_patch",
    "Perform an HTTP PATCH. Use for partial updates. Spec-wise NOT guaranteed idempotent — depends on the server's patch semantics.",
    { ...commonSchema, ...bodySchema },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (input) => formatHttpResponse(await httpRequest(toRequestOptions("PATCH", input))),
  );

  server.tool(
    "http_delete",
    "Perform an HTTP DELETE. Idempotent (per spec): a repeated DELETE on an already-deleted resource typically returns 404/410.",
    { ...commonSchema, ...bodySchema },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async (input) => formatHttpResponse(await httpRequest(toRequestOptions("DELETE", input))),
  );

  server.tool(
    "http_head",
    "Perform an HTTP HEAD. Returns status + headers with no body. Useful for checking a resource exists, getting its size (Content-Length), or polling for changes cheaply.",
    commonSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (input) => formatHttpResponse(await httpRequest(toRequestOptions("HEAD", input))),
  );

  server.tool(
    "http_options",
    "Perform an HTTP OPTIONS. Returns the server's supported methods and CORS policy for a resource. Helpful for API discovery.",
    commonSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (input) => formatHttpResponse(await httpRequest(toRequestOptions("OPTIONS", input))),
  );
}
