//! File storage namespace (Phase 25.13).
//!
//! Wraps the `/storage/v1/...` REST API exposed by Anvil DB. The surface
//! mirrors the JavaScript SDK and the Supabase Storage client where the
//! signatures overlap, so existing code patterns translate directly.
//!
//! Two layers:
//! - [`Storage`] — bucket-level CRUD + the [`Storage::from`] builder.
//! - [`StorageBucketBuilder`] — object-level operations scoped to one bucket.
//!
//! ```no_run
//! # async fn example() -> anvilent::AnvilResult<()> {
//! use anvilent::AnvilClient;
//!
//! let client = AnvilClient::connect("anvil://admin:secret@localhost:7474/graph").await?;
//! let storage = client.storage();
//!
//! storage.create_bucket("avatars", anvilent::CreateBucketOptions {
//!     public: Some(true),
//!     file_size_limit: Some("5MB".into()),
//!     ..Default::default()
//! }).await?;
//!
//! let bucket = storage.from("avatars");
//! bucket.upload("alice.png", b"\x89PNG...".to_vec(), Default::default()).await?;
//! let blob = bucket.download("alice.png").await?;
//! let url = bucket.get_public_url("alice.png", Default::default());
//! println!("{}", url.public_url);
//! # Ok(())
//! # }
//! ```

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, LOCATION};
use reqwest::{Method, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::AnvilClient;
use crate::error::{AnvilError, AnvilResult};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Bucket settings accepted by [`Storage::create_bucket`].
#[derive(Debug, Clone, Default)]
pub struct CreateBucketOptions {
    /// When true, anonymous GETs against the public download endpoint succeed.
    pub public: Option<bool>,
    /// Max upload size per object. Accepts a byte count or a unit suffix
    /// like `"5MB"` / `"1GiB"`.
    pub file_size_limit: Option<String>,
    /// Cap on total bytes across all objects in this bucket.
    pub bucket_size_limit: Option<String>,
    /// Whitelist of MIME types. Empty means "anything goes".
    pub allowed_mime_types: Option<Vec<String>>,
}

/// Patch passed to [`Storage::update_bucket`]. `None` means "leave unchanged";
/// `Some(SizeLimit::Clear)` clears an existing per-bucket cap.
#[derive(Debug, Clone, Default)]
pub struct UpdateBucketOptions {
    pub public: Option<bool>,
    pub file_size_limit: Option<SizeLimit>,
    pub bucket_size_limit: Option<SizeLimit>,
    pub allowed_mime_types: Option<Vec<String>>,
}

/// Either a concrete size limit or an explicit "remove the existing cap".
#[derive(Debug, Clone)]
pub enum SizeLimit {
    /// A concrete byte count or unit-suffixed string ("5MB", "1GiB").
    Set(String),
    /// Clear the existing limit on the bucket.
    Clear,
}

/// A bucket as returned by `GET /storage/v1/bucket`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Bucket {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub file_size_limit: Option<i64>,
    #[serde(default)]
    pub bucket_size_limit: Option<i64>,
    #[serde(default)]
    pub allowed_mime_types: Vec<String>,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// Options accepted by [`StorageBucketBuilder::upload`].
#[derive(Debug, Clone, Default)]
pub struct UploadOptions {
    /// Overrides the auto-detected MIME type.
    pub content_type: Option<String>,
    /// When true, replaces any existing object at the same path (PUT).
    pub upsert: bool,
    /// Optional `Cache-Control` header set on the upload request.
    pub cache_control: Option<String>,
}

/// Progress payload fired during a resumable upload.
#[derive(Debug, Clone, Copy)]
pub struct UploadProgress {
    pub loaded: u64,
    pub total: u64,
    /// `loaded / total * 100`, rounded to two decimals.
    pub percent: f64,
}

/// Options accepted by [`StorageBucketBuilder::upload_resumable`].
#[derive(Default)]
pub struct ResumableUploadOptions {
    pub content_type: Option<String>,
    /// Bytes per PATCH chunk. Defaults to 5 MiB.
    pub chunk_size: Option<usize>,
    /// Progress callback fired after every successful chunk.
    pub on_progress: Option<Box<dyn Fn(UploadProgress) + Send + Sync>>,
    /// Resume from an existing TUS session URL.
    pub resume_from: Option<String>,
}

impl std::fmt::Debug for ResumableUploadOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResumableUploadOptions")
            .field("content_type", &self.content_type)
            .field("chunk_size", &self.chunk_size)
            .field("on_progress", &self.on_progress.as_ref().map(|_| "<callback>"))
            .field("resume_from", &self.resume_from)
            .finish()
    }
}

/// Common result returned by single-shot and resumable uploads.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UploadResult {
    pub id: String,
    pub bucket_id: String,
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub etag: String,
    pub content_hash: String,
    pub version: u64,
    pub deduped: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Result of [`StorageBucketBuilder::upload_resumable`] — adds the TUS
/// session URL so callers can resume after a failure.
#[derive(Debug, Clone)]
pub struct ResumableUploadResult {
    pub result: UploadResult,
    pub session_url: String,
}

/// Detailed object metadata returned by copy/move endpoints.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ObjectMetadata {
    pub id: String,
    pub bucket_id: String,
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub etag: String,
    pub content_hash: String,
    pub version: u64,
    pub deduped: bool,
    #[serde(default)]
    pub metadata: Value,
    pub owner: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub last_accessed_at: u64,
}

/// Image transformation options.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImageTransform {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resize: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u32>,
}

impl ImageTransform {
    /// True when no transform parameters are set.
    pub fn is_empty(&self) -> bool {
        self.width.is_none()
            && self.height.is_none()
            && self.resize.is_none()
            && self.format.is_none()
            && self.quality.is_none()
    }

    fn to_query(&self) -> String {
        let mut pairs: Vec<(&'static str, String)> = Vec::new();
        if let Some(w) = self.width {
            pairs.push(("width", w.to_string()));
        }
        if let Some(h) = self.height {
            pairs.push(("height", h.to_string()));
        }
        if let Some(ref r) = self.resize {
            pairs.push(("resize", r.clone()));
        }
        if let Some(ref f) = self.format {
            pairs.push(("format", f.clone()));
        }
        if let Some(q) = self.quality {
            pairs.push(("quality", q.to_string()));
        }
        pairs
            .into_iter()
            .map(|(k, v)| format!("{}={}", k, urlencode_segment(&v)))
            .collect::<Vec<_>>()
            .join("&")
    }
}

/// Options accepted by [`StorageBucketBuilder::get_public_url`].
#[derive(Debug, Clone, Default)]
pub struct PublicUrlOptions {
    /// Image transformation parameters; routes via `/render/image/public`.
    pub transform: Option<ImageTransform>,
    /// `Some(true)` adds a `download` flag; `Some(name)` adds `download=name`.
    pub download: Option<Download>,
}

/// `Either::True` for a bare `?download` flag, `Either::Named` for
/// `?download=<filename>`.
#[derive(Debug, Clone)]
pub enum Download {
    Flag,
    Named(String),
}

/// Result of [`StorageBucketBuilder::get_public_url`].
#[derive(Debug, Clone)]
pub struct PublicUrlResult {
    pub public_url: String,
}

/// Options accepted by [`StorageBucketBuilder::create_signed_url`].
#[derive(Debug, Clone, Default)]
pub struct SignedUrlOptions {
    pub transform: Option<ImageTransform>,
    pub download: Option<Download>,
}

/// Result of [`StorageBucketBuilder::create_signed_url`].
#[derive(Debug, Clone)]
pub struct SignedUrlResult {
    pub signed_url: String,
    pub token: String,
    pub expires_at: u64,
    pub expires_in: u64,
}

/// Options accepted by [`StorageBucketBuilder::create_signed_upload_url`].
#[derive(Debug, Clone, Default)]
pub struct SignedUploadUrlOptions {
    /// TTL in seconds. `0` (default) uses the configured server default.
    pub expires_in: u64,
}

/// Result of [`StorageBucketBuilder::create_signed_upload_url`].
#[derive(Debug, Clone)]
pub struct SignedUploadUrlResult {
    pub signed_url: String,
    pub token: String,
    pub expires_at: u64,
    pub expires_in: u64,
}

/// Options accepted by [`StorageBucketBuilder::list`].
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    pub sort_by: Option<SortBy>,
}

#[derive(Debug, Clone)]
pub struct SortBy {
    pub column: String,
    pub order: Option<SortOrder>,
}

#[derive(Debug, Clone, Copy)]
pub enum SortOrder {
    Asc,
    Desc,
}

impl SortOrder {
    fn as_str(self) -> &'static str {
        match self {
            SortOrder::Asc => "asc",
            SortOrder::Desc => "desc",
        }
    }
}

/// A single row from [`StorageBucketBuilder::list`].
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FileObject {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub etag: String,
    pub content_hash: String,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Result of [`StorageBucketBuilder::list`].
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ListResult {
    pub bucket_id: String,
    pub items: Vec<FileObject>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

/// Per-bucket usage row.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BucketUsage {
    pub bucket_id: String,
    pub object_count: u64,
    pub total_bytes: u64,
    #[serde(default)]
    pub bucket_size_limit: Option<i64>,
}

/// Per-user usage row.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UserUsage {
    pub owner: String,
    pub object_count: u64,
    pub total_bytes: u64,
}

/// Result of [`Storage::usage`].
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UsageReport {
    pub object_count: u64,
    pub total_bytes: u64,
    pub buckets: Vec<BucketUsage>,
    #[serde(default)]
    pub users: Vec<UserUsage>,
    #[serde(default)]
    pub max_total_storage: Option<u64>,
}

// ---------------------------------------------------------------------------
// Storage namespace
// ---------------------------------------------------------------------------

const STORAGE_PREFIX: &str = "/storage/v1";

/// File storage namespace — obtain via [`AnvilClient::storage`].
#[derive(Clone)]
pub struct Storage {
    pub(crate) client: AnvilClient,
}

impl Storage {
    /// Scope subsequent calls to a single bucket.
    pub fn from(&self, bucket: impl Into<String>) -> StorageBucketBuilder {
        StorageBucketBuilder {
            client: self.client.clone(),
            bucket: bucket.into(),
        }
    }

    /// Create a new bucket.
    pub async fn create_bucket(
        &self,
        id: impl Into<String>,
        options: CreateBucketOptions,
    ) -> AnvilResult<Bucket> {
        let mut body = serde_json::Map::new();
        body.insert("id".into(), Value::String(id.into()));
        if let Some(pub_flag) = options.public {
            body.insert("public".into(), Value::Bool(pub_flag));
        }
        if let Some(limit) = options.file_size_limit {
            body.insert(
                "file_size_limit".into(),
                Value::Number(parse_byte_size(&limit)?.into()),
            );
        }
        if let Some(limit) = options.bucket_size_limit {
            body.insert(
                "bucket_size_limit".into(),
                Value::Number(parse_byte_size(&limit)?.into()),
            );
        }
        if let Some(mimes) = options.allowed_mime_types {
            body.insert(
                "allowed_mime_types".into(),
                Value::Array(mimes.into_iter().map(Value::String).collect()),
            );
        }

        let resp = self
            .client
            .send_json(
                Method::POST,
                &format!("{STORAGE_PREFIX}/bucket"),
                Some(Value::Object(body)),
                None,
            )
            .await?;
        json_or_error(resp).await
    }

    /// List all buckets visible to the caller.
    pub async fn list_buckets(&self) -> AnvilResult<Vec<Bucket>> {
        let resp = self
            .client
            .send_json(Method::GET, &format!("{STORAGE_PREFIX}/bucket"), None, None)
            .await?;
        json_or_error(resp).await
    }

    /// Fetch a single bucket by id.
    pub async fn get_bucket(&self, id: &str) -> AnvilResult<Bucket> {
        let resp = self
            .client
            .send_json(
                Method::GET,
                &format!("{STORAGE_PREFIX}/bucket/{}", encode_segment(id)),
                None,
                None,
            )
            .await?;
        json_or_error(resp).await
    }

    /// Update bucket settings.
    pub async fn update_bucket(
        &self,
        id: &str,
        options: UpdateBucketOptions,
    ) -> AnvilResult<Bucket> {
        let mut body = serde_json::Map::new();
        if let Some(pub_flag) = options.public {
            body.insert("public".into(), Value::Bool(pub_flag));
        }
        if let Some(limit) = options.file_size_limit {
            body.insert("file_size_limit".into(), size_limit_to_json(limit)?);
        }
        if let Some(limit) = options.bucket_size_limit {
            body.insert("bucket_size_limit".into(), size_limit_to_json(limit)?);
        }
        if let Some(mimes) = options.allowed_mime_types {
            body.insert(
                "allowed_mime_types".into(),
                Value::Array(mimes.into_iter().map(Value::String).collect()),
            );
        }
        let resp = self
            .client
            .send_json(
                Method::PUT,
                &format!("{STORAGE_PREFIX}/bucket/{}", encode_segment(id)),
                Some(Value::Object(body)),
                None,
            )
            .await?;
        json_or_error(resp).await
    }

    /// Delete a bucket. It must be empty — use [`empty_bucket`](Self::empty_bucket) first.
    pub async fn delete_bucket(&self, id: &str) -> AnvilResult<()> {
        let resp = self
            .client
            .send_json(
                Method::DELETE,
                &format!("{STORAGE_PREFIX}/bucket/{}", encode_segment(id)),
                None,
                None,
            )
            .await?;
        empty_or_error(resp).await
    }

    /// Delete every object in a bucket without removing the bucket itself.
    pub async fn empty_bucket(&self, id: &str) -> AnvilResult<()> {
        let resp = self
            .client
            .send_json(
                Method::POST,
                &format!("{STORAGE_PREFIX}/bucket/{}/empty", encode_segment(id)),
                None,
                None,
            )
            .await?;
        empty_or_error(resp).await
    }

    /// Revoke every signed URL ever issued for a bucket.
    pub async fn revoke_signed_urls(&self, id: &str) -> AnvilResult<()> {
        let resp = self
            .client
            .send_json(
                Method::POST,
                &format!("{STORAGE_PREFIX}/bucket/{}/sign-revoke", encode_segment(id)),
                None,
                None,
            )
            .await?;
        empty_or_error(resp).await
    }

    /// Aggregate storage usage across buckets and per-user totals.
    pub async fn usage(&self) -> AnvilResult<UsageReport> {
        let resp = self
            .client
            .send_json(Method::GET, &format!("{STORAGE_PREFIX}/usage"), None, None)
            .await?;
        json_or_error(resp).await
    }
}

// ---------------------------------------------------------------------------
// Per-bucket builder
// ---------------------------------------------------------------------------

/// Per-bucket operations: upload, download, signed URLs, list, move, copy,
/// remove. Obtain via [`Storage::from`].
#[derive(Clone)]
pub struct StorageBucketBuilder {
    pub(crate) client: AnvilClient,
    pub bucket: String,
}

impl StorageBucketBuilder {
    fn object_path(&self, path: &str) -> String {
        format!(
            "{STORAGE_PREFIX}/object/{}/{}",
            encode_segment(&self.bucket),
            encode_path(path)
        )
    }

    /// Upload a small file in a single request. For files larger than a
    /// few megabytes prefer [`upload_resumable`](Self::upload_resumable).
    pub async fn upload(
        &self,
        path: &str,
        body: impl Into<Vec<u8>>,
        options: UploadOptions,
    ) -> AnvilResult<UploadResult> {
        let bytes = body.into();
        let mime = options
            .content_type
            .clone()
            .or_else(|| infer_content_type(path))
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, header_value(&mime)?);
        if let Some(cache) = options.cache_control {
            headers.insert(
                HeaderName::from_static("cache-control"),
                header_value(&cache)?,
            );
        }
        let method = if options.upsert {
            Method::PUT
        } else {
            Method::POST
        };
        let resp = self
            .client
            .send_bytes(method, &self.object_path(path), bytes, Some(headers))
            .await?;
        json_or_error(resp).await
    }

    /// Upload a file using the TUS 1.0.0 resumable protocol.
    pub async fn upload_resumable(
        &self,
        path: &str,
        body: impl Into<Vec<u8>>,
        options: ResumableUploadOptions,
    ) -> AnvilResult<ResumableUploadResult> {
        let bytes = body.into();
        let total = bytes.len() as u64;
        let chunk_size = options.chunk_size.unwrap_or(5 * 1024 * 1024);
        if chunk_size == 0 {
            return Err(AnvilError::AuthFailed("chunk_size must be > 0".into()));
        }
        let mime = options
            .content_type
            .clone()
            .or_else(|| infer_content_type(path))
            .unwrap_or_else(|| "application/octet-stream".to_string());

        let (session_url, mut offset) = match options.resume_from {
            Some(url) => {
                let off = self.tus_head_offset(&url).await?;
                (url, off)
            }
            None => {
                let url = self.tus_create(path, total, &mime).await?;
                (url, 0u64)
            }
        };

        let mut last_response: Option<Response> = None;
        while offset < total {
            let end = (offset + chunk_size as u64).min(total);
            let chunk = bytes[offset as usize..end as usize].to_vec();
            let (new_offset, resp) = self.tus_patch(&session_url, offset, chunk).await?;
            offset = new_offset;
            if let Some(cb) = options.on_progress.as_ref() {
                cb(UploadProgress {
                    loaded: offset,
                    total,
                    percent: if total == 0 {
                        100.0
                    } else {
                        ((offset as f64 / total as f64) * 10_000.0).round() / 100.0
                    },
                });
            }
            last_response = Some(resp);
        }

        let content_hash = last_response
            .as_ref()
            .and_then(|r| r.headers().get("x-anvil-content-hash"))
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let etag = if content_hash.is_empty() {
            String::new()
        } else {
            format!("W/\"{}\"", content_hash)
        };
        let result = UploadResult {
            id: String::new(),
            bucket_id: self.bucket.clone(),
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            mime_type: mime,
            size: total,
            etag,
            content_hash,
            version: 0,
            deduped: false,
            created_at: 0,
            updated_at: 0,
        };
        Ok(ResumableUploadResult {
            result,
            session_url,
        })
    }

    async fn tus_create(&self, path: &str, length: u64, mime: &str) -> AnvilResult<String> {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("tus-resumable"),
            HeaderValue::from_static("1.0.0"),
        );
        headers.insert(
            HeaderName::from_static("upload-length"),
            header_value(&length.to_string())?,
        );
        let metadata = encode_upload_metadata(&[
            ("bucket", &self.bucket),
            ("path", path),
            ("mime", mime),
        ]);
        headers.insert(
            HeaderName::from_static("upload-metadata"),
            header_value(&metadata)?,
        );
        let resp = self
            .client
            .send_bytes(
                Method::POST,
                &format!("{STORAGE_PREFIX}/upload/resumable"),
                Vec::new(),
                Some(headers),
            )
            .await?;
        if resp.status() != StatusCode::CREATED {
            return Err(response_to_error(resp).await);
        }
        let location = resp
            .headers()
            .get(LOCATION)
            .ok_or_else(|| {
                AnvilError::Server {
                    status: 0,
                    message: "TUS server did not return a Location header".into(),
                }
            })?
            .to_str()
            .map_err(|_| AnvilError::Server {
                status: 0,
                message: "non-ASCII Location header".into(),
            })?
            .to_string();
        Ok(location)
    }

    async fn tus_head_offset(&self, session_url: &str) -> AnvilResult<u64> {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("tus-resumable"),
            HeaderValue::from_static("1.0.0"),
        );
        let resp = self
            .client
            .send_bytes(Method::HEAD, session_url, Vec::new(), Some(headers))
            .await?;
        if !resp.status().is_success() {
            return Err(response_to_error(resp).await);
        }
        let off = resp
            .headers()
            .get("upload-offset")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(|| AnvilError::Server {
                status: 0,
                message: "TUS HEAD returned no Upload-Offset header".into(),
            })?;
        Ok(off)
    }

    async fn tus_patch(
        &self,
        session_url: &str,
        offset: u64,
        chunk: Vec<u8>,
    ) -> AnvilResult<(u64, Response)> {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("tus-resumable"),
            HeaderValue::from_static("1.0.0"),
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/offset+octet-stream"));
        headers.insert(
            HeaderName::from_static("upload-offset"),
            header_value(&offset.to_string())?,
        );
        let resp = self
            .client
            .send_bytes(Method::PATCH, session_url, chunk, Some(headers))
            .await?;
        if !resp.status().is_success() {
            return Err(response_to_error(resp).await);
        }
        let new_offset = resp
            .headers()
            .get("upload-offset")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(|| AnvilError::Server {
                status: 0,
                message: "TUS PATCH returned no Upload-Offset header".into(),
            })?;
        Ok((new_offset, resp))
    }

    /// Download an object as a byte vector. For very large files prefer
    /// [`download_stream`](Self::download_stream) so bytes don't have to be
    /// buffered in memory.
    pub async fn download(&self, path: &str) -> AnvilResult<Vec<u8>> {
        let resp = self
            .client
            .send_bytes(Method::GET, &self.object_path(path), Vec::new(), None)
            .await?;
        if !resp.status().is_success() {
            return Err(response_to_error(resp).await);
        }
        let bytes = resp.bytes().await.map_err(AnvilError::Http)?;
        Ok(bytes.to_vec())
    }

    /// Download an object as a streaming `Response` so callers can consume
    /// chunks without buffering the full body.
    pub async fn download_stream(&self, path: &str) -> AnvilResult<Response> {
        let resp = self
            .client
            .send_bytes(Method::GET, &self.object_path(path), Vec::new(), None)
            .await?;
        if !resp.status().is_success() {
            return Err(response_to_error(resp).await);
        }
        Ok(resp)
    }

    /// Build a public URL for an object. The bucket must be public.
    pub fn get_public_url(&self, path: &str, options: PublicUrlOptions) -> PublicUrlResult {
        let encoded = format!(
            "{}/{}",
            encode_segment(&self.bucket),
            encode_path(path)
        );
        let route = if options.transform.is_some() {
            format!("{STORAGE_PREFIX}/render/image/public/{encoded}")
        } else {
            format!("{STORAGE_PREFIX}/object/public/{encoded}")
        };
        let qs = options
            .transform
            .as_ref()
            .map(|t| t.to_query())
            .unwrap_or_default();
        let mut url = format!("{}{}", self.client.base_url(), route);
        if !qs.is_empty() {
            url.push('?');
            url.push_str(&qs);
        }
        if let Some(dl) = options.download {
            let prefix = if qs.is_empty() { "?" } else { "&" };
            match dl {
                Download::Flag => {
                    url.push_str(prefix);
                    url.push_str("download");
                }
                Download::Named(name) => {
                    url.push_str(prefix);
                    url.push_str("download=");
                    url.push_str(&urlencode_segment(&name));
                }
            }
        }
        PublicUrlResult { public_url: url }
    }

    /// Mint a signed download URL.
    pub async fn create_signed_url(
        &self,
        path: &str,
        expires_in: u64,
        options: SignedUrlOptions,
    ) -> AnvilResult<SignedUrlResult> {
        let use_render = options.transform.is_some();
        let route = if use_render {
            format!(
                "{STORAGE_PREFIX}/render/image/sign/{}/{}",
                encode_segment(&self.bucket),
                encode_path(path)
            )
        } else {
            format!(
                "{STORAGE_PREFIX}/object/sign/{}/{}",
                encode_segment(&self.bucket),
                encode_path(path)
            )
        };
        let mut body = serde_json::Map::new();
        body.insert("expires_in".into(), Value::Number(expires_in.into()));
        if let Some(transform) = options.transform {
            body.insert(
                "transform".into(),
                serde_json::to_value(&transform).map_err(AnvilError::Json)?,
            );
        }
        let resp = self
            .client
            .send_json(Method::POST, &route, Some(Value::Object(body)), None)
            .await?;
        let raw: SignResponseRaw = json_or_error(resp).await?;
        let mut signed_url = format!("{}{}", self.client.base_url(), raw.url);
        if let Some(dl) = options.download {
            match dl {
                Download::Flag => signed_url.push_str("?download"),
                Download::Named(name) => {
                    signed_url.push_str("?download=");
                    signed_url.push_str(&urlencode_segment(&name));
                }
            }
        }
        Ok(SignedUrlResult {
            signed_url,
            token: raw.token,
            expires_at: raw.expires_at,
            expires_in: raw.expires_in,
        })
    }

    /// Mint a signed upload URL.
    pub async fn create_signed_upload_url(
        &self,
        path: &str,
        options: SignedUploadUrlOptions,
    ) -> AnvilResult<SignedUploadUrlResult> {
        let route = format!(
            "{STORAGE_PREFIX}/object/upload/sign/{}/{}",
            encode_segment(&self.bucket),
            encode_path(path)
        );
        let body = serde_json::json!({ "expires_in": options.expires_in });
        let resp = self
            .client
            .send_json(Method::POST, &route, Some(body), None)
            .await?;
        let raw: SignResponseRaw = json_or_error(resp).await?;
        Ok(SignedUploadUrlResult {
            signed_url: format!("{}{}", self.client.base_url(), raw.url),
            token: raw.token,
            expires_at: raw.expires_at,
            expires_in: raw.expires_in,
        })
    }

    /// List objects in the bucket.
    pub async fn list(&self, prefix: Option<&str>, options: ListOptions) -> AnvilResult<ListResult> {
        let route = format!(
            "{STORAGE_PREFIX}/object/list/{}",
            encode_segment(&self.bucket)
        );
        let mut body = serde_json::Map::new();
        if let Some(p) = prefix {
            if !p.is_empty() {
                body.insert("prefix".into(), Value::String(p.to_string()));
            }
        }
        if let Some(l) = options.limit {
            body.insert("limit".into(), Value::Number(l.into()));
        }
        if let Some(off) = options.offset {
            body.insert("offset".into(), Value::Number(off.into()));
        }
        if let Some(sort) = options.sort_by {
            body.insert("sort_by".into(), Value::String(sort.column));
            if let Some(order) = sort.order {
                body.insert("order".into(), Value::String(order.as_str().into()));
            }
        }
        let resp = self
            .client
            .send_json(Method::POST, &route, Some(Value::Object(body)), None)
            .await?;
        json_or_error(resp).await
    }

    /// Move (rename) an object within the bucket.
    pub async fn move_object(&self, from: &str, to: &str) -> AnvilResult<ObjectMetadata> {
        self.move_or_copy("move", from, to).await
    }

    /// Copy an object within the bucket.
    pub async fn copy(&self, from: &str, to: &str) -> AnvilResult<ObjectMetadata> {
        self.move_or_copy("copy", from, to).await
    }

    async fn move_or_copy(
        &self,
        op: &str,
        from: &str,
        to: &str,
    ) -> AnvilResult<ObjectMetadata> {
        let body = serde_json::json!({
            "source_bucket": self.bucket,
            "source_path": from,
            "dest_bucket": self.bucket,
            "dest_path": to,
        });
        let resp = self
            .client
            .send_json(
                Method::POST,
                &format!("{STORAGE_PREFIX}/object/{op}"),
                Some(body),
                None,
            )
            .await?;
        json_or_error(resp).await
    }

    /// Remove one or more objects from the bucket. Returns the paths the
    /// server confirmed as deleted (missing paths are skipped).
    pub async fn remove(&self, paths: &[impl AsRef<str>]) -> AnvilResult<Vec<String>> {
        let mut deleted = Vec::with_capacity(paths.len());
        for p in paths {
            let path = p.as_ref();
            let resp = self
                .client
                .send_json(Method::DELETE, &self.object_path(path), None, None)
                .await?;
            if resp.status() == StatusCode::NOT_FOUND {
                continue;
            }
            if !resp.status().is_success() {
                return Err(response_to_error(resp).await);
            }
            deleted.push(path.to_string());
        }
        Ok(deleted)
    }

    /// True iff an object exists at the given path.
    pub async fn exists(&self, path: &str) -> AnvilResult<bool> {
        let resp = self
            .client
            .send_bytes(Method::HEAD, &self.object_path(path), Vec::new(), None)
            .await?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(false),
            s if s.is_success() => Ok(true),
            _ => Err(response_to_error(resp).await),
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SignResponseRaw {
    token: String,
    url: String,
    expires_at: u64,
    expires_in: u64,
}

fn size_limit_to_json(limit: SizeLimit) -> AnvilResult<Value> {
    match limit {
        SizeLimit::Set(s) => Ok(Value::Number(parse_byte_size(&s)?.into())),
        SizeLimit::Clear => Ok(Value::Null),
    }
}

/// Parse a byte-size hint like `"5MB"` / `"1GiB"` into an integer.
pub fn parse_byte_size(value: &str) -> AnvilResult<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AnvilError::AuthFailed("empty byte-size string".into()));
    }
    let upper = trimmed.to_uppercase();
    let units: &[(&str, i64)] = &[
        ("TIB", 1024 * 1024 * 1024 * 1024),
        ("GIB", 1024 * 1024 * 1024),
        ("MIB", 1024 * 1024),
        ("KIB", 1024),
        ("TB", 1_000_000_000_000),
        ("GB", 1_000_000_000),
        ("MB", 1_000_000),
        ("KB", 1_000),
        ("B", 1),
    ];
    for (suffix, mult) in units {
        if let Some(stripped) = upper.strip_suffix(suffix) {
            let n: f64 = stripped
                .trim()
                .parse()
                .map_err(|_| AnvilError::AuthFailed(format!("invalid byte size: {value}")))?;
            if n < 0.0 {
                return Err(AnvilError::AuthFailed(format!(
                    "invalid byte size: {value}"
                )));
            }
            return Ok((n * (*mult as f64)) as i64);
        }
    }
    // Bare digits — reject anything that wouldn't parse as a non-negative
    // integer (negative numbers, decimals without unit, etc.).
    let n = upper
        .parse::<i64>()
        .map_err(|_| AnvilError::AuthFailed(format!("invalid byte size: {value}")))?;
    if n < 0 {
        return Err(AnvilError::AuthFailed(format!(
            "invalid byte size: {value}"
        )));
    }
    Ok(n)
}

/// Percent-encode a single path segment so all reserved chars become safe.
pub fn encode_segment(s: &str) -> String {
    urlencode_segment(s)
}

/// Percent-encode each `/`-separated segment independently, preserving the
/// literal slashes.
pub fn encode_path(p: &str) -> String {
    p.split('/').map(urlencode_segment).collect::<Vec<_>>().join("/")
}

fn urlencode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

/// Encode a TUS `Upload-Metadata` header: each value is base64-UTF-8 and
/// pairs are joined with commas.
pub fn encode_upload_metadata(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{} {}", k, base64_utf8(v)))
        .collect::<Vec<_>>()
        .join(",")
}

fn base64_utf8(s: &str) -> String {
    // Hand-roll a tiny base64 encoder so we don't pull in another dep.
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = (bytes[i] as u32) << 16 | (bytes[i + 1] as u32) << 8 | (bytes[i + 2] as u32);
        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3F) as usize] as char);
        out.push(ALPHA[(n & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = (bytes[i] as u32) << 16 | (bytes[i + 1] as u32) << 8;
        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3F) as usize] as char);
        out.push('=');
    }
    out
}

/// Guess a MIME type from a file extension. Returns `None` when nothing
/// could be inferred.
pub fn infer_content_type(path: &str) -> Option<String> {
    let lowered = path.to_ascii_lowercase();
    let ext = lowered.rsplit('.').next()?;
    Some(
        match ext {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            "pdf" => "application/pdf",
            "txt" => "text/plain",
            "json" => "application/json",
            "js" => "application/javascript",
            "css" => "text/css",
            "html" | "htm" => "text/html",
            "csv" => "text/csv",
            "md" => "text/markdown",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "zip" => "application/zip",
            _ => return None,
        }
        .to_string(),
    )
}

fn header_value(s: &str) -> AnvilResult<HeaderValue> {
    HeaderValue::from_str(s).map_err(|_| AnvilError::Server {
        status: 0,
        message: format!("invalid header value: {s}"),
    })
}

async fn json_or_error<T: serde::de::DeserializeOwned>(resp: Response) -> AnvilResult<T> {
    if resp.status().is_success() {
        resp.json::<T>().await.map_err(AnvilError::Http)
    } else {
        Err(response_to_error(resp).await)
    }
}

async fn empty_or_error(resp: Response) -> AnvilResult<()> {
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(response_to_error(resp).await)
    }
}

async fn response_to_error(resp: Response) -> AnvilError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let message = match serde_json::from_str::<Value>(&body) {
        Ok(v) => v
            .get("error")
            .and_then(|e| e.as_str())
            .map(|s| s.to_string())
            .unwrap_or(body),
        Err(_) => body,
    };
    AnvilError::Server { status, message }
}

// ---------------------------------------------------------------------------
// Unit tests (pure helpers)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_byte_size_handles_bare_numbers() {
        assert_eq!(parse_byte_size("0").unwrap(), 0);
        assert_eq!(parse_byte_size("1024").unwrap(), 1024);
    }

    #[test]
    fn parse_byte_size_handles_si_units() {
        assert_eq!(parse_byte_size("5MB").unwrap(), 5_000_000);
        assert_eq!(parse_byte_size("1GB").unwrap(), 1_000_000_000);
        assert_eq!(parse_byte_size("250 KB").unwrap(), 250_000);
    }

    #[test]
    fn parse_byte_size_handles_iec_units() {
        assert_eq!(parse_byte_size("5MiB").unwrap(), 5 * 1024 * 1024);
        assert_eq!(parse_byte_size("1GiB").unwrap(), 1024 * 1024 * 1024);
    }

    #[test]
    fn parse_byte_size_rejects_garbage() {
        assert!(parse_byte_size("").is_err());
        assert!(parse_byte_size("nope").is_err());
        assert!(parse_byte_size("-1").is_err());
    }

    #[test]
    fn encode_path_preserves_slashes() {
        assert_eq!(
            encode_path("users/alice/photo.png"),
            "users/alice/photo.png"
        );
        assert_eq!(
            encode_path("users/with space/file?.png"),
            "users/with%20space/file%3F.png"
        );
    }

    #[test]
    fn encode_upload_metadata_matches_tus_spec() {
        let s = encode_upload_metadata(&[("bucket", "avatars"), ("path", "alice.png")]);
        assert_eq!(s, "bucket YXZhdGFycw==,path YWxpY2UucG5n");
    }

    #[test]
    fn infer_content_type_known_extensions() {
        assert_eq!(infer_content_type("alice.png").as_deref(), Some("image/png"));
        assert_eq!(infer_content_type("clip.MP4").as_deref(), Some("video/mp4"));
        assert!(infer_content_type("no-extension").is_none());
    }

    #[test]
    fn transform_to_query_serializes_known_fields() {
        let t = ImageTransform {
            width: Some(200),
            height: Some(200),
            resize: Some("cover".into()),
            format: Some("webp".into()),
            quality: None,
        };
        let q = t.to_query();
        assert!(q.contains("width=200"));
        assert!(q.contains("height=200"));
        assert!(q.contains("resize=cover"));
        assert!(q.contains("format=webp"));
        assert!(!q.contains("quality="));
    }
}
