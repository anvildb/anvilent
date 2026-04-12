// ---------------------------------------------------------------------------
// Anvil DB TypeScript Client — URI parser
// ---------------------------------------------------------------------------

import type { AnvilUriComponents } from "./types.js";

/**
 * Parse an Anvil DB connection URI.
 *
 * Supported schemes:
 * - `anvil://` for plain HTTP connections
 * - `anvil+tls://` for HTTPS connections
 *
 * Format:
 * ```
 * anvil://[user:pass@]host[:port][/database]
 * anvil+tls://[user:pass@]host[:port][/database]
 * ```
 *
 * The default port is **7474**.
 *
 * @param uri - The connection URI string.
 * @returns Parsed URI components.
 * @throws {Error} If the scheme is not `anvil://` or `anvil+tls://`.
 *
 * @example
 * ```ts
 * const parts = parseAnvilUri("anvil://admin:secret@db.example.com:9999/mydb");
 * // { tls: false, host: "db.example.com", port: 9999, database: "mydb",
 * //   username: "admin", password: "secret" }
 * ```
 */
export function parseAnvilUri(uri: string): AnvilUriComponents {
  let tls = false;
  let rest: string;

  if (uri.startsWith("anvil+tls://")) {
    tls = true;
    rest = uri.slice("anvil+tls://".length);
  } else if (uri.startsWith("anvil://")) {
    rest = uri.slice("anvil://".length);
  } else {
    throw new Error(
      `Invalid Anvil URI scheme: expected 'anvil://' or 'anvil+tls://', got '${uri}'`,
    );
  }

  // Split credentials from host portion.
  let credentials: string | undefined;
  let hostPart: string;

  const atIndex = rest.lastIndexOf("@");
  if (atIndex !== -1) {
    credentials = rest.slice(0, atIndex);
    hostPart = rest.slice(atIndex + 1);
  } else {
    hostPart = rest;
  }

  // Extract username / password.
  let username: string | undefined;
  let password: string | undefined;
  if (credentials !== undefined) {
    const colonIndex = credentials.indexOf(":");
    if (colonIndex !== -1) {
      username = decodeURIComponent(credentials.slice(0, colonIndex));
      password = decodeURIComponent(credentials.slice(colonIndex + 1));
    } else {
      username = decodeURIComponent(credentials);
    }
  }

  // Split host:port from /database.
  let hostPort: string;
  let database: string | undefined;

  const slashIndex = hostPart.indexOf("/");
  if (slashIndex !== -1) {
    hostPort = hostPart.slice(0, slashIndex);
    const db = hostPart.slice(slashIndex + 1);
    database = db.length > 0 ? db : undefined;
  } else {
    hostPort = hostPart;
  }

  // Split host and port.
  let host: string;
  let port = 7474;

  const colonIndex = hostPort.lastIndexOf(":");
  if (colonIndex !== -1) {
    host = hostPort.slice(0, colonIndex);
    const portStr = hostPort.slice(colonIndex + 1);
    const parsed = Number.parseInt(portStr, 10);
    if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`Invalid port in Anvil URI: '${portStr}'`);
    }
    port = parsed;
  } else {
    host = hostPort;
  }

  if (host.length === 0) {
    host = "localhost";
  }

  return { tls, host, port, database, username, password };
}

/**
 * Build a base HTTP(S) URL from parsed URI components.
 *
 * @param components - Parsed URI components from {@link parseAnvilUri}.
 * @returns A URL string like `http://host:port`.
 */
export function buildBaseUrl(components: AnvilUriComponents): string {
  const scheme = components.tls ? "https" : "http";
  return `${scheme}://${components.host}:${components.port}`;
}
