// ---------------------------------------------------------------------------
// Anvil DB TypeScript Client — Main client class
// ---------------------------------------------------------------------------

import { AnvilError } from "./errors.js";
import type {
  AnvilClientOptions,
  BatchRequest,
  BatchResult,
  BeginTransactionResponse,
  ChangePasswordRequest,
  Collection,
  CypherRequest,
  CypherResult,
  Document,
  DocumentQueryRequest,
  DocumentQueryResult,
  EventsResponse,
  GraphQLRequest,
  GraphQLResponse,
  GraphResponse,
  HealthResponse,
  ImportCypherRequest,
  ListDatabasesResponse,
  LoginRequest,
  LoginResponse,
  RefreshResponse,
  RegisterRequest,
  Role,
  ServerInfo,
  StatsResponse,
  User,
} from "./types.js";
import { buildBaseUrl, parseAnvilUri } from "./uri.js";

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * A handle to an open server-side transaction.
 *
 * Obtained via {@link AnvilClient.beginTransaction}. All queries executed
 * through this object share the same transaction context.
 */
export class Transaction {
  /** @internal */
  private readonly _client: AnvilClient;
  /** The server-assigned transaction ID. */
  public readonly txId: string;

  /** @internal */
  constructor(client: AnvilClient, txId: string) {
    this._client = client;
    this.txId = txId;
  }

  /**
   * Execute a Cypher query within this transaction.
   *
   * @param query  - The Cypher query string.
   * @param params - Optional parameter map.
   * @returns The query result.
   */
  async query(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<CypherResult> {
    return this._client["_request"]<CypherResult>(
      "POST",
      `/db/transaction/${this.txId}/query`,
      { query, params },
    );
  }

  /**
   * Commit this transaction, applying all changes.
   */
  async commit(): Promise<void> {
    await this._client["_request"]<void>(
      "POST",
      `/db/transaction/${this.txId}/commit`,
    );
  }

  /**
   * Roll back this transaction, discarding all changes.
   */
  async rollback(): Promise<void> {
    await this._client["_request"]<void>(
      "POST",
      `/db/transaction/${this.txId}/rollback`,
    );
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * HTTP client driver for Anvil DB.
 *
 * Uses the global `fetch` API (zero runtime dependencies). Works in Node 18+,
 * Bun, Deno, and modern browsers.
 *
 * @example
 * ```ts
 * // Connect via URI (auto-login when credentials are present):
 * const client = await AnvilClient.connect("anvil://admin:secret@localhost:7474/mydb");
 *
 * // Or construct manually:
 * const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
 * await client.login({ username: "admin", password: "secret" });
 *
 * const result = await client.query("MATCH (n) RETURN n LIMIT 10");
 * console.log(result.rows);
 * ```
 */
export class AnvilClient {
  private readonly _baseUrl: string;
  private readonly _timeoutMs: number;
  private _database: string | undefined;

  // Token state ---------------------------------------------------------------
  private _accessToken: string | undefined;
  private _refreshToken: string | undefined;

  // Refresh deduplication — only one in-flight refresh at a time.
  private _refreshPromise: Promise<void> | undefined;

  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  /**
   * Create a new client instance.
   *
   * @param options - Connection options.
   */
  constructor(options: AnvilClientOptions) {
    this._baseUrl = options.baseUrl.replace(/\/+$/, "");
    this._database = options.database;
    this._timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Create and authenticate a client from an Anvil DB connection URI.
   *
   * If the URI contains credentials (`user:pass@`), the client will
   * automatically call {@link login} before returning.
   *
   * @param uri       - Connection string, e.g. `anvil://user:pass@host:port/db`.
   * @param timeoutMs - Optional request timeout in milliseconds.
   * @returns An authenticated {@link AnvilClient}.
   *
   * @example
   * ```ts
   * const client = await AnvilClient.connect("anvil://admin:secret@localhost/mydb");
   * ```
   */
  static async connect(uri: string, timeoutMs?: number): Promise<AnvilClient> {
    const parts = parseAnvilUri(uri);
    const baseUrl = buildBaseUrl(parts);

    const client = new AnvilClient({
      baseUrl,
      database: parts.database,
      timeoutMs,
    });

    if (parts.username && parts.password) {
      await client.login({
        username: parts.username,
        password: parts.password,
      });
    }

    return client;
  }

  // --------------------------------------------------------------------------
  // Internal HTTP helpers
  // --------------------------------------------------------------------------

  /**
   * Build headers for an outgoing request.
   * @internal
   */
  private _headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this._accessToken) {
      h["Authorization"] = `Bearer ${this._accessToken}`;
    }
    return h;
  }

  /**
   * Core request method. Handles timeouts, JSON parsing, and 401 retry.
   * @internal
   */
  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    _isRetry = false,
  ): Promise<T> {
    const url = `${this._baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this._headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AnvilError(`Request timed out after ${this._timeoutMs}ms`);
      }
      throw new AnvilError(
        err instanceof Error ? err.message : "Network request failed",
      );
    } finally {
      clearTimeout(timer);
    }

    // Transparent 401 retry: refresh token once, replay the request.
    if (response.status === 401 && !_isRetry && this._refreshToken) {
      await this._performRefresh();
      return this._request<T>(method, path, body, true);
    }

    if (!response.ok) {
      throw await AnvilError.fromResponse(response);
    }

    // Some endpoints return 204 No Content.
    const contentLength = response.headers.get("content-length");
    if (
      response.status === 204 ||
      contentLength === "0" ||
      response.headers.get("content-type") === null
    ) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  /**
   * Deduplicated token refresh. Multiple concurrent 401 retries will share
   * the same refresh call.
   * @internal
   */
  private async _performRefresh(): Promise<void> {
    if (!this._refreshPromise) {
      this._refreshPromise = this._doRefresh();
    }
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = undefined;
    }
  }

  /** @internal */
  private async _doRefresh(): Promise<void> {
    const url = `${this._baseUrl}/auth/refresh`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ refreshToken: this._refreshToken }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new AnvilError("Token refresh request failed");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      this._accessToken = undefined;
      this._refreshToken = undefined;
      throw await AnvilError.fromResponse(response);
    }

    const data = (await response.json()) as RefreshResponse;
    this._accessToken = data.accessToken;
    this._refreshToken = data.refreshToken;
  }

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  /**
   * Authenticate with the server and store tokens internally.
   *
   * Subsequent requests will automatically include the `Authorization` header.
   *
   * @param credentials - Username and password.
   * @returns The full login response including tokens.
   */
  async login(credentials: LoginRequest): Promise<LoginResponse> {
    const data = await this._request<LoginResponse>(
      "POST",
      "/auth/login",
      credentials,
    );
    this._accessToken = data.accessToken;
    this._refreshToken = data.refreshToken;
    return data;
  }

  /**
   * Refresh the current access token.
   *
   * @returns Fresh tokens.
   */
  async refresh(): Promise<RefreshResponse> {
    await this._performRefresh();
    return {
      accessToken: this._accessToken!,
      refreshToken: this._refreshToken!,
      idToken: "",
    };
  }

  /**
   * Register a new user account.
   *
   * @param payload - Registration data (at minimum `username` and `password`).
   * @returns The server response.
   */
  async register(payload: RegisterRequest): Promise<unknown> {
    return this._request<unknown>("POST", "/auth/register", payload);
  }

  /**
   * Change the authenticated user's password.
   *
   * @param payload - Current and new passwords.
   */
  async changePassword(payload: ChangePasswordRequest): Promise<void> {
    await this._request<void>("POST", "/auth/change-password", payload);
  }

  /**
   * Manually set a bearer token (e.g. from external auth).
   *
   * @param token - The access token to use for subsequent requests.
   */
  setAccessToken(token: string): void {
    this._accessToken = token;
  }

  // --------------------------------------------------------------------------
  // Server
  // --------------------------------------------------------------------------

  /**
   * Retrieve server information (version, edition, etc.).
   *
   * @returns Server metadata.
   */
  async serverInfo(): Promise<ServerInfo> {
    return this._request<ServerInfo>("GET", "/");
  }

  /**
   * Health check.
   *
   * @returns `{ status: "ok" }` when the server is healthy.
   */
  async health(): Promise<HealthResponse> {
    return this._request<HealthResponse>("GET", "/health");
  }

  // --------------------------------------------------------------------------
  // Cypher
  // --------------------------------------------------------------------------

  /**
   * Execute a Cypher query.
   *
   * @param query    - The Cypher query string.
   * @param params   - Optional parameter map.
   * @param database - Override the default database for this query.
   * @returns The query result containing columns and rows.
   *
   * @example
   * ```ts
   * const result = await client.query(
   *   "MATCH (p:Person) WHERE p.age > $minAge RETURN p.name",
   *   { minAge: 21 },
   * );
   * ```
   */
  async query(
    query: string,
    params?: Record<string, unknown>,
    database?: string,
  ): Promise<CypherResult> {
    const body: CypherRequest = {
      query,
      params,
      database: database ?? this._database,
    };
    return this._request<CypherResult>("POST", "/db/query", body);
  }

  // --------------------------------------------------------------------------
  // Transactions
  // --------------------------------------------------------------------------

  /**
   * Begin a new server-side transaction.
   *
   * @returns A {@link Transaction} handle for executing queries, committing,
   *          or rolling back.
   *
   * @example
   * ```ts
   * const tx = await client.beginTransaction();
   * try {
   *   await tx.query("CREATE (n:Temp {val: 1})");
   *   await tx.commit();
   * } catch {
   *   await tx.rollback();
   * }
   * ```
   */
  async beginTransaction(): Promise<Transaction> {
    const data = await this._request<BeginTransactionResponse>(
      "POST",
      "/db/transaction/begin",
    );
    return new Transaction(this, data.txId);
  }

  // --------------------------------------------------------------------------
  // Database management
  // --------------------------------------------------------------------------

  /**
   * List all databases on the server.
   *
   * @returns An object containing the array of database names.
   */
  async listDatabases(): Promise<ListDatabasesResponse> {
    return this._request<ListDatabasesResponse>("GET", "/db");
  }

  /**
   * Create a new database.
   *
   * @param name - The database name.
   * @returns The server response.
   */
  async createDatabase(name: string): Promise<unknown> {
    return this._request<unknown>("POST", "/db", { name });
  }

  /**
   * Drop (delete) a database.
   *
   * @param name - The database name.
   */
  async dropDatabase(name: string): Promise<void> {
    await this._request<void>("DELETE", `/db/${encodeURIComponent(name)}`);
  }

  /**
   * Get the schema of a database (labels, relationship types, properties).
   *
   * @param name - The database name.
   * @returns Schema information (shape depends on server version).
   */
  async getSchema(name: string): Promise<unknown> {
    return this._request<unknown>(
      "GET",
      `/db/${encodeURIComponent(name)}/schema`,
    );
  }

  /**
   * Get the full graph of a database (all nodes and edges).
   *
   * @param name - The database name.
   * @returns Nodes and edges.
   */
  async getGraph(name: string): Promise<GraphResponse> {
    return this._request<GraphResponse>(
      "GET",
      `/db/${encodeURIComponent(name)}/graph`,
    );
  }

  // --------------------------------------------------------------------------
  // GraphQL
  // --------------------------------------------------------------------------

  /**
   * Execute a GraphQL query against the server's GraphQL endpoint.
   *
   * @typeParam T - The expected shape of `data` in the response.
   * @param request - The GraphQL request body.
   * @returns The GraphQL response.
   *
   * @example
   * ```ts
   * const res = await client.graphql<{ users: { name: string }[] }>({
   *   query: `{ users { name } }`,
   * });
   * console.log(res.data?.users);
   * ```
   */
  async graphql<T = unknown>(
    request: GraphQLRequest,
  ): Promise<GraphQLResponse<T>> {
    return this._request<GraphQLResponse<T>>("POST", "/graphql", request);
  }

  // --------------------------------------------------------------------------
  // Documents
  // --------------------------------------------------------------------------

  /**
   * List all document collections.
   *
   * @returns Array of collection descriptors.
   */
  async listCollections(): Promise<Collection[]> {
    return this._request<Collection[]>("GET", "/docs");
  }

  /**
   * Create a new document collection.
   *
   * @param collection - The collection name.
   * @returns The created collection descriptor.
   */
  async createCollection(collection: string): Promise<Collection> {
    return this._request<Collection>(
      "POST",
      `/docs/${encodeURIComponent(collection)}`,
    );
  }

  /**
   * Delete a document collection and all its documents.
   *
   * @param collection - The collection name.
   */
  async deleteCollection(collection: string): Promise<void> {
    await this._request<void>(
      "DELETE",
      `/docs/${encodeURIComponent(collection)}`,
    );
  }

  /**
   * Get a single document by ID.
   *
   * @param collection - The collection name.
   * @param id         - The document ID.
   * @returns The document.
   */
  async getDocument(collection: string, id: string): Promise<Document> {
    return this._request<Document>(
      "GET",
      `/docs/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Create or replace a document.
   *
   * @param collection - The collection name.
   * @param id         - The document ID.
   * @param body       - The document body.
   * @returns The stored document.
   */
  async putDocument(
    collection: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Document> {
    return this._request<Document>(
      "PUT",
      `/docs/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      body,
    );
  }

  /**
   * Delete a single document.
   *
   * @param collection - The collection name.
   * @param id         - The document ID.
   */
  async deleteDocument(collection: string, id: string): Promise<void> {
    await this._request<void>(
      "DELETE",
      `/docs/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Query documents in a collection using a filter.
   *
   * @param collection - The collection name.
   * @param request    - Query filter and pagination options.
   * @returns Matching documents.
   */
  async queryDocuments(
    collection: string,
    request: DocumentQueryRequest,
  ): Promise<DocumentQueryResult> {
    return this._request<DocumentQueryResult>(
      "POST",
      `/docs/${encodeURIComponent(collection)}/query`,
      request,
    );
  }

  /**
   * Scan (list) all documents in a collection.
   *
   * @param collection - The collection name.
   * @returns All documents in the collection.
   */
  async scanDocuments(collection: string): Promise<DocumentQueryResult> {
    return this._request<DocumentQueryResult>(
      "GET",
      `/docs/${encodeURIComponent(collection)}/scan`,
    );
  }

  /**
   * Execute a batch of document operations.
   *
   * @param collection - The collection name.
   * @param request    - The batch operations.
   * @returns Results of each operation.
   */
  async batchDocuments(
    collection: string,
    request: BatchRequest,
  ): Promise<BatchResult> {
    return this._request<BatchResult>(
      "POST",
      `/docs/${encodeURIComponent(collection)}/batch`,
      request,
    );
  }

  // --------------------------------------------------------------------------
  // Admin
  // --------------------------------------------------------------------------

  /**
   * Get server statistics.
   *
   * @returns Server stats (shape depends on server version).
   */
  async stats(): Promise<StatsResponse> {
    return this._request<StatsResponse>("GET", "/admin/stats");
  }

  /**
   * List all users.
   *
   * @returns Array of user records.
   */
  async listUsers(): Promise<User[]> {
    return this._request<User[]>("GET", "/admin/users");
  }

  /**
   * List all roles.
   *
   * @returns Array of role records.
   */
  async listRoles(): Promise<Role[]> {
    return this._request<Role[]>("GET", "/admin/roles");
  }

  /**
   * List server events (audit log).
   *
   * @returns Paginated events response.
   */
  async listEvents(): Promise<EventsResponse> {
    return this._request<EventsResponse>("GET", "/admin/events");
  }

  // --------------------------------------------------------------------------
  // Import
  // --------------------------------------------------------------------------

  /**
   * Import data by executing a Cypher script.
   *
   * @param script - The Cypher script text.
   * @returns The server response.
   */
  async importCypher(script: string): Promise<unknown> {
    const body: ImportCypherRequest = { script };
    return this._request<unknown>("POST", "/db/import/cypher", body);
  }
}
