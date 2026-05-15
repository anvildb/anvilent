package anvilent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// File storage namespace (Phase 25.13)
// ---------------------------------------------------------------------------
//
// Wraps the /storage/v1/... REST API. The surface mirrors the Supabase
// Storage SDK and the TypeScript / Python / Rust drivers where the
// signatures overlap.
//
// Two layers:
//   - Storage              -- bucket-level CRUD + From(bucket) builder.
//   - StorageBucketBuilder -- object-level operations scoped to one bucket.

const storagePrefix = "/storage/v1"

// Storage is the file storage namespace. Obtain via Client.Storage().
type Storage struct {
	client *Client
}

// Storage returns the file storage namespace.
func (c *Client) Storage() *Storage {
	return &Storage{client: c}
}

// From scopes subsequent calls to a single bucket.
func (s *Storage) From(bucket string) *StorageBucketBuilder {
	return &StorageBucketBuilder{client: s.client, Bucket: bucket}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Bucket is a storage bucket as returned by GET /storage/v1/bucket.
type Bucket struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Public           bool     `json:"public"`
	FileSizeLimit    *int64   `json:"file_size_limit"`
	BucketSizeLimit  *int64   `json:"bucket_size_limit"`
	AllowedMimeTypes []string `json:"allowed_mime_types"`
	Owner            string   `json:"owner"`
	CreatedAt        uint64   `json:"created_at"`
	UpdatedAt        uint64   `json:"updated_at"`
}

// CreateBucketOptions configures Storage.CreateBucket.
type CreateBucketOptions struct {
	Public           bool
	FileSizeLimit    string // "5MB" / "1GiB" / bare number; "" = no limit.
	BucketSizeLimit  string
	AllowedMimeTypes []string
}

// UpdateBucketOptions configures Storage.UpdateBucket.
//
// Unset pointers leave the corresponding field unchanged.
// A pointer to an empty string clears the limit (sets it to NULL).
type UpdateBucketOptions struct {
	Public           *bool
	FileSizeLimit    *string
	BucketSizeLimit  *string
	AllowedMimeTypes []string
}

// UploadOptions configures StorageBucketBuilder.Upload.
type UploadOptions struct {
	ContentType  string
	Upsert       bool
	CacheControl string
}

// UploadProgress is fired during a resumable upload.
type UploadProgress struct {
	Loaded  uint64
	Total   uint64
	Percent float64
}

// ResumableUploadOptions configures StorageBucketBuilder.UploadResumable.
type ResumableUploadOptions struct {
	ContentType string
	ChunkSize   int                       // 0 -> default 5 MiB.
	OnProgress  func(UploadProgress)      // optional
	ResumeFrom  string                    // existing TUS session URL
}

// UploadResult is returned by single-shot and resumable uploads.
type UploadResult struct {
	ID          string `json:"id"`
	BucketID    string `json:"bucket_id"`
	Path        string `json:"path"`
	Name        string `json:"name"`
	MimeType    string `json:"mime_type"`
	Size        uint64 `json:"size"`
	ETag        string `json:"etag"`
	ContentHash string `json:"content_hash"`
	Version     uint64 `json:"version"`
	Deduped     bool   `json:"deduped"`
	CreatedAt   uint64 `json:"created_at"`
	UpdatedAt   uint64 `json:"updated_at"`
}

// ResumableUploadResult is returned by UploadResumable. Adds the TUS session
// URL so callers can resume after a failure.
type ResumableUploadResult struct {
	UploadResult
	SessionURL string
}

// ObjectMetadata is returned by copy/move endpoints. Strictly a superset of
// UploadResult with extra audit fields.
type ObjectMetadata struct {
	UploadResult
	Metadata       map[string]any `json:"metadata"`
	Owner          string         `json:"owner"`
	LastAccessedAt uint64         `json:"last_accessed_at"`
}

// ImageTransform configures image transformation parameters for public /
// signed URLs.
type ImageTransform struct {
	Width   *uint32 `json:"width,omitempty"`
	Height  *uint32 `json:"height,omitempty"`
	Resize  string  `json:"resize,omitempty"` // "cover" | "contain" | "fill"
	Format  string  `json:"format,omitempty"` // "webp" | "jpeg" | "png" | "avif"
	Quality *uint32 `json:"quality,omitempty"`
}

// IsEmpty reports whether any transform parameter is set.
func (t *ImageTransform) IsEmpty() bool {
	return t == nil ||
		(t.Width == nil && t.Height == nil && t.Resize == "" && t.Format == "" && t.Quality == nil)
}

func (t *ImageTransform) toQuery() string {
	if t == nil {
		return ""
	}
	pairs := make([]string, 0, 5)
	if t.Width != nil {
		pairs = append(pairs, fmt.Sprintf("width=%d", *t.Width))
	}
	if t.Height != nil {
		pairs = append(pairs, fmt.Sprintf("height=%d", *t.Height))
	}
	if t.Resize != "" {
		pairs = append(pairs, "resize="+url.QueryEscape(t.Resize))
	}
	if t.Format != "" {
		pairs = append(pairs, "format="+url.QueryEscape(t.Format))
	}
	if t.Quality != nil {
		pairs = append(pairs, fmt.Sprintf("quality=%d", *t.Quality))
	}
	return strings.Join(pairs, "&")
}

// Download forces the server to return Content-Disposition: attachment.
//
// Filename == "" means a bare `?download` flag; otherwise `?download=<name>`.
type Download struct {
	Filename string
}

// PublicURLOptions configures StorageBucketBuilder.GetPublicURL.
type PublicURLOptions struct {
	Transform *ImageTransform
	Download  *Download
}

// PublicURLResult is returned by GetPublicURL.
type PublicURLResult struct {
	PublicURL string
}

// SignedURLOptions configures StorageBucketBuilder.CreateSignedURL.
type SignedURLOptions struct {
	Transform *ImageTransform
	Download  *Download
}

// SignedURLResult is returned by CreateSignedURL.
type SignedURLResult struct {
	SignedURL string `json:"signed_url"`
	Token     string `json:"token"`
	ExpiresAt uint64 `json:"expires_at"`
	ExpiresIn uint64 `json:"expires_in"`
}

// SignedUploadURLOptions configures CreateSignedUploadURL.
type SignedUploadURLOptions struct {
	// ExpiresIn is the TTL in seconds. 0 (default) uses the server default.
	ExpiresIn uint64
}

// SignedUploadURLResult is returned by CreateSignedUploadURL.
type SignedUploadURLResult struct {
	SignedURL string
	Token     string
	ExpiresAt uint64
	ExpiresIn uint64
}

// SortBy describes a sort key + direction for List.
type SortBy struct {
	Column string // "name" | "size" | "created_at" | "updated_at"
	Order  string // "asc" | "desc"
}

// ListOptions configures StorageBucketBuilder.List.
type ListOptions struct {
	Limit  int
	Offset int
	SortBy *SortBy
}

// FileObject is a single row from List.
type FileObject struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Size        uint64 `json:"size"`
	MimeType    string `json:"mime_type"`
	ETag        string `json:"etag"`
	ContentHash string `json:"content_hash"`
	CreatedAt   uint64 `json:"created_at"`
	UpdatedAt   uint64 `json:"updated_at"`
}

// ListResult is returned by List.
type ListResult struct {
	BucketID string       `json:"bucket_id"`
	Items    []FileObject `json:"items"`
	Total    uint64       `json:"total"`
	Limit    uint64       `json:"limit"`
	Offset   uint64       `json:"offset"`
}

// BucketUsage is a single per-bucket usage row.
type BucketUsage struct {
	BucketID        string `json:"bucket_id"`
	ObjectCount     uint64 `json:"object_count"`
	TotalBytes      uint64 `json:"total_bytes"`
	BucketSizeLimit *int64 `json:"bucket_size_limit,omitempty"`
}

// UserUsage is a single per-user usage row.
type UserUsage struct {
	Owner       string `json:"owner"`
	ObjectCount uint64 `json:"object_count"`
	TotalBytes  uint64 `json:"total_bytes"`
}

// UsageReport is returned by Storage.Usage.
type UsageReport struct {
	ObjectCount     uint64        `json:"object_count"`
	TotalBytes      uint64        `json:"total_bytes"`
	Buckets         []BucketUsage `json:"buckets"`
	Users           []UserUsage   `json:"users"`
	MaxTotalStorage *uint64       `json:"max_total_storage,omitempty"`
}

// ---------------------------------------------------------------------------
// Storage namespace methods
// ---------------------------------------------------------------------------

// CreateBucket creates a new bucket.
func (s *Storage) CreateBucket(ctx context.Context, id string, opts CreateBucketOptions) (*Bucket, error) {
	body := map[string]any{"id": id, "public": opts.Public}
	if opts.FileSizeLimit != "" {
		size, err := ParseByteSize(opts.FileSizeLimit)
		if err != nil {
			return nil, err
		}
		body["file_size_limit"] = size
	}
	if opts.BucketSizeLimit != "" {
		size, err := ParseByteSize(opts.BucketSizeLimit)
		if err != nil {
			return nil, err
		}
		body["bucket_size_limit"] = size
	}
	if opts.AllowedMimeTypes != nil {
		body["allowed_mime_types"] = opts.AllowedMimeTypes
	}
	var out Bucket
	if err := s.client.storageJSON(ctx, http.MethodPost, storagePrefix+"/bucket", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListBuckets returns every bucket visible to the caller.
func (s *Storage) ListBuckets(ctx context.Context) ([]Bucket, error) {
	var out []Bucket
	if err := s.client.storageJSON(ctx, http.MethodGet, storagePrefix+"/bucket", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetBucket fetches a single bucket by id.
func (s *Storage) GetBucket(ctx context.Context, id string) (*Bucket, error) {
	var out Bucket
	if err := s.client.storageJSON(
		ctx, http.MethodGet, storagePrefix+"/bucket/"+url.PathEscape(id), nil, &out,
	); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateBucket updates bucket settings.
//
// To explicitly clear FileSizeLimit / BucketSizeLimit, pass a pointer to "":
//
//	clear := ""
//	storage.UpdateBucket(ctx, "avatars", UpdateBucketOptions{FileSizeLimit: &clear})
func (s *Storage) UpdateBucket(ctx context.Context, id string, opts UpdateBucketOptions) (*Bucket, error) {
	body := map[string]any{}
	if opts.Public != nil {
		body["public"] = *opts.Public
	}
	if opts.FileSizeLimit != nil {
		if *opts.FileSizeLimit == "" {
			body["file_size_limit"] = nil
		} else {
			size, err := ParseByteSize(*opts.FileSizeLimit)
			if err != nil {
				return nil, err
			}
			body["file_size_limit"] = size
		}
	}
	if opts.BucketSizeLimit != nil {
		if *opts.BucketSizeLimit == "" {
			body["bucket_size_limit"] = nil
		} else {
			size, err := ParseByteSize(*opts.BucketSizeLimit)
			if err != nil {
				return nil, err
			}
			body["bucket_size_limit"] = size
		}
	}
	if opts.AllowedMimeTypes != nil {
		body["allowed_mime_types"] = opts.AllowedMimeTypes
	}
	var out Bucket
	if err := s.client.storageJSON(
		ctx, http.MethodPut, storagePrefix+"/bucket/"+url.PathEscape(id), body, &out,
	); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteBucket deletes a bucket. It must be empty -- use EmptyBucket first.
func (s *Storage) DeleteBucket(ctx context.Context, id string) error {
	return s.client.storageJSON(
		ctx, http.MethodDelete, storagePrefix+"/bucket/"+url.PathEscape(id), nil, nil,
	)
}

// EmptyBucket deletes every object in a bucket without removing the bucket.
func (s *Storage) EmptyBucket(ctx context.Context, id string) error {
	return s.client.storageJSON(
		ctx, http.MethodPost, storagePrefix+"/bucket/"+url.PathEscape(id)+"/empty", nil, nil,
	)
}

// RevokeSignedURLs revokes every signed URL ever issued for a bucket.
func (s *Storage) RevokeSignedURLs(ctx context.Context, id string) error {
	return s.client.storageJSON(
		ctx, http.MethodPost, storagePrefix+"/bucket/"+url.PathEscape(id)+"/sign-revoke", nil, nil,
	)
}

// Usage returns aggregate storage usage across buckets and per-user totals.
func (s *Storage) Usage(ctx context.Context) (*UsageReport, error) {
	var out UsageReport
	if err := s.client.storageJSON(ctx, http.MethodGet, storagePrefix+"/usage", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Per-bucket builder
// ---------------------------------------------------------------------------

// StorageBucketBuilder carries per-bucket object operations. Obtain via
// Storage.From.
type StorageBucketBuilder struct {
	client *Client
	Bucket string
}

func (b *StorageBucketBuilder) objectPath(path string) string {
	return fmt.Sprintf("%s/object/%s/%s", storagePrefix, url.PathEscape(b.Bucket), encodePath(path))
}

// Upload uploads a small file in a single request. For files larger than a
// few megabytes prefer UploadResumable.
func (b *StorageBucketBuilder) Upload(ctx context.Context, path string, body []byte, opts UploadOptions) (*UploadResult, error) {
	mime := opts.ContentType
	if mime == "" {
		mime = InferContentType(path)
		if mime == "" {
			mime = "application/octet-stream"
		}
	}
	headers := http.Header{}
	headers.Set("Content-Type", mime)
	if opts.CacheControl != "" {
		headers.Set("Cache-Control", opts.CacheControl)
	}
	method := http.MethodPost
	if opts.Upsert {
		method = http.MethodPut
	}
	resp, err := b.client.storageRaw(ctx, method, b.objectPath(path), bytes.NewReader(body), headers)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := errFromResponse(resp); err != nil {
		return nil, err
	}
	var out UploadResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("anvilent: decode upload response: %w", err)
	}
	return &out, nil
}

// UploadResumable uploads a file using the TUS 1.0.0 resumable protocol.
func (b *StorageBucketBuilder) UploadResumable(ctx context.Context, path string, body []byte, opts ResumableUploadOptions) (*ResumableUploadResult, error) {
	total := uint64(len(body))
	chunkSize := opts.ChunkSize
	if chunkSize == 0 {
		chunkSize = 5 * 1024 * 1024
	}
	if chunkSize <= 0 {
		return nil, fmt.Errorf("anvilent: chunk size must be > 0")
	}
	mime := opts.ContentType
	if mime == "" {
		mime = InferContentType(path)
		if mime == "" {
			mime = "application/octet-stream"
		}
	}

	var sessionURL string
	var offset uint64
	if opts.ResumeFrom != "" {
		sessionURL = opts.ResumeFrom
		off, err := b.tusHeadOffset(ctx, sessionURL)
		if err != nil {
			return nil, err
		}
		offset = off
	} else {
		url, err := b.tusCreate(ctx, path, total, mime)
		if err != nil {
			return nil, err
		}
		sessionURL = url
	}

	var contentHash string
	for offset < total {
		end := offset + uint64(chunkSize)
		if end > total {
			end = total
		}
		chunk := body[offset:end]
		newOffset, hash, err := b.tusPatch(ctx, sessionURL, offset, chunk)
		if err != nil {
			return nil, err
		}
		offset = newOffset
		if hash != "" {
			contentHash = hash
		}
		if opts.OnProgress != nil {
			percent := 100.0
			if total != 0 {
				percent = float64(int(float64(offset)/float64(total)*10000)) / 100.0
			}
			opts.OnProgress(UploadProgress{Loaded: offset, Total: total, Percent: percent})
		}
	}

	etag := ""
	if contentHash != "" {
		etag = fmt.Sprintf("W/\"%s\"", contentHash)
	}
	name := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		name = path[i+1:]
	}
	return &ResumableUploadResult{
		UploadResult: UploadResult{
			BucketID:    b.Bucket,
			Path:        path,
			Name:        name,
			MimeType:    mime,
			Size:        total,
			ETag:        etag,
			ContentHash: contentHash,
		},
		SessionURL: sessionURL,
	}, nil
}

func (b *StorageBucketBuilder) tusCreate(ctx context.Context, path string, length uint64, mime string) (string, error) {
	meta := EncodeUploadMetadata(map[string]string{
		"bucket": b.Bucket,
		"path":   path,
		"mime":   mime,
	})
	headers := http.Header{}
	headers.Set("Tus-Resumable", "1.0.0")
	headers.Set("Upload-Length", strconv.FormatUint(length, 10))
	headers.Set("Upload-Metadata", meta)
	resp, err := b.client.storageRaw(ctx, http.MethodPost, storagePrefix+"/upload/resumable", nil, headers)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return "", errFromResponse(resp)
	}
	loc := resp.Header.Get("Location")
	if loc == "" {
		return "", fmt.Errorf("anvilent: TUS server returned no Location header")
	}
	return loc, nil
}

func (b *StorageBucketBuilder) tusHeadOffset(ctx context.Context, sessionURL string) (uint64, error) {
	headers := http.Header{}
	headers.Set("Tus-Resumable", "1.0.0")
	resp, err := b.client.storageRaw(ctx, http.MethodHead, sessionURL, nil, headers)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if err := errFromResponse(resp); err != nil {
		return 0, err
	}
	off := resp.Header.Get("Upload-Offset")
	if off == "" {
		return 0, fmt.Errorf("anvilent: TUS HEAD returned no Upload-Offset header")
	}
	return strconv.ParseUint(off, 10, 64)
}

func (b *StorageBucketBuilder) tusPatch(ctx context.Context, sessionURL string, offset uint64, chunk []byte) (uint64, string, error) {
	headers := http.Header{}
	headers.Set("Tus-Resumable", "1.0.0")
	headers.Set("Content-Type", "application/offset+octet-stream")
	headers.Set("Upload-Offset", strconv.FormatUint(offset, 10))
	resp, err := b.client.storageRaw(ctx, http.MethodPatch, sessionURL, bytes.NewReader(chunk), headers)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if err := errFromResponse(resp); err != nil {
		return 0, "", err
	}
	off := resp.Header.Get("Upload-Offset")
	if off == "" {
		return 0, "", fmt.Errorf("anvilent: TUS PATCH returned no Upload-Offset header")
	}
	newOffset, err := strconv.ParseUint(off, 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("anvilent: invalid Upload-Offset header: %w", err)
	}
	return newOffset, resp.Header.Get("X-Anvil-Content-Hash"), nil
}

// Download fetches an object's bytes. For very large files prefer
// DownloadStream so the body isn't buffered in memory.
func (b *StorageBucketBuilder) Download(ctx context.Context, path string) ([]byte, error) {
	resp, err := b.client.storageRaw(ctx, http.MethodGet, b.objectPath(path), nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := errFromResponse(resp); err != nil {
		return nil, err
	}
	return io.ReadAll(resp.Body)
}

// DownloadStream returns the raw response so callers can stream the body.
// The caller is responsible for closing the response Body.
func (b *StorageBucketBuilder) DownloadStream(ctx context.Context, path string) (*http.Response, error) {
	resp, err := b.client.storageRaw(ctx, http.MethodGet, b.objectPath(path), nil, nil)
	if err != nil {
		return nil, err
	}
	if err := errFromResponse(resp); err != nil {
		resp.Body.Close()
		return nil, err
	}
	return resp, nil
}

// GetPublicURL builds a public download URL for the object. The bucket must
// be public.
func (b *StorageBucketBuilder) GetPublicURL(path string, opts PublicURLOptions) PublicURLResult {
	encoded := url.PathEscape(b.Bucket) + "/" + encodePath(path)
	var route string
	if opts.Transform != nil {
		route = storagePrefix + "/render/image/public/" + encoded
	} else {
		route = storagePrefix + "/object/public/" + encoded
	}
	qs := opts.Transform.toQuery()
	full := b.client.baseURL + route
	if qs != "" {
		full += "?" + qs
	}
	if opts.Download != nil {
		prefix := "?"
		if qs != "" {
			prefix = "&"
		}
		if opts.Download.Filename == "" {
			full += prefix + "download"
		} else {
			full += prefix + "download=" + url.QueryEscape(opts.Download.Filename)
		}
	}
	return PublicURLResult{PublicURL: full}
}

// CreateSignedURL mints a signed download URL.
func (b *StorageBucketBuilder) CreateSignedURL(ctx context.Context, path string, expiresIn uint64, opts SignedURLOptions) (*SignedURLResult, error) {
	encoded := url.PathEscape(b.Bucket) + "/" + encodePath(path)
	var route string
	if opts.Transform != nil {
		route = storagePrefix + "/render/image/sign/" + encoded
	} else {
		route = storagePrefix + "/object/sign/" + encoded
	}
	body := map[string]any{"expires_in": expiresIn}
	if opts.Transform != nil {
		body["transform"] = opts.Transform
	}
	var raw struct {
		Token     string `json:"token"`
		URL       string `json:"url"`
		ExpiresAt uint64 `json:"expires_at"`
		ExpiresIn uint64 `json:"expires_in"`
	}
	if err := b.client.storageJSON(ctx, http.MethodPost, route, body, &raw); err != nil {
		return nil, err
	}
	signed := b.client.baseURL + raw.URL
	if opts.Download != nil {
		if opts.Download.Filename == "" {
			signed += "?download"
		} else {
			signed += "?download=" + url.QueryEscape(opts.Download.Filename)
		}
	}
	return &SignedURLResult{
		SignedURL: signed,
		Token:     raw.Token,
		ExpiresAt: raw.ExpiresAt,
		ExpiresIn: raw.ExpiresIn,
	}, nil
}

// CreateSignedUploadURL mints a signed upload URL.
func (b *StorageBucketBuilder) CreateSignedUploadURL(ctx context.Context, path string, opts SignedUploadURLOptions) (*SignedUploadURLResult, error) {
	encoded := url.PathEscape(b.Bucket) + "/" + encodePath(path)
	route := storagePrefix + "/object/upload/sign/" + encoded
	body := map[string]any{"expires_in": opts.ExpiresIn}
	var raw struct {
		Token     string `json:"token"`
		URL       string `json:"url"`
		ExpiresAt uint64 `json:"expires_at"`
		ExpiresIn uint64 `json:"expires_in"`
	}
	if err := b.client.storageJSON(ctx, http.MethodPost, route, body, &raw); err != nil {
		return nil, err
	}
	return &SignedUploadURLResult{
		SignedURL: b.client.baseURL + raw.URL,
		Token:     raw.Token,
		ExpiresAt: raw.ExpiresAt,
		ExpiresIn: raw.ExpiresIn,
	}, nil
}

// List lists objects in the bucket, optionally filtered by a path prefix.
func (b *StorageBucketBuilder) List(ctx context.Context, prefix string, opts ListOptions) (*ListResult, error) {
	route := storagePrefix + "/object/list/" + url.PathEscape(b.Bucket)
	body := map[string]any{}
	if prefix != "" {
		body["prefix"] = prefix
	}
	if opts.Limit > 0 {
		body["limit"] = opts.Limit
	}
	if opts.Offset > 0 {
		body["offset"] = opts.Offset
	}
	if opts.SortBy != nil {
		body["sort_by"] = opts.SortBy.Column
		if opts.SortBy.Order != "" {
			body["order"] = opts.SortBy.Order
		}
	}
	var out ListResult
	if err := b.client.storageJSON(ctx, http.MethodPost, route, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Move renames an object within the bucket.
func (b *StorageBucketBuilder) Move(ctx context.Context, from, to string) (*ObjectMetadata, error) {
	return b.moveOrCopy(ctx, "move", from, to)
}

// Copy copies an object within the bucket.
func (b *StorageBucketBuilder) Copy(ctx context.Context, from, to string) (*ObjectMetadata, error) {
	return b.moveOrCopy(ctx, "copy", from, to)
}

func (b *StorageBucketBuilder) moveOrCopy(ctx context.Context, op, from, to string) (*ObjectMetadata, error) {
	body := map[string]any{
		"source_bucket": b.Bucket,
		"source_path":   from,
		"dest_bucket":   b.Bucket,
		"dest_path":     to,
	}
	var out ObjectMetadata
	if err := b.client.storageJSON(ctx, http.MethodPost, storagePrefix+"/object/"+op, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Remove deletes one or more objects. Missing paths are skipped silently.
// Returns the list of paths that were actually deleted.
func (b *StorageBucketBuilder) Remove(ctx context.Context, paths []string) ([]string, error) {
	deleted := make([]string, 0, len(paths))
	for _, p := range paths {
		resp, err := b.client.storageRaw(ctx, http.MethodDelete, b.objectPath(p), nil, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			continue
		}
		if err := errFromResponse(resp); err != nil {
			resp.Body.Close()
			return nil, err
		}
		resp.Body.Close()
		deleted = append(deleted, p)
	}
	return deleted, nil
}

// Exists reports whether an object exists at the given path.
func (b *StorageBucketBuilder) Exists(ctx context.Context, path string) (bool, error) {
	resp, err := b.client.storageRaw(ctx, http.MethodHead, b.objectPath(path), nil, nil)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if err := errFromResponse(resp); err != nil {
		return false, err
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for callers + reused inside the package)
// ---------------------------------------------------------------------------

// ParseByteSize parses a byte-size hint into a non-negative int64. Accepts
// either a bare numeric string ("1024") or a unit suffix ("5MB" / "1GiB").
func ParseByteSize(value string) (int64, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, fmt.Errorf("anvilent: empty byte-size string")
	}
	upper := strings.ToUpper(trimmed)
	units := []struct {
		suffix string
		mult   int64
	}{
		{"TIB", 1024 * 1024 * 1024 * 1024},
		{"GIB", 1024 * 1024 * 1024},
		{"MIB", 1024 * 1024},
		{"KIB", 1024},
		{"TB", 1_000_000_000_000},
		{"GB", 1_000_000_000},
		{"MB", 1_000_000},
		{"KB", 1_000},
		{"B", 1},
	}
	for _, u := range units {
		if stripped, ok := strings.CutSuffix(upper, u.suffix); ok {
			stripped = strings.TrimSpace(stripped)
			n, err := strconv.ParseFloat(stripped, 64)
			if err != nil || n < 0 {
				return 0, fmt.Errorf("anvilent: invalid byte size: %q", value)
			}
			return int64(n * float64(u.mult)), nil
		}
	}
	n, err := strconv.ParseInt(upper, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("anvilent: invalid byte size: %q", value)
	}
	return n, nil
}

// encodePath percent-encodes each `/`-separated path segment independently,
// preserving the literal slashes that the server's axum {*path} capture
// expects.
func encodePath(p string) string {
	if p == "" {
		return ""
	}
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// EncodeUploadMetadata encodes the TUS Upload-Metadata header.
//
// Each value is base64-encoded UTF-8 and key/value pairs are joined with
// commas. Keys are emitted in alphabetical order so the output is stable
// and testable.
func EncodeUploadMetadata(meta map[string]string) string {
	keys := make([]string, 0, len(meta))
	for k := range meta {
		keys = append(keys, k)
	}
	// Bubble-style stable sort to avoid importing sort just for this.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	pieces := make([]string, 0, len(keys))
	for _, k := range keys {
		enc := base64.StdEncoding.EncodeToString([]byte(meta[k]))
		pieces = append(pieces, k+" "+enc)
	}
	return strings.Join(pieces, ",")
}

// InferContentType guesses a MIME type from a file extension. Returns "" on miss.
func InferContentType(path string) string {
	lower := strings.ToLower(path)
	i := strings.LastIndex(lower, ".")
	if i < 0 || i == len(lower)-1 {
		return ""
	}
	ext := lower[i+1:]
	switch ext {
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "svg":
		return "image/svg+xml"
	case "avif":
		return "image/avif"
	case "pdf":
		return "application/pdf"
	case "txt":
		return "text/plain"
	case "json":
		return "application/json"
	case "js":
		return "application/javascript"
	case "css":
		return "text/css"
	case "html", "htm":
		return "text/html"
	case "csv":
		return "text/csv"
	case "md":
		return "text/markdown"
	case "mp4":
		return "video/mp4"
	case "webm":
		return "video/webm"
	case "mp3":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "zip":
		return "application/zip"
	}
	return ""
}

// ---------------------------------------------------------------------------
// Internal HTTP plumbing -- bound to *Client so it can share token state
// ---------------------------------------------------------------------------

// storageJSON sends a JSON-bodied request and decodes the JSON response.
// Mirrors the semantics of doJSON but reused here to keep the storage
// surface decoupled from the rest of the Client implementation.
func (c *Client) storageJSON(ctx context.Context, method, path string, reqBody any, respBody any) error {
	var headers http.Header
	if reqBody != nil {
		headers = http.Header{}
		headers.Set("Content-Type", "application/json")
	}
	var bodyReader io.Reader
	if reqBody != nil {
		data, err := json.Marshal(reqBody)
		if err != nil {
			return fmt.Errorf("anvilent: marshal storage request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}
	resp, err := c.storageRaw(ctx, method, path, bodyReader, headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := errFromResponse(resp); err != nil {
		return err
	}
	if respBody == nil {
		return nil
	}
	if resp.StatusCode == http.StatusNoContent || resp.ContentLength == 0 {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(respBody)
}

// storageRaw is the storage namespace's authenticated raw fetch.
//
// Differs from doRequest in three ways:
//   - returns the response even for 4xx / 5xx so callers can branch on
//     status codes (HEAD exists-checks, 404 in batch deletes, etc.).
//   - accepts a header map for per-request overrides (Content-Type, TUS).
//   - retries once on 401 after refreshing the token, mirroring doJSON.
func (c *Client) storageRaw(ctx context.Context, method, path string, body io.Reader, headers http.Header) (*http.Response, error) {
	// For retry to work we need to be able to rewind the body. The common
	// callers either pass `nil` or a *bytes.Reader which Seek()s freely.
	// If someone passes a non-seekable Reader, we read it into memory.
	var rewindable []byte
	if body != nil {
		if seeker, ok := body.(io.Seeker); ok {
			if _, err := seeker.Seek(0, io.SeekStart); err != nil {
				return nil, fmt.Errorf("anvilent: seek body: %w", err)
			}
		} else {
			buf, err := io.ReadAll(body)
			if err != nil {
				return nil, fmt.Errorf("anvilent: read body: %w", err)
			}
			rewindable = buf
		}
	}

	build := func() (*http.Request, error) {
		var reqBody io.Reader
		if body != nil {
			if seeker, ok := body.(io.Seeker); ok {
				if _, err := seeker.Seek(0, io.SeekStart); err != nil {
					return nil, err
				}
				reqBody = body
			} else {
				reqBody = bytes.NewReader(rewindable)
			}
		}
		fullURL := path
		if !strings.HasPrefix(path, "http://") && !strings.HasPrefix(path, "https://") {
			fullURL = c.baseURL + path
		}
		req, err := http.NewRequestWithContext(ctx, method, fullURL, reqBody)
		if err != nil {
			return nil, fmt.Errorf("anvilent: create storage request: %w", err)
		}
		for k, vv := range headers {
			for _, v := range vv {
				req.Header.Add(k, v)
			}
		}
		c.mu.RLock()
		token := c.accessToken
		c.mu.RUnlock()
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return req, nil
	}

	req, err := build()
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		c.mu.RLock()
		hasRefresh := c.refreshToken != ""
		c.mu.RUnlock()
		if hasRefresh {
			resp.Body.Close()
			if refreshErr := c.doRefreshToken(ctx); refreshErr == nil {
				req2, err := build()
				if err != nil {
					return nil, err
				}
				return c.httpClient.Do(req2)
			}
		}
	}
	return resp, nil
}

// errFromResponse turns a non-2xx response into an *AnvilError, preserving
// the server-provided JSON `error` field when present. Callers should still
// close the response body afterwards (this function consumes some/all of it).
func errFromResponse(resp *http.Response) error {
	if resp.StatusCode < 400 {
		return nil
	}
	bodyBytes, _ := io.ReadAll(resp.Body)
	msg := string(bodyBytes)
	var wrapper struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(bodyBytes, &wrapper); err == nil && wrapper.Error != "" {
		msg = wrapper.Error
	}
	return &AnvilError{
		Status:     resp.StatusCode,
		StatusText: http.StatusText(resp.StatusCode),
		Body:       msg,
	}
}
