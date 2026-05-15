import { afterEach, describe, expect, it, vi } from "vitest";

import { AnvilClient } from "../src/client.js";
import {
  Storage,
  StorageBucketBuilder,
  encodeUploadMetadata,
  encodePath,
  parseByteSize,
} from "../src/storage.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  bodyBytes?: Uint8Array;
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

async function readBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return undefined;
}

function installFetch(
  responders: Array<(req: CapturedRequest) => Response | Promise<Response>>,
): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fn = vi.fn(async (input: unknown, init: RequestInit | undefined) => {
    const url = typeof input === "string" ? input : String(input);
    let body: unknown;
    let bodyBytes: Uint8Array | undefined;
    const raw = init?.body;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else if (raw !== undefined && raw !== null) {
      bodyBytes = await readBodyBytes(raw as BodyInit);
    }
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: extractHeaders(init),
      body,
      bodyBytes,
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

function makeClient(): AnvilClient {
  const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
  client.setAccessToken("test-token");
  return client;
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

describe("parseByteSize", () => {
  it("parses raw byte counts", () => {
    expect(parseByteSize(0)).toBe(0);
    expect(parseByteSize(1024)).toBe(1024);
    expect(parseByteSize("1024")).toBe(1024);
  });

  it("parses SI suffixes", () => {
    expect(parseByteSize("5MB")).toBe(5_000_000);
    expect(parseByteSize("1GB")).toBe(1_000_000_000);
    expect(parseByteSize("250 KB")).toBe(250_000);
  });

  it("parses IEC suffixes", () => {
    expect(parseByteSize("5MiB")).toBe(5 * 1024 * 1024);
    expect(parseByteSize("1GiB")).toBe(1024 * 1024 * 1024);
  });

  it("rejects garbage", () => {
    expect(() => parseByteSize("not a size")).toThrow();
    expect(() => parseByteSize("")).toThrow();
    expect(() => parseByteSize(-1)).toThrow();
  });
});

describe("encodePath", () => {
  it("preserves slashes but encodes special chars", () => {
    expect(encodePath("users/alice/photo.png")).toBe("users/alice/photo.png");
    expect(encodePath("users/with space/file?.png")).toBe("users/with%20space/file%3F.png");
  });
});

describe("encodeUploadMetadata", () => {
  it("base64-encodes values and joins with commas", () => {
    const meta = encodeUploadMetadata({ bucket: "avatars", path: "alice.png" });
    expect(meta).toContain("bucket ");
    expect(meta).toContain(",path ");
    // base64("avatars") = "YXZhdGFycw=="
    expect(meta).toBe("bucket YXZhdGFycw==,path YWxpY2UucG5n");
  });
});

// ---------------------------------------------------------------------------
// Storage namespace
// ---------------------------------------------------------------------------

describe("Storage namespace plumbing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AnvilClient.storage returns the same Storage instance on repeated reads", () => {
    const client = makeClient();
    const a = client.storage;
    const b = client.storage;
    expect(a).toBeInstanceOf(Storage);
    expect(a).toBe(b);
  });

  it("from() returns a StorageBucketBuilder scoped to the bucket", () => {
    const client = makeClient();
    const bucket = client.storage.from("avatars");
    expect(bucket).toBeInstanceOf(StorageBucketBuilder);
    expect(bucket.bucket).toBe("avatars");
  });
});

// ---------------------------------------------------------------------------
// Bucket CRUD
// ---------------------------------------------------------------------------

describe("bucket operations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createBucket sends body and parses snake_case response", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          id: "avatars",
          name: "avatars",
          public: true,
          file_size_limit: 5_000_000,
          bucket_size_limit: null,
          allowed_mime_types: ["image/png"],
          owner: "admin",
          created_at: 1700,
          updated_at: 1700,
        }),
    ]);

    const client = makeClient();
    const bucket = await client.storage.createBucket("avatars", {
      public: true,
      fileSizeLimit: "5MB",
      allowedMimeTypes: ["image/png"],
    });

    expect(calls[0]?.url).toBe("http://localhost:7474/storage/v1/bucket");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      id: "avatars",
      public: true,
      file_size_limit: 5_000_000,
      allowed_mime_types: ["image/png"],
    });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer test-token");
    expect(bucket).toMatchObject({
      id: "avatars",
      public: true,
      fileSizeLimit: 5_000_000,
      bucketSizeLimit: null,
      allowedMimeTypes: ["image/png"],
    });
  });

  it("listBuckets returns { data: Bucket[] }", async () => {
    installFetch([
      () =>
        jsonResponse([
          {
            id: "a",
            name: "a",
            public: false,
            file_size_limit: null,
            bucket_size_limit: null,
            allowed_mime_types: [],
            owner: "admin",
            created_at: 1,
            updated_at: 1,
          },
          {
            id: "b",
            name: "b",
            public: true,
            file_size_limit: 1000,
            bucket_size_limit: 5000,
            allowed_mime_types: ["image/*"],
            owner: "admin",
            created_at: 2,
            updated_at: 2,
          },
        ]),
    ]);

    const client = makeClient();
    const { data } = await client.storage.listBuckets();
    expect(data).toHaveLength(2);
    expect(data[0]?.id).toBe("a");
    expect(data[1]?.bucketSizeLimit).toBe(5000);
  });

  it("updateBucket passes null limits straight through", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          id: "avatars",
          name: "avatars",
          public: false,
          file_size_limit: null,
          bucket_size_limit: null,
          allowed_mime_types: [],
          owner: "admin",
          created_at: 1,
          updated_at: 2,
        }),
    ]);

    const client = makeClient();
    await client.storage.updateBucket("avatars", {
      public: false,
      fileSizeLimit: null,
      bucketSizeLimit: null,
    });

    expect(calls[0]?.body).toEqual({
      public: false,
      file_size_limit: null,
      bucket_size_limit: null,
    });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("http://localhost:7474/storage/v1/bucket/avatars");
  });

  it("deleteBucket and emptyBucket hit the right routes", async () => {
    const { calls } = installFetch([
      () => noContentResponse(),
      () => noContentResponse(),
    ]);
    const client = makeClient();
    await client.storage.emptyBucket("avatars");
    await client.storage.deleteBucket("avatars");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://localhost:7474/storage/v1/bucket/avatars/empty");
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe("http://localhost:7474/storage/v1/bucket/avatars");
  });

  it("propagates server errors as AnvilError", async () => {
    installFetch([() => errorResponse(409, "bucket already exists")]);
    const client = makeClient();
    await expect(
      client.storage.createBucket("avatars", { public: true }),
    ).rejects.toMatchObject({
      name: "AnvilError",
      message: "bucket already exists",
      statusCode: 409,
    });
  });

  it("getUsage normalizes nested arrays", async () => {
    installFetch([
      () =>
        jsonResponse({
          object_count: 42,
          total_bytes: 1234,
          buckets: [
            { bucket_id: "a", object_count: 1, total_bytes: 100 },
            { bucket_id: "b", object_count: 41, total_bytes: 1134, bucket_size_limit: 9000 },
          ],
          users: [{ owner: "alice", object_count: 30, total_bytes: 900 }],
          max_total_storage: 100000,
        }),
    ]);
    const client = makeClient();
    const usage = await client.storage.getUsage();
    expect(usage.objectCount).toBe(42);
    expect(usage.buckets[1]?.bucketSizeLimit).toBe(9000);
    expect(usage.users[0]?.owner).toBe("alice");
    expect(usage.maxTotalStorage).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// Object upload (single-shot)
// ---------------------------------------------------------------------------

describe("upload (single-shot)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs binary body and infers MIME from path", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          id: "obj-1",
          bucket_id: "avatars",
          path: "alice.png",
          name: "alice.png",
          mime_type: "image/png",
          size: 4,
          etag: 'W/"abc"',
          content_hash: "abc",
          version: 1,
          deduped: false,
          created_at: 100,
          updated_at: 100,
        }),
    ]);

    const client = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await client.storage.from("avatars").upload("alice.png", bytes);

    expect(calls[0]?.url).toBe("http://localhost:7474/storage/v1/object/avatars/alice.png");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("image/png");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer test-token");
    expect(calls[0]?.bodyBytes).toEqual(bytes);
    expect(result.id).toBe("obj-1");
    expect(result.contentHash).toBe("abc");
    expect(result.version).toBe(1);
  });

  it("uses PUT when upsert is true", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          id: "obj-1",
          bucket_id: "avatars",
          path: "alice.png",
          name: "alice.png",
          mime_type: "image/png",
          size: 1,
          etag: "x",
          content_hash: "x",
          version: 2,
          deduped: true,
          created_at: 1,
          updated_at: 2,
        }),
    ]);
    const client = makeClient();
    await client.storage.from("avatars").upload("alice.png", new Uint8Array([1]), {
      upsert: true,
      contentType: "image/png",
      cacheControl: "public, max-age=3600",
    });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("percent-encodes path segments but preserves slashes", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          id: "x",
          bucket_id: "avatars",
          path: "users/alice has space/photo.png",
          name: "photo.png",
          mime_type: "image/png",
          size: 1,
          etag: "x",
          content_hash: "x",
          version: 1,
          deduped: false,
          created_at: 0,
          updated_at: 0,
        }),
    ]);
    const client = makeClient();
    await client.storage
      .from("avatars")
      .upload("users/alice has space/photo.png", new Uint8Array([1]));
    expect(calls[0]?.url).toBe(
      "http://localhost:7474/storage/v1/object/avatars/users/alice%20has%20space/photo.png",
    );
  });
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

describe("download", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a Blob with the response body", async () => {
    installFetch([
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    ]);
    const client = makeClient();
    const blob = await client.storage.from("avatars").download("alice.png");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
  });

  it("downloadStream returns a ReadableStream", async () => {
    installFetch([
      () =>
        new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ]);
    const client = makeClient();
    const stream = await client.storage.from("avatars").downloadStream("big.bin");
    expect(stream).toBeDefined();
    const reader = stream.getReader();
    const chunks: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(...value);
    }
    expect(chunks).toEqual([7, 8, 9]);
  });

  it("throws AnvilError on 404", async () => {
    installFetch([() => errorResponse(404, "not found")]);
    const client = makeClient();
    await expect(
      client.storage.from("avatars").download("missing.png"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

describe("getPublicUrl", () => {
  it("builds the standard public URL", () => {
    const client = makeClient();
    const { publicUrl } = client.storage.from("avatars").getPublicUrl("alice.png");
    expect(publicUrl).toBe(
      "http://localhost:7474/storage/v1/object/public/avatars/alice.png",
    );
  });

  it("routes through /render with transform params", () => {
    const client = makeClient();
    const { publicUrl } = client.storage.from("avatars").getPublicUrl("alice.png", {
      transform: { width: 200, height: 200, resize: "cover", format: "webp" },
    });
    expect(publicUrl).toContain(
      "/storage/v1/render/image/public/avatars/alice.png",
    );
    expect(publicUrl).toContain("width=200");
    expect(publicUrl).toContain("height=200");
    expect(publicUrl).toContain("resize=cover");
    expect(publicUrl).toContain("format=webp");
  });

  it("appends a download flag when requested", () => {
    const client = makeClient();
    const { publicUrl } = client.storage
      .from("avatars")
      .getPublicUrl("alice.png", { download: "headshot.png" });
    expect(publicUrl).toContain("download=headshot.png");
  });
});

describe("createSignedUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to /object/sign and absolutizes the URL", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          token: "tok-xyz",
          url: "/storage/v1/object/signed/tok-xyz",
          expires_at: 5000,
          expires_in: 60,
        }),
    ]);
    const client = makeClient();
    const result = await client.storage.from("avatars").createSignedUrl("alice.png", 60);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "http://localhost:7474/storage/v1/object/sign/avatars/alice.png",
    );
    expect(calls[0]?.body).toEqual({ expires_in: 60 });
    expect(result.signedUrl).toBe(
      "http://localhost:7474/storage/v1/object/signed/tok-xyz",
    );
    expect(result.token).toBe("tok-xyz");
    expect(result.expiresAt).toBe(5000);
    expect(result.expiresIn).toBe(60);
  });

  it("routes through /render/image/sign when transform is provided", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          token: "tok-rs",
          url: "/storage/v1/object/signed/tok-rs",
          expires_at: 5000,
          expires_in: 60,
        }),
    ]);
    const client = makeClient();
    await client.storage.from("avatars").createSignedUrl("alice.png", 60, {
      transform: { width: 100 },
    });
    expect(calls[0]?.url).toBe(
      "http://localhost:7474/storage/v1/render/image/sign/avatars/alice.png",
    );
    expect(calls[0]?.body).toEqual({ expires_in: 60, transform: { width: 100 } });
  });
});

describe("createSignedUploadUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to /object/upload/sign", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          token: "wtok",
          url: "/storage/v1/object/upload/signed/wtok",
          expires_at: 99,
          expires_in: 99,
        }),
    ]);
    const client = makeClient();
    const result = await client.storage
      .from("avatars")
      .createSignedUploadUrl("alice.png", { expiresIn: 120 });
    expect(calls[0]?.url).toBe(
      "http://localhost:7474/storage/v1/object/upload/sign/avatars/alice.png",
    );
    expect(calls[0]?.body).toEqual({ expires_in: 120 });
    expect(result.signedUrl).toBe(
      "http://localhost:7474/storage/v1/object/upload/signed/wtok",
    );
  });
});

// ---------------------------------------------------------------------------
// List / move / copy / remove
// ---------------------------------------------------------------------------

describe("list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts with prefix + sort + pagination", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          bucket_id: "avatars",
          items: [
            {
              path: "users/alice.png",
              name: "alice.png",
              size: 100,
              mime_type: "image/png",
              etag: "x",
              content_hash: "x",
              created_at: 1,
              updated_at: 2,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
    ]);
    const client = makeClient();
    const result = await client.storage.from("avatars").list("users/", {
      limit: 50,
      offset: 0,
      sortBy: { column: "created_at", order: "desc" },
    });
    expect(calls[0]?.url).toBe(
      "http://localhost:7474/storage/v1/object/list/avatars",
    );
    expect(calls[0]?.body).toEqual({
      prefix: "users/",
      limit: 50,
      offset: 0,
      sort_by: "created_at",
      order: "desc",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.path).toBe("users/alice.png");
  });
});

describe("move / copy / remove", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("move posts to /object/move with source+dest", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          id: "obj-1",
          bucket_id: "avatars",
          path: "new.png",
          name: "new.png",
          mime_type: "image/png",
          size: 1,
          etag: "x",
          content_hash: "x",
          version: 2,
          deduped: false,
          metadata: {},
          owner: "admin",
          created_at: 1,
          updated_at: 2,
          last_accessed_at: 0,
        }),
    ]);
    const client = makeClient();
    const meta = await client.storage.from("avatars").move("old.png", "new.png");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://localhost:7474/storage/v1/object/move");
    expect(calls[0]?.body).toEqual({
      source_bucket: "avatars",
      source_path: "old.png",
      dest_bucket: "avatars",
      dest_path: "new.png",
    });
    expect(meta.path).toBe("new.png");
    expect(meta.metadata).toEqual({});
  });

  it("copy hits /object/copy", async () => {
    const { calls } = installFetch([
      () =>
        jsonResponse({
          id: "obj-2",
          bucket_id: "avatars",
          path: "b.png",
          name: "b.png",
          mime_type: "image/png",
          size: 1,
          etag: "x",
          content_hash: "x",
          version: 1,
          deduped: true,
          metadata: {},
          owner: "admin",
          created_at: 1,
          updated_at: 1,
          last_accessed_at: 0,
        }),
    ]);
    const client = makeClient();
    await client.storage.from("avatars").copy("a.png", "b.png");
    expect(calls[0]?.url).toBe("http://localhost:7474/storage/v1/object/copy");
  });

  it("remove issues one DELETE per path and returns the successes", async () => {
    const { calls } = installFetch([
      () => noContentResponse(),
      () => errorResponse(404, "not found"),
      () => noContentResponse(),
    ]);
    const client = makeClient();
    const deleted = await client.storage
      .from("avatars")
      .remove(["a.png", "ghost.png", "b.png"]);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.method === "DELETE")).toBe(true);
    expect(new Set(deleted)).toEqual(new Set(["a.png", "b.png"]));
  });
});

// ---------------------------------------------------------------------------
// Resumable / TUS
// ---------------------------------------------------------------------------

describe("uploadResumable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a TUS session, PATCHes all chunks, fires onProgress", async () => {
    // 10 bytes, chunk size 4 → expect 3 PATCH requests at offsets 0/4/8.
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const finalLocation = "/storage/v1/object/videos/intro.mp4";

    const { calls } = installFetch([
      // POST /upload/resumable — TUS session creation
      () =>
        new Response(null, {
          status: 201,
          headers: {
            Location: "/storage/v1/upload/resumable/session-id",
            "Upload-Offset": "0",
            "Upload-Length": "10",
            "Tus-Resumable": "1.0.0",
          },
        }),
      // PATCH chunk 1: offset 0..4
      () =>
        new Response(null, {
          status: 204,
          headers: { "Upload-Offset": "4", "Tus-Resumable": "1.0.0" },
        }),
      // PATCH chunk 2: offset 4..8
      () =>
        new Response(null, {
          status: 204,
          headers: { "Upload-Offset": "8", "Tus-Resumable": "1.0.0" },
        }),
      // PATCH chunk 3: offset 8..10 (final → Location + X-Anvil-Content-Hash)
      () =>
        new Response(null, {
          status: 204,
          headers: {
            "Upload-Offset": "10",
            "Tus-Resumable": "1.0.0",
            Location: finalLocation,
            "X-Anvil-Content-Hash": "deadbeef",
          },
        }),
    ]);

    const progress: number[] = [];
    const client = makeClient();
    const result = await client.storage
      .from("videos")
      .uploadResumable("intro.mp4", data, {
        chunkSize: 4,
        contentType: "video/mp4",
        onProgress: (p) => progress.push(p.loaded),
      });

    // Session creation request.
    expect(calls[0]?.url).toBe(
      "http://localhost:7474/storage/v1/upload/resumable",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["tus-resumable"]).toBe("1.0.0");
    expect(calls[0]?.headers["upload-length"]).toBe("10");
    expect(calls[0]?.headers["upload-metadata"]).toContain("bucket ");
    expect(calls[0]?.headers["upload-metadata"]).toContain("path ");
    expect(calls[0]?.headers["upload-metadata"]).toContain("mime ");

    // PATCH calls.
    expect(calls[1]?.url).toBe(
      "http://localhost:7474/storage/v1/upload/resumable/session-id",
    );
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.headers["content-type"]).toBe("application/offset+octet-stream");
    expect(calls[1]?.headers["upload-offset"]).toBe("0");
    expect(calls[1]?.bodyBytes).toEqual(data.subarray(0, 4));
    expect(calls[2]?.headers["upload-offset"]).toBe("4");
    expect(calls[2]?.bodyBytes).toEqual(data.subarray(4, 8));
    expect(calls[3]?.headers["upload-offset"]).toBe("8");
    expect(calls[3]?.bodyBytes).toEqual(data.subarray(8, 10));

    expect(progress).toEqual([4, 8, 10]);
    expect(result.path).toBe("intro.mp4");
    expect(result.bucketId).toBe("videos");
    expect(result.size).toBe(10);
    expect(result.contentHash).toBe("deadbeef");
    expect(result.mimeType).toBe("video/mp4");
    expect(result.sessionUrl).toBe("/storage/v1/upload/resumable/session-id");
  });

  it("resumes from an existing session via HEAD-then-PATCH", async () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const { calls } = installFetch([
      // HEAD: server says offset 4, length 8
      () =>
        new Response(null, {
          status: 200,
          headers: {
            "Upload-Offset": "4",
            "Upload-Length": "8",
            "Tus-Resumable": "1.0.0",
          },
        }),
      // PATCH offset 4..8
      () =>
        new Response(null, {
          status: 204,
          headers: {
            "Upload-Offset": "8",
            "Tus-Resumable": "1.0.0",
            Location: "/storage/v1/object/videos/clip.mp4",
            "X-Anvil-Content-Hash": "cafef00d",
          },
        }),
    ]);
    const client = makeClient();
    const progress: number[] = [];
    const res = await client.storage
      .from("videos")
      .uploadResumable("clip.mp4", data, {
        chunkSize: 8,
        contentType: "video/mp4",
        resumeFrom: "/storage/v1/upload/resumable/existing",
        onProgress: (p) => progress.push(p.loaded),
      });
    expect(calls[0]?.method).toBe("HEAD");
    expect(calls[0]?.url).toBe(
      "http://localhost:7474/storage/v1/upload/resumable/existing",
    );
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.headers["upload-offset"]).toBe("4");
    expect(calls[1]?.bodyBytes).toEqual(data.subarray(4, 8));
    expect(progress).toEqual([8]);
    expect(res.contentHash).toBe("cafef00d");
  });

  it("works with a Blob body and reports progress percent", async () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const blob = new Blob([data], { type: "application/octet-stream" });
    const { calls } = installFetch([
      () =>
        new Response(null, {
          status: 201,
          headers: {
            Location: "/storage/v1/upload/resumable/blob-session",
            "Tus-Resumable": "1.0.0",
          },
        }),
      () =>
        new Response(null, {
          status: 204,
          headers: { "Upload-Offset": "3", "Tus-Resumable": "1.0.0" },
        }),
      () =>
        new Response(null, {
          status: 204,
          headers: {
            "Upload-Offset": "6",
            "Tus-Resumable": "1.0.0",
            "X-Anvil-Content-Hash": "abcd",
          },
        }),
    ]);
    const client = makeClient();
    const percents: number[] = [];
    await client.storage.from("misc").uploadResumable("blob.bin", blob, {
      chunkSize: 3,
      onProgress: (p) => percents.push(p.percent),
    });
    expect(calls[1]?.bodyBytes).toEqual(data.subarray(0, 3));
    expect(calls[2]?.bodyBytes).toEqual(data.subarray(3, 6));
    expect(percents).toEqual([50, 100]);
  });

  it("surfaces server errors during TUS PATCH", async () => {
    const data = new Uint8Array([1, 2]);
    installFetch([
      () =>
        new Response(null, {
          status: 201,
          headers: {
            Location: "/storage/v1/upload/resumable/x",
            "Tus-Resumable": "1.0.0",
          },
        }),
      () => errorResponse(409, "Upload-Offset mismatch"),
    ]);
    const client = makeClient();
    await expect(
      client.storage.from("misc").uploadResumable("x.bin", data, { chunkSize: 2 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// 401 retry inheritance via _rawRequest
// ---------------------------------------------------------------------------

describe("401 refresh retry on storage calls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes the token and replays a failed bucket request", async () => {
    const { calls } = installFetch([
      // login
      () =>
        jsonResponse({
          accessToken: "old",
          refreshToken: "r",
          idToken: "id",
        }),
      // bucket list → 401
      () => errorResponse(401, "token expired"),
      // refresh → 200
      () =>
        jsonResponse({ accessToken: "new", refreshToken: "r2", idToken: "id" }),
      // replay → success
      () =>
        jsonResponse([
          {
            id: "x",
            name: "x",
            public: false,
            file_size_limit: null,
            bucket_size_limit: null,
            allowed_mime_types: [],
            owner: "admin",
            created_at: 1,
            updated_at: 1,
          },
        ]),
    ]);
    const client = new AnvilClient({ baseUrl: "http://localhost:7474" });
    await client.login({ username: "u", password: "p" });
    const { data } = await client.storage.listBuckets();
    expect(calls).toHaveLength(4);
    expect(calls[1]?.headers["authorization"]).toBe("Bearer old");
    expect(calls[3]?.headers["authorization"]).toBe("Bearer new");
    expect(data[0]?.id).toBe("x");
  });
});
