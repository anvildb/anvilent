// ---------------------------------------------------------------------------
// Anvil DB TypeScript Client — Type Definitions
// ---------------------------------------------------------------------------

// ---- Client configuration -------------------------------------------------

/** Options for creating an {@link AnvilClient}. */
export interface AnvilClientOptions {
  /** Base URL of the Anvil DB server (e.g. `http://localhost:7474`). */
  baseUrl: string;
  /** Default database name sent with queries. */
  database?: string;
  /** Request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

// ---- Auth -----------------------------------------------------------------

/** Credentials for login. */
export interface LoginRequest {
  username: string;
  password: string;
}

/** Tokens returned after successful authentication. */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  mustChangePassword?: boolean;
}

/** Tokens returned after a token refresh. */
export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

/** Registration payload. */
export interface RegisterRequest {
  username: string;
  password: string;
  [key: string]: unknown;
}

/** Change-password payload. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// ---- Server ---------------------------------------------------------------

/** Information returned by `GET /`. */
export interface ServerInfo {
  name?: string;
  version?: string;
  edition?: string;
  [key: string]: unknown;
}

/** Health check response from `GET /health`. */
export interface HealthResponse {
  status: string;
}

// ---- Cypher ---------------------------------------------------------------

/** Body sent to `POST /db/query`. */
export interface CypherRequest {
  query: string;
  params?: Record<string, unknown>;
  database?: string;
}

/** Result of a Cypher query. */
export interface CypherResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionTimeMs: number;
}

// ---- Transactions ---------------------------------------------------------

/** Response from `POST /db/transaction/begin`. */
export interface BeginTransactionResponse {
  txId: string;
}

// ---- Database management --------------------------------------------------

/** Response from `GET /db`. */
export interface ListDatabasesResponse {
  databases: string[];
}

/** Response from `GET /db/{name}/graph`. */
export interface GraphResponse {
  nodes: unknown[];
  edges: unknown[];
}

// ---- GraphQL --------------------------------------------------------------

/** Body sent to `POST /graphql`. */
export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** A single GraphQL error. */
export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

/** Response from `POST /graphql`. */
export interface GraphQLResponse<T = unknown> {
  data: T | null;
  errors?: GraphQLError[];
}

// ---- Documents ------------------------------------------------------------

/** A document collection descriptor. */
export interface Collection {
  name: string;
  [key: string]: unknown;
}

/** A single document. */
export interface Document {
  id: string;
  [key: string]: unknown;
}

/** Body for document query requests. */
export interface DocumentQueryRequest {
  filter?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

/** Result of a document query or scan. */
export interface DocumentQueryResult {
  documents: Document[];
  count: number;
  [key: string]: unknown;
}

/** Body for a batch operation. */
export interface BatchRequest {
  operations: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Result of a batch operation. */
export interface BatchResult {
  results: unknown[];
  [key: string]: unknown;
}

// ---- Admin ----------------------------------------------------------------

/** Server statistics. */
export interface StatsResponse {
  [key: string]: unknown;
}

/** A user record. */
export interface User {
  username: string;
  [key: string]: unknown;
}

/** A role record. */
export interface Role {
  name: string;
  [key: string]: unknown;
}

/** Paginated events response. */
export interface EventsResponse {
  events: unknown[];
  count: number;
  total: number;
}

// ---- Import ---------------------------------------------------------------

/** Body for `POST /db/import/cypher`. */
export interface ImportCypherRequest {
  script: string;
}

// ---- URI ------------------------------------------------------------------

/** Parsed components of an `anvil://` connection URI. */
export interface AnvilUriComponents {
  /** Whether TLS is enabled (`anvil+tls://`). */
  tls: boolean;
  /** Server hostname. */
  host: string;
  /** Server port (default 7474). */
  port: number;
  /** Target database name, if specified in the path. */
  database: string | undefined;
  /** Username from URI credentials. */
  username: string | undefined;
  /** Password from URI credentials. */
  password: string | undefined;
}
