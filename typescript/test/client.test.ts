import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnvilClient, Transaction } from "../src/client.js";
import { AnvilError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function extractHeaders(init: RequestInit | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return h;
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(raw)) {
    for (const [k, v] of raw) h[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(raw)) {
      h[k.toLowerCase()] = String(v);
    }
  }
  return h;
}

/**
 * Install a fetch stub that pulls each queued responder in order. Each
 * responder sees the captured request and returns a Response (or throws).
 */
function installFetch(
  responders: Array<(req: CapturedRequest) => Response | Promise<Response>>,
): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fn = vi.fn(async (input: unknown, init: RequestInit | undefined) => {
    const url = typeof input === "string" ? input : String(input);
    const bodyStr = init?.body;
    let body: unknown;
    if (typeof bodyStr === "string") {
      try {
        body = JSON.parse(bodyStr);
      } catch {
        body = bodyStr;
      }
    }
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: extractHeaders(init),
      body,
    };
    calls.push(captured);
    const responder = responders[i++];
    if (!responder) {
      throw new Error(`Unexpected fetch call #${calls.length} to ${url}`);
    }
    return responder(captured);
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnvilClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("construction", () => {
    it("strips trailing slashes from baseUrl", () => {
      installFetch([() => jsonResponse({ status: "ok" })]);
      const client = new AnvilClient({ baseUrl: "http://localhost:7474///" });
      return client.health().then(() => {
        const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
        expect(mock).toHaveBeenCalledWith(
          "http://localhost:7474/health",
          expect.anything(),
        );
      });
    });
  });

  describe("login", () => {
    it("stores tokens and sends them on subsequent calls", async () => {
      const { calls } = installFetch([
        () =>
          jsonResponse({
            accessToken: "access-1",
            refreshToken: "refresh-1",
            idToken: "id-1",
          }),
        () => jsonResponse({ status: "ok" }),
      ]);

      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      const login = await client.login({ username: "admin", password: "secret" });

      expect(login.accessToken).toBe("access-1");
      expect(calls[0]?.url).toBe("http://localhost:7474/auth/login");
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.body).toEqual({ username: "admin", password: "secret" });
      expect(calls[0]?.headers["authorization"]).toBeUndefined();

      await client.health();
      expect(calls[1]?.headers["authorization"]).toBe("Bearer access-1");
    });
  });

  describe("query", () => {
    it("sends the Cypher body and default database", async () => {
      const { calls } = installFetch([
        () =>
          jsonResponse({
            columns: ["n"],
            rows: [[{ id: 1 }]],
            rowCount: 1,
            executionTimeMs: 5,
          }),
      ]);

      const client = new AnvilClient({
        baseUrl: "http://localhost:7474",
        database: "graph",
      });
      const result = await client.query("MATCH (n) RETURN n", { limit: 1 });

      expect(calls[0]?.url).toBe("http://localhost:7474/db/query");
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.body).toEqual({
        query: "MATCH (n) RETURN n",
        params: { limit: 1 },
        database: "graph",
      });
      expect(calls[0]?.headers["content-type"]).toBe("application/json");
      expect(result.rowCount).toBe(1);
      expect(result.columns).toEqual(["n"]);
    });

    it("allows overriding the database per-query", async () => {
      const { calls } = installFetch([
        () =>
          jsonResponse({
            columns: [],
            rows: [],
            rowCount: 0,
            executionTimeMs: 0,
          }),
      ]);

      const client = new AnvilClient({
        baseUrl: "http://localhost:7474",
        database: "default",
      });
      await client.query("RETURN 1", undefined, "other");

      expect(
        (calls[0]?.body as { database?: string } | undefined)?.database,
      ).toBe("other");
    });
  });

  describe("error handling", () => {
    it("throws an AnvilError for non-2xx JSON responses", async () => {
      installFetch([() => errorResponse(400, "syntax error")]);
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      await expect(client.query("BAD")).rejects.toMatchObject({
        name: "AnvilError",
        message: "syntax error",
        statusCode: 400,
      });
    });

    it("wraps network failures in an AnvilError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      await expect(client.health()).rejects.toBeInstanceOf(AnvilError);
      await expect(client.health()).rejects.toMatchObject({
        message: "fetch failed",
      });
    });

    it("raises a timeout error when the server never responds", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, init?: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }),
      );
      const client = new AnvilClient({
        baseUrl: "http://localhost:7474",
        timeoutMs: 20,
      });
      await expect(client.health()).rejects.toMatchObject({
        name: "AnvilError",
        message: /timed out/,
      });
    });
  });

  describe("401 refresh retry", () => {
    it("refreshes the token once and replays the failed request", async () => {
      const { calls } = installFetch([
        // login
        () =>
          jsonResponse({
            accessToken: "old-access",
            refreshToken: "old-refresh",
            idToken: "id",
          }),
        // first query → 401
        () => errorResponse(401, "token expired"),
        // refresh call → success
        () =>
          jsonResponse({
            accessToken: "new-access",
            refreshToken: "new-refresh",
            idToken: "id",
          }),
        // replayed query → success
        () =>
          jsonResponse({
            columns: [],
            rows: [],
            rowCount: 0,
            executionTimeMs: 1,
          }),
      ]);

      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      await client.login({ username: "u", password: "p" });
      await client.query("RETURN 1");

      expect(calls).toHaveLength(4);
      expect(calls[1]?.headers["authorization"]).toBe("Bearer old-access");
      expect(calls[2]?.url).toBe("http://localhost:7474/auth/refresh");
      expect(calls[2]?.body).toEqual({ refreshToken: "old-refresh" });
      expect(calls[3]?.headers["authorization"]).toBe("Bearer new-access");
    });

    it("does not retry when there is no refresh token", async () => {
      const { calls } = installFetch([
        () => errorResponse(401, "unauthorized"),
      ]);
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      await expect(client.health()).rejects.toMatchObject({ statusCode: 401 });
      expect(calls).toHaveLength(1);
    });

    it("clears tokens and throws when refresh itself fails", async () => {
      installFetch([
        () =>
          jsonResponse({
            accessToken: "a",
            refreshToken: "r",
            idToken: "id",
          }),
        () => errorResponse(401, "expired"),
        () => errorResponse(401, "refresh rejected"),
      ]);
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      await client.login({ username: "u", password: "p" });
      await expect(client.health()).rejects.toMatchObject({
        message: "refresh rejected",
        statusCode: 401,
      });
    });
  });

  describe("transactions", () => {
    it("begins, queries, and commits a transaction", async () => {
      const { calls } = installFetch([
        () => jsonResponse({ txId: "tx-42" }),
        () =>
          jsonResponse({
            columns: ["x"],
            rows: [[1]],
            rowCount: 1,
            executionTimeMs: 1,
          }),
        () => noContentResponse(),
      ]);

      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      const tx = await client.beginTransaction();
      expect(tx).toBeInstanceOf(Transaction);
      expect(tx.txId).toBe("tx-42");

      await tx.query("RETURN 1");
      await tx.commit();

      expect(calls[0]?.url).toBe("http://localhost:7474/db/transaction/begin");
      expect(calls[1]?.url).toBe(
        "http://localhost:7474/db/transaction/tx-42/query",
      );
      expect(calls[1]?.body).toEqual({ query: "RETURN 1", params: undefined });
      expect(calls[2]?.url).toBe(
        "http://localhost:7474/db/transaction/tx-42/commit",
      );
    });

    it("rolls back a transaction", async () => {
      const { calls } = installFetch([
        () => jsonResponse({ txId: "tx-99" }),
        () => noContentResponse(),
      ]);
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      const tx = await client.beginTransaction();
      await tx.rollback();
      expect(calls[1]?.url).toBe(
        "http://localhost:7474/db/transaction/tx-99/rollback",
      );
      expect(calls[1]?.method).toBe("POST");
    });
  });

  describe("database management", () => {
    it("hits the right URLs and encodes names", async () => {
      const { calls } = installFetch([
        () => jsonResponse({ databases: ["one", "two"] }),
        () => jsonResponse({ ok: true }),
        () => noContentResponse(),
        () => jsonResponse({ labels: [] }),
        () => jsonResponse({ nodes: [], edges: [] }),
      ]);

      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      const list = await client.listDatabases();
      await client.createDatabase("fresh");
      await client.dropDatabase("old db");
      await client.getSchema("graph");
      await client.getGraph("graph");

      expect(list.databases).toEqual(["one", "two"]);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe("http://localhost:7474/db");
      expect(calls[1]?.method).toBe("POST");
      expect(calls[1]?.body).toEqual({ name: "fresh" });
      expect(calls[2]?.method).toBe("DELETE");
      expect(calls[2]?.url).toBe("http://localhost:7474/db/old%20db");
      expect(calls[3]?.url).toBe("http://localhost:7474/db/graph/schema");
      expect(calls[4]?.url).toBe("http://localhost:7474/db/graph/graph");
    });
  });

  describe("documents", () => {
    it("routes collection and document operations", async () => {
      const { calls } = installFetch([
        () => jsonResponse([{ name: "users" }]),
        () => jsonResponse({ name: "posts" }),
        () => noContentResponse(),
        () => jsonResponse({ id: "1", title: "hello" }),
        () => jsonResponse({ id: "1", title: "hello" }),
        () => noContentResponse(),
        () => jsonResponse({ documents: [], count: 0 }),
        () => jsonResponse({ documents: [], count: 0 }),
        () => jsonResponse({ results: [] }),
      ]);

      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      await client.listCollections();
      await client.createCollection("posts");
      await client.deleteCollection("posts");
      await client.getDocument("posts", "1");
      await client.putDocument("posts", "1", { title: "hello" });
      await client.deleteDocument("posts", "1");
      await client.queryDocuments("posts", { filter: { title: "hello" } });
      await client.scanDocuments("posts");
      await client.batchDocuments("posts", { operations: [] });

      expect(calls[0]).toMatchObject({ method: "GET", url: "http://localhost:7474/docs" });
      expect(calls[1]).toMatchObject({
        method: "POST",
        url: "http://localhost:7474/docs/posts",
      });
      expect(calls[2]).toMatchObject({
        method: "DELETE",
        url: "http://localhost:7474/docs/posts",
      });
      expect(calls[3]).toMatchObject({
        method: "GET",
        url: "http://localhost:7474/docs/posts/1",
      });
      expect(calls[4]).toMatchObject({
        method: "PUT",
        url: "http://localhost:7474/docs/posts/1",
        body: { title: "hello" },
      });
      expect(calls[5]).toMatchObject({
        method: "DELETE",
        url: "http://localhost:7474/docs/posts/1",
      });
      expect(calls[6]).toMatchObject({
        method: "POST",
        url: "http://localhost:7474/docs/posts/query",
        body: { filter: { title: "hello" } },
      });
      expect(calls[7]).toMatchObject({
        method: "GET",
        url: "http://localhost:7474/docs/posts/scan",
      });
      expect(calls[8]).toMatchObject({
        method: "POST",
        url: "http://localhost:7474/docs/posts/batch",
        body: { operations: [] },
      });
    });
  });

  describe("GraphQL", () => {
    it("posts to /graphql with the request body", async () => {
      const { calls } = installFetch([
        () => jsonResponse({ data: { users: [{ name: "Ada" }] } }),
      ]);
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      const res = await client.graphql<{ users: { name: string }[] }>({
        query: "{ users { name } }",
      });
      expect(calls[0]?.url).toBe("http://localhost:7474/graphql");
      expect(calls[0]?.body).toEqual({ query: "{ users { name } }" });
      expect(res.data?.users[0]?.name).toBe("Ada");
    });
  });

  describe("setAccessToken", () => {
    it("authorizes subsequent requests without calling login", async () => {
      const { calls } = installFetch([() => jsonResponse({ status: "ok" })]);
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      client.setAccessToken("external-token");
      await client.health();
      expect(calls[0]?.headers["authorization"]).toBe("Bearer external-token");
    });
  });

  describe("connect", () => {
    it("parses the URI, builds the base URL, and auto-logs-in with credentials", async () => {
      const { calls } = installFetch([
        () =>
          jsonResponse({
            accessToken: "a",
            refreshToken: "r",
            idToken: "id",
          }),
        () =>
          jsonResponse({
            columns: [],
            rows: [],
            rowCount: 0,
            executionTimeMs: 0,
          }),
      ]);

      const client = await AnvilClient.connect(
        "anvil://admin:secret@localhost:7474/graph",
      );
      await client.query("RETURN 1");

      expect(calls[0]?.url).toBe("http://localhost:7474/auth/login");
      expect(calls[0]?.body).toEqual({ username: "admin", password: "secret" });
      // Default database from URI is applied to query calls.
      expect(
        (calls[1]?.body as { database?: string } | undefined)?.database,
      ).toBe("graph");
    });

    it("does not auto-login when credentials are absent", async () => {
      const { calls } = installFetch([() => jsonResponse({ status: "ok" })]);
      const client = await AnvilClient.connect("anvil://localhost:7474/graph");
      await client.health();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://localhost:7474/health");
    });

    it("uses https for anvil+tls://", async () => {
      const { calls } = installFetch([() => jsonResponse({ status: "ok" })]);
      const client = await AnvilClient.connect("anvil+tls://db.example.com:8443");
      await client.health();
      expect(calls[0]?.url).toBe("https://db.example.com:8443/health");
    });
  });

  describe("server endpoints", () => {
    beforeEach(() => {
      installFetch([
        () => jsonResponse({ name: "anvil", version: "1.0", edition: "ce" }),
        () => jsonResponse({ status: "ok" }),
      ]);
    });

    it("returns server info and health", async () => {
      const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
      const info = await client.serverInfo();
      expect(info.version).toBe("1.0");
      const health = await client.health();
      expect(health.status).toBe("ok");
    });
  });
});
