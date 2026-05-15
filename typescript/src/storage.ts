// ---------------------------------------------------------------------------
// Anvil DB TypeScript Client — Storage namespace (Phase 25.13)
// ---------------------------------------------------------------------------
//
// Mirrors the Supabase Storage JS API where signatures overlap, but uses the
// Anvil REST routes documented in TODO.md §25.3. Two layers:
//
//   - `Storage`           — bucket-level CRUD + `from(bucket)` builder
//   - `StorageBucketBuilder` — object-level operations scoped to one bucket
//
// HTTP layer is delegated to `AnvilClient._rawRequest` so we inherit the
// timeout + 401 refresh-retry behavior, and we never re-implement auth here.

import { AnvilError } from "./errors.js";
import type { AnvilClient } from "./client.js";
import type {
  Bucket,
  CreateBucketOptions,
  FileObject,
  ImageTransform,
  ListOptions,
  ListResult,
  ObjectMetadata,
  PublicUrlOptions,
  PublicUrlResult,
  ResumableUploadOptions,
  SignedUploadUrlOptions,
  SignedUploadUrlResult,
  SignedUrlOptions,
  SignedUrlResult,
  UpdateBucketOptions,
  UploadOptions,
  UploadResult,
  UsageReport,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "/storage/v1";

/**
 * Parse a byte-size hint into an integer. Accepts either a plain number
 * (returned unchanged) or a string with a unit suffix using either SI
 * (`KB`, `MB`, `GB`, `TB`) or IEC (`KiB`, `MiB`, `GiB`, `TiB`) multipliers.
 * Bare numeric strings ("123") are also accepted.
 *
 * @internal
 */
export function parseByteSize(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new AnvilError(`invalid byte size: ${value}`);
    }
    return Math.floor(value);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new AnvilError("empty byte-size string");
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)?$/i);
  if (!match) {
    throw new AnvilError(`invalid byte size: ${value}`);
  }
  const n = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "B").toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1_000,
    MB: 1_000_000,
    GB: 1_000_000_000,
    TB: 1_000_000_000_000,
    KIB: 1_024,
    MIB: 1_024 * 1_024,
    GIB: 1_024 * 1_024 * 1_024,
    TIB: 1_024 * 1_024 * 1_024 * 1_024,
  };
  const mult = multipliers[unit];
  if (mult === undefined) {
    throw new AnvilError(`unknown byte-size unit: ${unit}`);
  }
  return Math.floor(n * mult);
}

/**
 * Percent-encode each segment of a path independently so slashes are
 * preserved in the URL. The server captures the path via `{*path}` so
 * literal `/` is required.
 *
 * @internal
 */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Build a query string from a transform spec. Returns `""` when the
 * spec has no fields set.
 *
 * @internal
 */
function transformToQuery(transform: ImageTransform | undefined): string {
  if (!transform) return "";
  const params = new URLSearchParams();
  if (transform.width !== undefined) params.set("width", String(transform.width));
  if (transform.height !== undefined) params.set("height", String(transform.height));
  if (transform.resize !== undefined) params.set("resize", transform.resize);
  if (transform.format !== undefined) params.set("format", transform.format);
  if (transform.quality !== undefined) params.set("quality", String(transform.quality));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Normalize a `Bucket` REST response into our public shape. The server
 * uses snake_case; we expose camelCase to match the rest of the SDK.
 *
 * @internal
 */
function normalizeBucket(raw: Record<string, unknown>): Bucket {
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    public: Boolean(raw.public),
    fileSizeLimit:
      raw.file_size_limit === null || raw.file_size_limit === undefined
        ? null
        : Number(raw.file_size_limit),
    bucketSizeLimit:
      raw.bucket_size_limit === null || raw.bucket_size_limit === undefined
        ? null
        : Number(raw.bucket_size_limit),
    allowedMimeTypes: Array.isArray(raw.allowed_mime_types)
      ? (raw.allowed_mime_types as string[])
      : [],
    owner: String(raw.owner ?? ""),
    createdAt: Number(raw.created_at ?? 0),
    updatedAt: Number(raw.updated_at ?? 0),
  };
}

/** @internal */
function normalizeUpload(raw: Record<string, unknown>): UploadResult {
  return {
    id: String(raw.id),
    bucketId: String(raw.bucket_id),
    path: String(raw.path),
    name: String(raw.name),
    mimeType: String(raw.mime_type),
    size: Number(raw.size),
    etag: String(raw.etag),
    contentHash: String(raw.content_hash),
    version: Number(raw.version),
    deduped: Boolean(raw.deduped),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

/** @internal */
function normalizeMetadata(raw: Record<string, unknown>): ObjectMetadata {
  return {
    ...normalizeUpload(raw),
    metadata:
      typeof raw.metadata === "object" && raw.metadata !== null
        ? (raw.metadata as Record<string, unknown>)
        : {},
    owner: String(raw.owner ?? ""),
    lastAccessedAt: Number(raw.last_accessed_at ?? 0),
  };
}

/** @internal */
function normalizeFile(raw: Record<string, unknown>): FileObject {
  return {
    path: String(raw.path),
    name: String(raw.name),
    size: Number(raw.size),
    mimeType: String(raw.mime_type),
    etag: String(raw.etag),
    contentHash: String(raw.content_hash),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

/** @internal */
function normalizeUsage(raw: Record<string, unknown>): UsageReport {
  const buckets = Array.isArray(raw.buckets) ? (raw.buckets as Array<Record<string, unknown>>) : [];
  const users = Array.isArray(raw.users) ? (raw.users as Array<Record<string, unknown>>) : [];
  return {
    objectCount: Number(raw.object_count ?? 0),
    totalBytes: Number(raw.total_bytes ?? 0),
    buckets: buckets.map((b) => ({
      bucketId: String(b.bucket_id),
      objectCount: Number(b.object_count ?? 0),
      totalBytes: Number(b.total_bytes ?? 0),
      bucketSizeLimit:
        b.bucket_size_limit === undefined || b.bucket_size_limit === null
          ? undefined
          : Number(b.bucket_size_limit),
    })),
    users: users.map((u) => ({
      owner: String(u.owner),
      objectCount: Number(u.object_count ?? 0),
      totalBytes: Number(u.total_bytes ?? 0),
    })),
    maxTotalStorage:
      raw.max_total_storage === undefined || raw.max_total_storage === null
        ? undefined
        : Number(raw.max_total_storage),
  };
}

/**
 * Surface a `Response` as an `AnvilError` when the status is not 2xx,
 * preserving the server-provided error message when present.
 *
 * @internal
 */
async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  throw await AnvilError.fromResponse(response);
}

// ---------------------------------------------------------------------------
// Bucket builder (per-bucket operations)
// ---------------------------------------------------------------------------

/**
 * Per-bucket operations: upload, download, signed URLs, list, move, copy,
 * remove, etc. Obtained via {@link Storage.from}.
 */
export class StorageBucketBuilder {
  /** @internal */
  private readonly _client: AnvilClient;
  /** @internal */
  public readonly bucket: string;

  /** @internal */
  constructor(client: AnvilClient, bucket: string) {
    this._client = client;
    this.bucket = bucket;
  }

  /** @internal */
  private _path(path: string): string {
    return `${STORAGE_PREFIX}/object/${encodeURIComponent(this.bucket)}/${encodePath(path)}`;
  }

  /** @internal */
  private async _raw(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal } = {},
  ): Promise<Response> {
    return this._client["_rawRequest"](method, path, init);
  }

  // -------------------------------------------------------------------------
  // Upload (single-shot)
  // -------------------------------------------------------------------------

  /**
   * Upload a small file in a single request. For files larger than a few
   * megabytes prefer {@link uploadResumable} so transient failures don't
   * force the whole transfer to restart.
   *
   * @param path    - Destination path inside the bucket.
   * @param body    - Bytes to upload. Any standard fetch `BodyInit`.
   * @param options - Upload options (see {@link UploadOptions}).
   * @returns The created/updated object descriptor.
   */
  async upload(
    path: string,
    body: Blob | ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    const headers: Record<string, string> = {};
    const contentType = options.contentType ?? inferContentType(body, path);
    if (contentType) headers["Content-Type"] = contentType;
    if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;

    const method = options.upsert ? "PUT" : "POST";
    const response = await this._raw(method, this._path(path), {
      headers,
      body: body as BodyInit,
    });
    await throwIfNotOk(response);
    const raw = (await response.json()) as Record<string, unknown>;
    return normalizeUpload(raw);
  }

  // -------------------------------------------------------------------------
  // Upload (resumable / TUS 1.0.0)
  // -------------------------------------------------------------------------

  /**
   * Upload a file using the TUS 1.0.0 resumable protocol. Splits the body
   * into chunks of `options.chunkSize` (default 5 MiB) and uploads them
   * sequentially. Failed chunks can be resumed by re-calling with the same
   * `path` and `options.resumeFrom` set to the TUS session URL.
   *
   * @param path    - Destination path inside the bucket.
   * @param body    - Either a `Blob` / `File` (browser) or `Uint8Array`.
   * @param options - Resumable upload options.
   * @returns The created object's descriptor plus the TUS session URL.
   */
  async uploadResumable(
    path: string,
    body: Blob | Uint8Array,
    options: ResumableUploadOptions = {},
  ): Promise<UploadResult & { sessionUrl: string }> {
    const total = body instanceof Blob ? body.size : body.byteLength;
    const chunkSize = options.chunkSize ?? 5 * 1024 * 1024;
    if (chunkSize <= 0) {
      throw new AnvilError("chunkSize must be > 0");
    }
    const mime =
      options.contentType ?? inferContentType(body, path) ?? "application/octet-stream";

    // Resolve the TUS session: either resume an existing one or create
    // a fresh session via POST.
    let sessionUrl: string;
    let offset: number;
    if (options.resumeFrom) {
      sessionUrl = options.resumeFrom;
      offset = await this._tusHeadOffset(sessionUrl, options.signal);
    } else {
      const created = await this._tusCreate(path, total, mime, options.signal);
      sessionUrl = created.sessionUrl;
      offset = 0;
    }

    // PATCH the chunks one at a time. Track the final response so we
    // can grab the `Location` + `X-Anvil-Content-Hash` headers emitted
    // when the upload finalizes.
    let finalResponse: Response | undefined;
    while (offset < total) {
      const end = Math.min(offset + chunkSize, total);
      const chunk = await sliceBody(body, offset, end);
      const result = await this._tusPatch(sessionUrl, offset, chunk, options.signal);
      offset = result.offset;
      finalResponse = result.response;
      options.onProgress?.({
        loaded: offset,
        total,
        percent: total === 0 ? 100 : Math.round((offset / total) * 10_000) / 100,
      });
    }

    const contentHash = finalResponse?.headers.get("X-Anvil-Content-Hash") ?? "";
    return {
      id: "",
      bucketId: this.bucket,
      path,
      name: path.split("/").pop() ?? path,
      mimeType: mime,
      size: total,
      etag: contentHash ? `W/"${contentHash}"` : "",
      contentHash,
      version: 0,
      deduped: false,
      createdAt: 0,
      updatedAt: 0,
      sessionUrl,
    };
  }

  /** @internal */
  private async _tusCreate(
    path: string,
    uploadLength: number,
    mime: string,
    signal: AbortSignal | undefined,
  ): Promise<{ sessionUrl: string }> {
    const metadata = encodeUploadMetadata({
      bucket: this.bucket,
      path,
      mime,
    });
    const response = await this._raw("POST", `${STORAGE_PREFIX}/upload/resumable`, {
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(uploadLength),
        "Upload-Metadata": metadata,
      },
      signal,
    });
    if (response.status !== 201) {
      throw await AnvilError.fromResponse(response);
    }
    const location = response.headers.get("Location");
    if (!location) {
      throw new AnvilError("TUS server did not return a Location header");
    }
    // Server emits an absolute path like `/storage/v1/upload/resumable/<id>`.
    return { sessionUrl: location };
  }

  /** @internal */
  private async _tusHeadOffset(
    sessionUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const response = await this._raw("HEAD", sessionUrl, {
      headers: { "Tus-Resumable": "1.0.0" },
      signal,
    });
    if (!response.ok) {
      throw await AnvilError.fromResponse(response);
    }
    const off = response.headers.get("Upload-Offset");
    if (!off) {
      throw new AnvilError("TUS HEAD returned no Upload-Offset header");
    }
    return Number.parseInt(off, 10);
  }

  /** @internal */
  private async _tusPatch(
    sessionUrl: string,
    offset: number,
    chunk: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<{ offset: number; response: Response }> {
    // Pass a fresh `ArrayBuffer` so fetch implementations that don't
    // accept `Uint8Array` BodyInit (or that balk at SharedArrayBuffer-
    // backed views) work transparently.
    const buffer =
      chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk.buffer.slice(0)
        : chunk.slice().buffer;
    const response = await this._raw("PATCH", sessionUrl, {
      headers: {
        "Tus-Resumable": "1.0.0",
        "Content-Type": "application/offset+octet-stream",
        "Upload-Offset": String(offset),
      },
      body: buffer as ArrayBuffer,
      signal,
    });
    if (!response.ok) {
      throw await AnvilError.fromResponse(response);
    }
    const newOffset = response.headers.get("Upload-Offset");
    if (!newOffset) {
      throw new AnvilError("TUS PATCH returned no Upload-Offset header");
    }
    return { offset: Number.parseInt(newOffset, 10), response };
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * Download an object as a `Blob`. For very large files prefer
   * {@link downloadStream} so bytes don't have to be buffered in memory.
   *
   * @param path    - Object path within the bucket.
   * @param signal  - Optional abort signal.
   */
  async download(path: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this._raw("GET", this._path(path), { signal });
    await throwIfNotOk(response);
    return await response.blob();
  }

  /**
   * Download an object as a `ReadableStream<Uint8Array>` — no full-body
   * buffering. Use for large files where memory pressure matters.
   *
   * @param path    - Object path within the bucket.
   * @param signal  - Optional abort signal.
   */
  async downloadStream(
    path: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this._raw("GET", this._path(path), { signal });
    await throwIfNotOk(response);
    if (!response.body) {
      throw new AnvilError("response body is not a stream");
    }
    return response.body;
  }

  // -------------------------------------------------------------------------
  // URLs
  // -------------------------------------------------------------------------

  /**
   * Build a public URL for an object. The bucket must be public.
   *
   * When `options.transform` is set, the URL routes through the
   * `/render/image/public/...` endpoint instead and returns a transformed
   * variant. The URL is built client-side — no HTTP request is made.
   */
  getPublicUrl(path: string, options: PublicUrlOptions = {}): PublicUrlResult {
    const encoded = `${encodeURIComponent(this.bucket)}/${encodePath(path)}`;
    const route = options.transform
      ? `${STORAGE_PREFIX}/render/image/public/${encoded}`
      : `${STORAGE_PREFIX}/object/public/${encoded}`;
    const qs = options.transform ? transformToQuery(options.transform) : "";
    let url = `${this._client["_baseUrl"]}${route}${qs}`;
    if (options.download) {
      const dlParam =
        typeof options.download === "string"
          ? `download=${encodeURIComponent(options.download)}`
          : "download";
      url += `${qs ? "&" : "?"}${dlParam}`;
    }
    return { publicUrl: url };
  }

  /**
   * Mint a signed URL that lets the holder download an object without
   * being authenticated. TTL is in seconds; the server clamps against
   * `signed_url_max_ttl`. Pass `0` to use the configured default.
   *
   * When `options.transform` is set, the URL routes through the signed
   * render endpoint and bakes the transform parameters into the token.
   */
  async createSignedUrl(
    path: string,
    expiresIn: number,
    options: SignedUrlOptions = {},
  ): Promise<SignedUrlResult> {
    const useRender = !!options.transform;
    const route = useRender
      ? `${STORAGE_PREFIX}/render/image/sign/${encodeURIComponent(this.bucket)}/${encodePath(path)}`
      : `${STORAGE_PREFIX}/object/sign/${encodeURIComponent(this.bucket)}/${encodePath(path)}`;

    const body: Record<string, unknown> = { expires_in: expiresIn };
    if (options.transform) body.transform = options.transform;

    const response = await this._raw("POST", route, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await throwIfNotOk(response);
    const raw = (await response.json()) as {
      token: string;
      url: string;
      expires_at: number;
      expires_in: number;
    };

    let signedUrl = `${this._client["_baseUrl"]}${raw.url}`;
    if (options.download) {
      const dlParam =
        typeof options.download === "string"
          ? `download=${encodeURIComponent(options.download)}`
          : "download";
      signedUrl += `?${dlParam}`;
    }
    return {
      signedUrl,
      token: raw.token,
      expiresAt: raw.expires_at,
      expiresIn: raw.expires_in,
    };
  }

  /**
   * Mint a signed URL that lets the holder upload (PUT) an object without
   * being authenticated. TTL is in seconds; `0` (or omitted) uses the
   * configured default.
   */
  async createSignedUploadUrl(
    path: string,
    options: SignedUploadUrlOptions = {},
  ): Promise<SignedUploadUrlResult> {
    const route = `${STORAGE_PREFIX}/object/upload/sign/${encodeURIComponent(
      this.bucket,
    )}/${encodePath(path)}`;
    const body: Record<string, unknown> = { expires_in: options.expiresIn ?? 0 };
    const response = await this._raw("POST", route, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await throwIfNotOk(response);
    const raw = (await response.json()) as {
      token: string;
      url: string;
      expires_at: number;
      expires_in: number;
    };
    return {
      signedUrl: `${this._client["_baseUrl"]}${raw.url}`,
      token: raw.token,
      expiresAt: raw.expires_at,
      expiresIn: raw.expires_in,
    };
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * List objects in the bucket, optionally filtered by a path prefix.
   *
   * @param prefix  - Filter to objects whose `path` starts with this prefix.
   *                  Pass `""` to list everything.
   * @param options - Pagination + sorting.
   */
  async list(prefix?: string, options: ListOptions = {}): Promise<ListResult> {
    const route = `${STORAGE_PREFIX}/object/list/${encodeURIComponent(this.bucket)}`;
    const body: Record<string, unknown> = {};
    if (prefix !== undefined && prefix !== "") body.prefix = prefix;
    if (options.limit !== undefined) body.limit = options.limit;
    if (options.offset !== undefined) body.offset = options.offset;
    if (options.sortBy) {
      body.sort_by = options.sortBy.column;
      if (options.sortBy.order) body.order = options.sortBy.order;
    }
    const response = await this._raw("POST", route, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await throwIfNotOk(response);
    const raw = (await response.json()) as {
      bucket_id: string;
      items: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
    };
    return {
      bucketId: raw.bucket_id,
      items: raw.items.map(normalizeFile),
      total: raw.total,
      limit: raw.limit,
      offset: raw.offset,
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Move (rename) an object within the bucket. */
  async move(fromPath: string, toPath: string): Promise<ObjectMetadata> {
    return this._moveOrCopy("move", fromPath, toPath);
  }

  /** Copy an object within the bucket. */
  async copy(fromPath: string, toPath: string): Promise<ObjectMetadata> {
    return this._moveOrCopy("copy", fromPath, toPath);
  }

  /** @internal */
  private async _moveOrCopy(
    op: "move" | "copy",
    fromPath: string,
    toPath: string,
  ): Promise<ObjectMetadata> {
    const route = `${STORAGE_PREFIX}/object/${op}`;
    const response = await this._raw("POST", route, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_bucket: this.bucket,
        source_path: fromPath,
        dest_bucket: this.bucket,
        dest_path: toPath,
      }),
    });
    await throwIfNotOk(response);
    const raw = (await response.json()) as Record<string, unknown>;
    return normalizeMetadata(raw);
  }

  /**
   * Remove one or more objects from the bucket. Returns the list of paths
   * the server confirmed were deleted (missing paths are skipped silently
   * by the server today, but that may change).
   */
  async remove(paths: string[]): Promise<string[]> {
    const removed: string[] = [];
    // The REST API takes one DELETE per path. Issue them in parallel —
    // capped at a small concurrency level so we don't flood the server.
    const concurrency = 8;
    let i = 0;
    const workers: Promise<void>[] = [];
    const next = async (): Promise<void> => {
      while (i < paths.length) {
        const idx = i++;
        const path = paths[idx]!;
        const response = await this._raw("DELETE", this._path(path));
        if (response.status === 404) {
          continue;
        }
        if (!response.ok) {
          throw await AnvilError.fromResponse(response);
        }
        removed.push(path);
      }
    };
    for (let w = 0; w < Math.min(concurrency, paths.length); w++) {
      workers.push(next());
    }
    await Promise.all(workers);
    return removed;
  }

  /**
   * Fetch metadata for an object without downloading the body. Returns
   * `null` when the object doesn't exist (or the caller can't see it
   * because of RLS).
   */
  async info(path: string): Promise<ObjectMetadata | null> {
    // The server's HEAD endpoint returns headers only. We use the listing
    // endpoint to get full metadata via the prefix filter.
    const list = await this.list(path, { limit: 1 });
    if (list.items.length === 0) return null;
    const hit = list.items.find((it) => it.path === path);
    if (!hit) return null;
    // Promote the listing row into a metadata response shape. The server
    // exposes a richer metadata response via copy/move; for `info()` we
    // synthesize a compatible record.
    return {
      id: "",
      bucketId: list.bucketId,
      path: hit.path,
      name: hit.name,
      mimeType: hit.mimeType,
      size: hit.size,
      etag: hit.etag,
      contentHash: hit.contentHash,
      version: 0,
      deduped: false,
      createdAt: hit.createdAt,
      updatedAt: hit.updatedAt,
      metadata: {},
      owner: "",
      lastAccessedAt: 0,
    };
  }

  /** Return true iff an object exists at the given path. */
  async exists(path: string): Promise<boolean> {
    const response = await this._raw("HEAD", this._path(path));
    if (response.status === 404) return false;
    if (!response.ok) {
      throw await AnvilError.fromResponse(response);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Storage namespace (top-level)
// ---------------------------------------------------------------------------

/**
 * Storage namespace. Obtained via {@link AnvilClient.storage}.
 *
 * Bucket-level operations live here; per-bucket object operations live
 * on the {@link StorageBucketBuilder} returned by {@link from}.
 */
export class Storage {
  /** @internal */
  private readonly _client: AnvilClient;

  /** @internal */
  constructor(client: AnvilClient) {
    this._client = client;
  }

  /** @internal */
  private async _raw(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    return this._client["_rawRequest"](method, path, init);
  }

  /** Scope subsequent calls to a single bucket. */
  from(bucket: string): StorageBucketBuilder {
    return new StorageBucketBuilder(this._client, bucket);
  }

  // -------------------------------------------------------------------------
  // Bucket CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new bucket.
   *
   * @param id      - Slug identifier — URL-safe and unique. Doubles as the
   *                  bucket's document key.
   * @param options - Bucket settings (public flag, size limits, MIME types).
   */
  async createBucket(id: string, options: CreateBucketOptions = {}): Promise<Bucket> {
    const body: Record<string, unknown> = { id };
    if (options.public !== undefined) body.public = options.public;
    if (options.fileSizeLimit !== undefined) {
      body.file_size_limit = parseByteSize(options.fileSizeLimit);
    }
    if (options.bucketSizeLimit !== undefined) {
      body.bucket_size_limit = parseByteSize(options.bucketSizeLimit);
    }
    if (options.allowedMimeTypes) body.allowed_mime_types = options.allowedMimeTypes;
    const response = await this._raw("POST", `${STORAGE_PREFIX}/bucket`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await throwIfNotOk(response);
    return normalizeBucket((await response.json()) as Record<string, unknown>);
  }

  /** List all buckets visible to the caller. */
  async listBuckets(): Promise<{ data: Bucket[] }> {
    const response = await this._raw("GET", `${STORAGE_PREFIX}/bucket`);
    await throwIfNotOk(response);
    const raw = (await response.json()) as Array<Record<string, unknown>>;
    return { data: raw.map(normalizeBucket) };
  }

  /** Fetch a single bucket by id. */
  async getBucket(id: string): Promise<Bucket> {
    const response = await this._raw(
      "GET",
      `${STORAGE_PREFIX}/bucket/${encodeURIComponent(id)}`,
    );
    await throwIfNotOk(response);
    return normalizeBucket((await response.json()) as Record<string, unknown>);
  }

  /**
   * Update bucket settings. Pass `null` for `fileSizeLimit` or
   * `bucketSizeLimit` to explicitly clear an existing limit.
   */
  async updateBucket(id: string, options: UpdateBucketOptions): Promise<Bucket> {
    const body: Record<string, unknown> = {};
    if (options.public !== undefined) body.public = options.public;
    if (options.fileSizeLimit !== undefined) {
      body.file_size_limit =
        options.fileSizeLimit === null ? null : parseByteSize(options.fileSizeLimit);
    }
    if (options.bucketSizeLimit !== undefined) {
      body.bucket_size_limit =
        options.bucketSizeLimit === null ? null : parseByteSize(options.bucketSizeLimit);
    }
    if (options.allowedMimeTypes !== undefined) {
      body.allowed_mime_types = options.allowedMimeTypes;
    }
    const response = await this._raw(
      "PUT",
      `${STORAGE_PREFIX}/bucket/${encodeURIComponent(id)}`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    await throwIfNotOk(response);
    return normalizeBucket((await response.json()) as Record<string, unknown>);
  }

  /** Delete a bucket. It must be empty — use {@link emptyBucket} first. */
  async deleteBucket(id: string): Promise<void> {
    const response = await this._raw(
      "DELETE",
      `${STORAGE_PREFIX}/bucket/${encodeURIComponent(id)}`,
    );
    await throwIfNotOk(response);
  }

  /** Delete every object in a bucket, leaving the bucket itself intact. */
  async emptyBucket(id: string): Promise<void> {
    const response = await this._raw(
      "POST",
      `${STORAGE_PREFIX}/bucket/${encodeURIComponent(id)}/empty`,
    );
    await throwIfNotOk(response);
  }

  /**
   * Revoke all previously issued signed URLs for a bucket by bumping the
   * bucket's signing version. Useful after a credential leak.
   */
  async revokeSignedUrls(id: string): Promise<void> {
    const response = await this._raw(
      "POST",
      `${STORAGE_PREFIX}/bucket/${encodeURIComponent(id)}/sign-revoke`,
    );
    await throwIfNotOk(response);
  }

  /** Aggregate storage usage across buckets and per-user totals. */
  async getUsage(): Promise<UsageReport> {
    const response = await this._raw("GET", `${STORAGE_PREFIX}/usage`);
    await throwIfNotOk(response);
    return normalizeUsage((await response.json()) as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-internal)
// ---------------------------------------------------------------------------

/**
 * Encode a TUS `Upload-Metadata` header. Per spec, each value is a base64-
 * encoded UTF-8 string and key/value pairs are joined with commas.
 *
 * @internal
 */
export function encodeUploadMetadata(meta: Record<string, string>): string {
  const entries = Object.entries(meta);
  return entries
    .map(([k, v]) => `${k} ${base64UTF8(v)}`)
    .join(",");
}

/** @internal */
function base64UTF8(s: string): string {
  // Prefer the platform-native encoders so this works in browsers, Node,
  // Bun and Deno without special-casing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NodeBuffer = (globalThis as any).Buffer;
  if (typeof NodeBuffer !== "undefined") {
    return NodeBuffer.from(s, "utf-8").toString("base64");
  }
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).btoa(bin);
}

/** @internal */
async function sliceBody(
  body: Blob | Uint8Array,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (body instanceof Blob) {
    const sliced = body.slice(start, end);
    return new Uint8Array(await sliced.arrayBuffer());
  }
  return body.subarray(start, end);
}

/**
 * Infer a MIME type from a value + path. Returns `undefined` when nothing
 * could be guessed.
 *
 * @internal
 */
function inferContentType(
  body: unknown,
  path: string,
): string | undefined {
  if (body && typeof body === "object" && "type" in body) {
    const t = (body as { type?: string }).type;
    if (typeof t === "string" && t !== "") return t;
  }
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return undefined;
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    js: "application/javascript",
    css: "text/css",
    html: "text/html",
    htm: "text/html",
    csv: "text/csv",
    md: "text/markdown",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    zip: "application/zip",
  };
  return map[ext];
}
