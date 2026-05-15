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

// ---- Storage --------------------------------------------------------------

/** Options accepted by `storage.createBucket()`. */
export interface CreateBucketOptions {
  /** When true, the bucket is anonymously readable via `getPublicUrl`. */
  public?: boolean;
  /**
   * Max upload size per object. Accepts either a number of bytes or a
   * human-readable suffix string ("5MB", "1GiB", "200KB").
   */
  fileSizeLimit?: number | string;
  /** Cap on total bytes across all objects in this bucket. */
  bucketSizeLimit?: number | string;
  /** Whitelist of MIME types. Empty array means "anything goes". */
  allowedMimeTypes?: string[];
}

/** Options accepted by `storage.updateBucket()`. */
export interface UpdateBucketOptions {
  public?: boolean;
  /** Pass `null` to clear the limit. */
  fileSizeLimit?: number | string | null;
  /** Pass `null` to clear the limit. */
  bucketSizeLimit?: number | string | null;
  allowedMimeTypes?: string[];
}

/** A bucket as returned by `GET /storage/v1/bucket`. */
export interface Bucket {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  bucketSizeLimit: number | null;
  allowedMimeTypes: string[];
  owner: string;
  createdAt: number;
  updatedAt: number;
}

/** Options accepted by `bucket.upload()`. */
export interface UploadOptions {
  /** Overrides the auto-detected MIME type. */
  contentType?: string;
  /** When true, replaces any existing object at the same path. */
  upsert?: boolean;
  /** Optional `Cache-Control` header set on the upload request. */
  cacheControl?: string;
}

/** Progress callback payload for resumable uploads. */
export interface UploadProgress {
  /** Bytes uploaded so far. */
  loaded: number;
  /** Total bytes to upload. */
  total: number;
  /** Convenience: `loaded / total * 100`, rounded to two decimals. */
  percent: number;
}

/** Options accepted by `bucket.uploadResumable()`. */
export interface ResumableUploadOptions {
  /** Overrides the auto-detected MIME type. */
  contentType?: string;
  /** Bytes per PATCH chunk. Defaults to 5 MiB. */
  chunkSize?: number;
  /** Callback fired after every successful chunk. */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Resume from an existing TUS session by URL. When set, the client
   * issues a HEAD against this URL to discover the server's offset
   * before sending any PATCH requests.
   */
  resumeFrom?: string;
  /**
   * AbortSignal that aborts the in-flight upload. Closing the underlying
   * session afterwards is the caller's responsibility (use `abort()` to
   * issue a TUS DELETE).
   */
  signal?: AbortSignal;
}

/** Result returned by both single-shot and resumable uploads. */
export interface UploadResult {
  /** Server-assigned object UUID. */
  id: string;
  bucketId: string;
  /** Path within the bucket. */
  path: string;
  /** Last path segment of `path`. */
  name: string;
  mimeType: string;
  size: number;
  etag: string;
  contentHash: string;
  /** Version counter, bumped on every overwrite. */
  version: number;
  /** True when the bytes deduplicated against an existing backend blob. */
  deduped: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Detailed object metadata returned by copy/move endpoints. */
export interface ObjectMetadata extends UploadResult {
  metadata: Record<string, unknown>;
  owner: string;
  lastAccessedAt: number;
}

/** Image transformation options accepted by `getPublicUrl` / `createSignedUrl`. */
export interface ImageTransform {
  width?: number;
  height?: number;
  resize?: "cover" | "contain" | "fill" | (string & {});
  format?: "webp" | "jpeg" | "png" | "avif" | (string & {});
  quality?: number;
}

/** Options accepted by `bucket.getPublicUrl()`. */
export interface PublicUrlOptions {
  /** Image transformation parameters; routes via `/render/image/public`. */
  transform?: ImageTransform;
  /**
   * When set, forces the server to return `Content-Disposition: attachment`
   * with this filename. Browsers will save instead of preview.
   */
  download?: boolean | string;
}

/** Result of `getPublicUrl`. */
export interface PublicUrlResult {
  publicUrl: string;
}

/** Options accepted by `bucket.createSignedUrl()`. */
export interface SignedUrlOptions {
  /** Image transformation parameters. */
  transform?: ImageTransform;
  /** When set, the server adds a `download` query param to the URL. */
  download?: boolean | string;
}

/** Result of `createSignedUrl`. */
export interface SignedUrlResult {
  /** Absolute URL the caller can fetch. */
  signedUrl: string;
  /** Just the opaque token portion of the URL. */
  token: string;
  /** Unix-seconds expiry timestamp. */
  expiresAt: number;
  /** Effective TTL in seconds after server-side clamping. */
  expiresIn: number;
}

/** Options accepted by `bucket.createSignedUploadUrl()`. */
export interface SignedUploadUrlOptions {
  /** TTL in seconds. `0` (default) means "use the server default". */
  expiresIn?: number;
}

/** Result of `createSignedUploadUrl`. */
export interface SignedUploadUrlResult {
  signedUrl: string;
  token: string;
  expiresAt: number;
  expiresIn: number;
}

/** Options accepted by `bucket.list()`. */
export interface ListOptions {
  /** Max items returned. Server clamps to 1000. Defaults to 100. */
  limit?: number;
  /** Page offset. */
  offset?: number;
  /** Sort field and direction. */
  sortBy?: {
    column: "name" | "size" | "created_at" | "updated_at" | (string & {});
    order?: "asc" | "desc";
  };
}

/** A single row from `bucket.list()`. */
export interface FileObject {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  etag: string;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

/** Result of `bucket.list()`. */
export interface ListResult {
  bucketId: string;
  items: FileObject[];
  total: number;
  limit: number;
  offset: number;
}

/** Per-bucket usage row from `storage.getUsage()`. */
export interface BucketUsage {
  bucketId: string;
  objectCount: number;
  totalBytes: number;
  bucketSizeLimit?: number;
}

/** Per-user usage row from `storage.getUsage()`. */
export interface UserUsage {
  owner: string;
  objectCount: number;
  totalBytes: number;
}

/** Result of `storage.getUsage()`. */
export interface UsageReport {
  objectCount: number;
  totalBytes: number;
  buckets: BucketUsage[];
  users: UserUsage[];
  maxTotalStorage?: number;
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
