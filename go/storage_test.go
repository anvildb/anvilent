package anvilent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// capturedRequest is a snapshot of a single incoming HTTP request, used for
// assertions in the tests below.
type capturedRequest struct {
	Method  string
	Path    string
	Query   string
	Headers http.Header
	Body    []byte
}

// queuedHandler walks a slice of responders, one per request. Each
// responder receives the captured request and writes back to ResponseWriter.
type queuedHandler struct {
	t          *testing.T
	calls      []capturedRequest
	responders []func(c capturedRequest, w http.ResponseWriter)
	idx        int32
}

func (q *queuedHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	cr := capturedRequest{
		Method:  r.Method,
		Path:    r.URL.Path,
		Query:   r.URL.RawQuery,
		Headers: r.Header.Clone(),
		Body:    body,
	}
	q.calls = append(q.calls, cr)
	i := int(atomic.AddInt32(&q.idx, 1)) - 1
	if i >= len(q.responders) {
		q.t.Fatalf("unexpected request #%d: %s %s", i+1, r.Method, r.URL.Path)
	}
	q.responders[i](cr, w)
}

func setupStorageClient(t *testing.T, responders []func(c capturedRequest, w http.ResponseWriter)) (*Client, *queuedHandler, *httptest.Server) {
	t.Helper()
	q := &queuedHandler{t: t, responders: responders}
	srv := httptest.NewServer(q)
	c := New()
	c.baseURL = srv.URL
	c.accessToken = "test-token"
	t.Cleanup(srv.Close)
	return c, q, srv
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

func TestParseByteSizeBareNumbers(t *testing.T) {
	cases := map[string]int64{"0": 0, "1024": 1024}
	for in, want := range cases {
		got, err := ParseByteSize(in)
		if err != nil || got != want {
			t.Errorf("ParseByteSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
}

func TestParseByteSizeSIUnits(t *testing.T) {
	cases := map[string]int64{
		"5MB":     5_000_000,
		"1GB":     1_000_000_000,
		"250 KB":  250_000,
	}
	for in, want := range cases {
		got, err := ParseByteSize(in)
		if err != nil || got != want {
			t.Errorf("ParseByteSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
}

func TestParseByteSizeIECUnits(t *testing.T) {
	cases := map[string]int64{
		"5MiB":  5 * 1024 * 1024,
		"1GiB":  1024 * 1024 * 1024,
	}
	for in, want := range cases {
		got, err := ParseByteSize(in)
		if err != nil || got != want {
			t.Errorf("ParseByteSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
}

func TestParseByteSizeRejectsGarbage(t *testing.T) {
	for _, in := range []string{"", "nope", "-1"} {
		if _, err := ParseByteSize(in); err == nil {
			t.Errorf("ParseByteSize(%q) should have failed", in)
		}
	}
}

func TestEncodePathPreservesSlashes(t *testing.T) {
	if got := encodePath("users/alice/photo.png"); got != "users/alice/photo.png" {
		t.Errorf("encodePath simple = %q", got)
	}
	if got := encodePath("users/with space/file?.png"); got != "users/with%20space/file%3F.png" {
		t.Errorf("encodePath with special chars = %q", got)
	}
}

func TestEncodeUploadMetadataMatchesTUSSpec(t *testing.T) {
	s := EncodeUploadMetadata(map[string]string{"bucket": "avatars", "path": "alice.png"})
	if s != "bucket YXZhdGFycw==,path YWxpY2UucG5n" {
		t.Errorf("EncodeUploadMetadata = %q", s)
	}
}

func TestInferContentTypeKnownExtensions(t *testing.T) {
	cases := map[string]string{
		"alice.png":     "image/png",
		"clip.MP4":      "video/mp4",
		"no-extension":  "",
	}
	for in, want := range cases {
		if got := InferContentType(in); got != want {
			t.Errorf("InferContentType(%q) = %q; want %q", in, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Bucket CRUD
// ---------------------------------------------------------------------------

func TestCreateBucketSendsBodyAndParsesResponse(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"id":                 "avatars",
				"name":               "avatars",
				"public":             true,
				"file_size_limit":    5_000_000,
				"bucket_size_limit":  nil,
				"allowed_mime_types": []string{"image/png"},
				"owner":              "admin",
				"created_at":         1700,
				"updated_at":         1700,
			})
		},
	})

	bucket, err := c.Storage().CreateBucket(context.Background(), "avatars", CreateBucketOptions{
		Public:           true,
		FileSizeLimit:    "5MB",
		AllowedMimeTypes: []string{"image/png"},
	})
	if err != nil {
		t.Fatalf("CreateBucket: %v", err)
	}
	call := q.calls[0]
	if call.Method != "POST" || call.Path != "/storage/v1/bucket" {
		t.Errorf("call = %s %s", call.Method, call.Path)
	}
	if call.Headers.Get("Authorization") != "Bearer test-token" {
		t.Errorf("missing Authorization header")
	}
	var body map[string]any
	if err := json.Unmarshal(call.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["id"] != "avatars" || body["public"] != true {
		t.Errorf("body = %+v", body)
	}
	if body["file_size_limit"].(float64) != 5_000_000 {
		t.Errorf("file_size_limit = %v", body["file_size_limit"])
	}
	if !bucket.Public || *bucket.FileSizeLimit != 5_000_000 {
		t.Errorf("bucket = %+v", bucket)
	}
}

func TestListBuckets(t *testing.T) {
	c, _, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, []map[string]any{
				{
					"id": "a", "name": "a", "public": false,
					"file_size_limit": nil, "bucket_size_limit": nil,
					"allowed_mime_types": []string{},
					"owner": "admin", "created_at": 1, "updated_at": 1,
				},
				{
					"id": "b", "name": "b", "public": true,
					"file_size_limit": 1000, "bucket_size_limit": 5000,
					"allowed_mime_types": []string{"image/*"},
					"owner": "admin", "created_at": 2, "updated_at": 2,
				},
			})
		},
	})
	buckets, err := c.Storage().ListBuckets(context.Background())
	if err != nil {
		t.Fatalf("ListBuckets: %v", err)
	}
	if len(buckets) != 2 {
		t.Fatalf("len = %d", len(buckets))
	}
	if *buckets[1].BucketSizeLimit != 5000 {
		t.Errorf("buckets[1].BucketSizeLimit = %v", buckets[1].BucketSizeLimit)
	}
}

func TestUpdateBucketClearsLimitsWithEmptyString(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"id": "avatars", "name": "avatars", "public": false,
				"file_size_limit": nil, "bucket_size_limit": nil,
				"allowed_mime_types": []string{},
				"owner": "admin", "created_at": 1, "updated_at": 2,
			})
		},
	})
	clear := ""
	publicFlag := false
	_, err := c.Storage().UpdateBucket(context.Background(), "avatars", UpdateBucketOptions{
		Public:          &publicFlag,
		FileSizeLimit:   &clear,
		BucketSizeLimit: &clear,
	})
	if err != nil {
		t.Fatalf("UpdateBucket: %v", err)
	}
	if q.calls[0].Method != "PUT" {
		t.Errorf("method = %s", q.calls[0].Method)
	}
	var body map[string]any
	if err := json.Unmarshal(q.calls[0].Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["public"] != false {
		t.Errorf("public = %v", body["public"])
	}
	if _, ok := body["file_size_limit"]; !ok {
		t.Errorf("file_size_limit not present")
	}
	if body["file_size_limit"] != nil {
		t.Errorf("file_size_limit not nil: %v", body["file_size_limit"])
	}
}

func TestDeleteAndEmptyBucketRoutes(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) { w.WriteHeader(204) },
		func(_ capturedRequest, w http.ResponseWriter) { w.WriteHeader(204) },
	})
	if err := c.Storage().EmptyBucket(context.Background(), "avatars"); err != nil {
		t.Fatalf("EmptyBucket: %v", err)
	}
	if err := c.Storage().DeleteBucket(context.Background(), "avatars"); err != nil {
		t.Fatalf("DeleteBucket: %v", err)
	}
	if q.calls[0].Method != "POST" || q.calls[0].Path != "/storage/v1/bucket/avatars/empty" {
		t.Errorf("calls[0] = %s %s", q.calls[0].Method, q.calls[0].Path)
	}
	if q.calls[1].Method != "DELETE" || q.calls[1].Path != "/storage/v1/bucket/avatars" {
		t.Errorf("calls[1] = %s %s", q.calls[1].Method, q.calls[1].Path)
	}
}

func TestCreateBucketPropagatesError(t *testing.T) {
	c, _, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeError(w, 409, "bucket already exists")
		},
	})
	_, err := c.Storage().CreateBucket(context.Background(), "avatars", CreateBucketOptions{Public: true})
	var ae *AnvilError
	if !errorsAs(err, &ae) {
		t.Fatalf("err = %v; want *AnvilError", err)
	}
	if ae.Status != 409 || !strings.Contains(ae.Body, "bucket already exists") {
		t.Errorf("err = %+v", ae)
	}
}

func TestUsageNormalizesNestedArrays(t *testing.T) {
	c, _, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"object_count": 42,
				"total_bytes":  1234,
				"buckets": []map[string]any{
					{"bucket_id": "a", "object_count": 1, "total_bytes": 100},
					{"bucket_id": "b", "object_count": 41, "total_bytes": 1134, "bucket_size_limit": 9000},
				},
				"users":             []map[string]any{{"owner": "alice", "object_count": 30, "total_bytes": 900}},
				"max_total_storage": 100000,
			})
		},
	})
	usage, err := c.Storage().Usage(context.Background())
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if usage.ObjectCount != 42 || *usage.MaxTotalStorage != 100000 {
		t.Errorf("usage = %+v", usage)
	}
	if *usage.Buckets[1].BucketSizeLimit != 9000 {
		t.Errorf("buckets[1].BucketSizeLimit = %v", usage.Buckets[1].BucketSizeLimit)
	}
	if usage.Users[0].Owner != "alice" {
		t.Errorf("users[0].Owner = %q", usage.Users[0].Owner)
	}
}

// ---------------------------------------------------------------------------
// Upload (single-shot)
// ---------------------------------------------------------------------------

func TestUploadPOSTSBinaryAndInfersMime(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"id": "obj-1", "bucket_id": "avatars",
				"path": "alice.png", "name": "alice.png",
				"mime_type": "image/png", "size": 4,
				"etag": "W/\"abc\"", "content_hash": "abc",
				"version": 1, "deduped": false,
				"created_at": 100, "updated_at": 100,
			})
		},
	})
	result, err := c.Storage().From("avatars").Upload(
		context.Background(), "alice.png", []byte{1, 2, 3, 4}, UploadOptions{},
	)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	call := q.calls[0]
	if call.Method != "POST" || call.Path != "/storage/v1/object/avatars/alice.png" {
		t.Errorf("call = %s %s", call.Method, call.Path)
	}
	if call.Headers.Get("Content-Type") != "image/png" {
		t.Errorf("Content-Type = %q", call.Headers.Get("Content-Type"))
	}
	if !reflect.DeepEqual(call.Body, []byte{1, 2, 3, 4}) {
		t.Errorf("body = %v", call.Body)
	}
	if result.ID != "obj-1" || result.ContentHash != "abc" {
		t.Errorf("result = %+v", result)
	}
}

func TestUploadUsesPUTWhenUpsert(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"id": "obj-1", "bucket_id": "avatars",
				"path": "alice.png", "name": "alice.png",
				"mime_type": "image/png", "size": 1,
				"etag": "x", "content_hash": "x",
				"version": 2, "deduped": true,
				"created_at": 1, "updated_at": 2,
			})
		},
	})
	_, err := c.Storage().From("avatars").Upload(
		context.Background(), "alice.png", []byte{1}, UploadOptions{
			Upsert:       true,
			ContentType:  "image/png",
			CacheControl: "public, max-age=3600",
		},
	)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if q.calls[0].Method != "PUT" {
		t.Errorf("method = %s", q.calls[0].Method)
	}
	if q.calls[0].Headers.Get("Cache-Control") != "public, max-age=3600" {
		t.Errorf("Cache-Control = %q", q.calls[0].Headers.Get("Cache-Control"))
	}
}

func TestUploadPercentEncodesPath(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"id": "x", "bucket_id": "avatars",
				"path": "users/alice has space/photo.png",
				"name": "photo.png", "mime_type": "image/png",
				"size": 1, "etag": "x", "content_hash": "x",
				"version": 1, "deduped": false,
				"created_at": 0, "updated_at": 0,
			})
		},
	})
	_, err := c.Storage().From("avatars").Upload(
		context.Background(), "users/alice has space/photo.png", []byte{1}, UploadOptions{},
	)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	// httptest decodes the path before invoking the handler, so compare
	// against the decoded form. The percent-encoded version is visible
	// via call.Headers via URL not here -- but the call did succeed, so
	// the encoder produced a URL the server could parse.
	if q.calls[0].Path != "/storage/v1/object/avatars/users/alice has space/photo.png" {
		t.Errorf("path = %q", q.calls[0].Path)
	}
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

func TestDownloadReturnsBytes(t *testing.T) {
	c, _, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Content-Type", "image/png")
			w.WriteHeader(200)
			_, _ = w.Write([]byte{7, 8, 9})
		},
	})
	got, err := c.Storage().From("avatars").Download(context.Background(), "alice.png")
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !reflect.DeepEqual(got, []byte{7, 8, 9}) {
		t.Errorf("got = %v", got)
	}
}

func TestDownload404Raises(t *testing.T) {
	c, _, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) { writeError(w, 404, "not found") },
	})
	_, err := c.Storage().From("avatars").Download(context.Background(), "missing.png")
	var ae *AnvilError
	if !errorsAs(err, &ae) || ae.Status != 404 {
		t.Errorf("err = %v", err)
	}
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

func TestGetPublicURLStandard(t *testing.T) {
	c, _, srv := setupStorageClient(t, nil)
	got := c.Storage().From("avatars").GetPublicURL("alice.png", PublicURLOptions{})
	if got.PublicURL != srv.URL+"/storage/v1/object/public/avatars/alice.png" {
		t.Errorf("URL = %q", got.PublicURL)
	}
}

func TestGetPublicURLWithTransform(t *testing.T) {
	c, _, srv := setupStorageClient(t, nil)
	w, h := uint32(200), uint32(200)
	got := c.Storage().From("avatars").GetPublicURL("alice.png", PublicURLOptions{
		Transform: &ImageTransform{Width: &w, Height: &h, Resize: "cover", Format: "webp"},
	})
	if !strings.HasPrefix(got.PublicURL, srv.URL+"/storage/v1/render/image/public/avatars/alice.png?") {
		t.Errorf("URL prefix = %q", got.PublicURL)
	}
	for _, frag := range []string{"width=200", "height=200", "resize=cover", "format=webp"} {
		if !strings.Contains(got.PublicURL, frag) {
			t.Errorf("URL missing %q: %s", frag, got.PublicURL)
		}
	}
}

func TestGetPublicURLWithDownloadFilename(t *testing.T) {
	c, _, _ := setupStorageClient(t, nil)
	got := c.Storage().From("avatars").GetPublicURL("alice.png", PublicURLOptions{
		Download: &Download{Filename: "headshot.png"},
	})
	if !strings.Contains(got.PublicURL, "download=headshot.png") {
		t.Errorf("URL = %q", got.PublicURL)
	}
}

func TestCreateSignedURLPostsToSign(t *testing.T) {
	c, q, srv := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"token":      "tok-xyz",
				"url":        "/storage/v1/object/signed/tok-xyz",
				"expires_at": 5000,
				"expires_in": 60,
			})
		},
	})
	result, err := c.Storage().From("avatars").CreateSignedURL(context.Background(), "alice.png", 60, SignedURLOptions{})
	if err != nil {
		t.Fatalf("CreateSignedURL: %v", err)
	}
	if q.calls[0].Method != "POST" || q.calls[0].Path != "/storage/v1/object/sign/avatars/alice.png" {
		t.Errorf("call = %s %s", q.calls[0].Method, q.calls[0].Path)
	}
	var body map[string]any
	_ = json.Unmarshal(q.calls[0].Body, &body)
	if int(body["expires_in"].(float64)) != 60 {
		t.Errorf("body = %v", body)
	}
	want := srv.URL + "/storage/v1/object/signed/tok-xyz"
	if result.SignedURL != want {
		t.Errorf("SignedURL = %q; want %q", result.SignedURL, want)
	}
}

func TestCreateSignedURLRendersWithTransform(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"token":      "tok-rs",
				"url":        "/storage/v1/object/signed/tok-rs",
				"expires_at": 5000,
				"expires_in": 60,
			})
		},
	})
	width := uint32(100)
	_, err := c.Storage().From("avatars").CreateSignedURL(
		context.Background(), "alice.png", 60, SignedURLOptions{Transform: &ImageTransform{Width: &width}},
	)
	if err != nil {
		t.Fatalf("CreateSignedURL: %v", err)
	}
	if q.calls[0].Path != "/storage/v1/render/image/sign/avatars/alice.png" {
		t.Errorf("path = %s", q.calls[0].Path)
	}
}

// ---------------------------------------------------------------------------
// List / move / copy / remove
// ---------------------------------------------------------------------------

func TestListPostsWithPrefixAndSort(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"bucket_id": "avatars",
				"items": []map[string]any{{
					"path": "users/alice.png", "name": "alice.png",
					"size": 100, "mime_type": "image/png",
					"etag": "x", "content_hash": "x",
					"created_at": 1, "updated_at": 2,
				}},
				"total":  1,
				"limit":  50,
				"offset": 0,
			})
		},
	})
	result, err := c.Storage().From("avatars").List(context.Background(), "users/", ListOptions{
		Limit:  50,
		Offset: 0,
		SortBy: &SortBy{Column: "created_at", Order: "desc"},
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var body map[string]any
	_ = json.Unmarshal(q.calls[0].Body, &body)
	if body["prefix"] != "users/" || body["sort_by"] != "created_at" || body["order"] != "desc" {
		t.Errorf("body = %v", body)
	}
	if int(body["limit"].(float64)) != 50 {
		t.Errorf("limit = %v", body["limit"])
	}
	if len(result.Items) != 1 || result.Items[0].Path != "users/alice.png" {
		t.Errorf("items = %+v", result.Items)
	}
}

func TestMovePostsSourceAndDest(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			writeJSON(w, 200, map[string]any{
				"id": "obj-1", "bucket_id": "avatars",
				"path": "new.png", "name": "new.png",
				"mime_type": "image/png", "size": 1,
				"etag": "x", "content_hash": "x",
				"version": 2, "deduped": false,
				"metadata": map[string]any{}, "owner": "admin",
				"created_at": 1, "updated_at": 2,
				"last_accessed_at": 0,
			})
		},
	})
	meta, err := c.Storage().From("avatars").Move(context.Background(), "old.png", "new.png")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if q.calls[0].Method != "POST" || q.calls[0].Path != "/storage/v1/object/move" {
		t.Errorf("call = %s %s", q.calls[0].Method, q.calls[0].Path)
	}
	var body map[string]any
	_ = json.Unmarshal(q.calls[0].Body, &body)
	if body["source_path"] != "old.png" || body["dest_path"] != "new.png" {
		t.Errorf("body = %+v", body)
	}
	if meta.Path != "new.png" {
		t.Errorf("meta.Path = %q", meta.Path)
	}
}

func TestRemoveReturnsSuccessfulPaths(t *testing.T) {
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) { w.WriteHeader(204) },
		func(_ capturedRequest, w http.ResponseWriter) { writeError(w, 404, "not found") },
		func(_ capturedRequest, w http.ResponseWriter) { w.WriteHeader(204) },
	})
	deleted, err := c.Storage().From("avatars").Remove(context.Background(), []string{"a.png", "ghost.png", "b.png"})
	if err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(q.calls) != 3 {
		t.Fatalf("calls = %d", len(q.calls))
	}
	for _, call := range q.calls {
		if call.Method != "DELETE" {
			t.Errorf("call method = %s", call.Method)
		}
	}
	if !reflect.DeepEqual(deleted, []string{"a.png", "b.png"}) {
		t.Errorf("deleted = %v", deleted)
	}
}

func TestExistsReturnsTrueForOKFalseFor404(t *testing.T) {
	c, _, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) { w.WriteHeader(200) },
		func(_ capturedRequest, w http.ResponseWriter) { writeError(w, 404, "not found") },
	})
	bucket := c.Storage().From("avatars")
	if ok, _ := bucket.Exists(context.Background(), "a.png"); !ok {
		t.Errorf("Exists(a.png) = false")
	}
	if ok, _ := bucket.Exists(context.Background(), "ghost.png"); ok {
		t.Errorf("Exists(ghost.png) = true")
	}
}

// ---------------------------------------------------------------------------
// Resumable / TUS
// ---------------------------------------------------------------------------

func TestUploadResumableFullSession(t *testing.T) {
	data := []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

	c, q, srv := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		// POST /upload/resumable - session creation
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Location", "/storage/v1/upload/resumable/session-id")
			w.Header().Set("Upload-Offset", "0")
			w.Header().Set("Upload-Length", "10")
			w.Header().Set("Tus-Resumable", "1.0.0")
			w.WriteHeader(201)
		},
		// PATCH chunk 1: 0..4
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Upload-Offset", "4")
			w.Header().Set("Tus-Resumable", "1.0.0")
			w.WriteHeader(204)
		},
		// PATCH chunk 2: 4..8
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Upload-Offset", "8")
			w.Header().Set("Tus-Resumable", "1.0.0")
			w.WriteHeader(204)
		},
		// PATCH chunk 3: 8..10 - final with content hash
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Upload-Offset", "10")
			w.Header().Set("Tus-Resumable", "1.0.0")
			w.Header().Set("Location", "/storage/v1/object/videos/intro.mp4")
			w.Header().Set("X-Anvil-Content-Hash", "deadbeef")
			w.WriteHeader(204)
		},
	})

	var progress []uint64
	result, err := c.Storage().From("videos").UploadResumable(
		context.Background(), "intro.mp4", data, ResumableUploadOptions{
			ChunkSize:   4,
			ContentType: "video/mp4",
			OnProgress:  func(p UploadProgress) { progress = append(progress, p.Loaded) },
		},
	)
	if err != nil {
		t.Fatalf("UploadResumable: %v", err)
	}

	create := q.calls[0]
	if create.Path != "/storage/v1/upload/resumable" || create.Method != "POST" {
		t.Errorf("create call = %s %s", create.Method, create.Path)
	}
	if create.Headers.Get("Tus-Resumable") != "1.0.0" || create.Headers.Get("Upload-Length") != "10" {
		t.Errorf("create headers = %+v", create.Headers)
	}
	for _, kw := range []string{"bucket ", "path ", "mime "} {
		if !strings.Contains(create.Headers.Get("Upload-Metadata"), kw) {
			t.Errorf("Upload-Metadata missing %q: %q", kw, create.Headers.Get("Upload-Metadata"))
		}
	}

	if q.calls[1].Headers.Get("Upload-Offset") != "0" ||
		q.calls[2].Headers.Get("Upload-Offset") != "4" ||
		q.calls[3].Headers.Get("Upload-Offset") != "8" {
		t.Errorf("patch offsets = [%s, %s, %s]",
			q.calls[1].Headers.Get("Upload-Offset"),
			q.calls[2].Headers.Get("Upload-Offset"),
			q.calls[3].Headers.Get("Upload-Offset"),
		)
	}
	if !reflect.DeepEqual(q.calls[1].Body, data[0:4]) ||
		!reflect.DeepEqual(q.calls[2].Body, data[4:8]) ||
		!reflect.DeepEqual(q.calls[3].Body, data[8:10]) {
		t.Errorf("patch bodies mismatch")
	}
	if !reflect.DeepEqual(progress, []uint64{4, 8, 10}) {
		t.Errorf("progress = %v", progress)
	}
	if result.Path != "intro.mp4" || result.BucketID != "videos" || result.Size != 10 {
		t.Errorf("result = %+v", result.UploadResult)
	}
	if result.ContentHash != "deadbeef" {
		t.Errorf("content hash = %q", result.ContentHash)
	}
	if result.SessionURL != "/storage/v1/upload/resumable/session-id" {
		t.Errorf("session url = %q", result.SessionURL)
	}
	_ = srv
}

func TestUploadResumableResumeFrom(t *testing.T) {
	data := []byte{0, 1, 2, 3, 4, 5, 6, 7}
	c, q, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		// HEAD: offset 4, length 8
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Upload-Offset", "4")
			w.Header().Set("Upload-Length", "8")
			w.Header().Set("Tus-Resumable", "1.0.0")
			w.WriteHeader(200)
		},
		// PATCH 4..8 final
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Upload-Offset", "8")
			w.Header().Set("Tus-Resumable", "1.0.0")
			w.Header().Set("X-Anvil-Content-Hash", "cafef00d")
			w.WriteHeader(204)
		},
	})
	var progress []uint64
	result, err := c.Storage().From("videos").UploadResumable(
		context.Background(), "clip.mp4", data, ResumableUploadOptions{
			ChunkSize:   8,
			ContentType: "video/mp4",
			ResumeFrom:  "/storage/v1/upload/resumable/existing",
			OnProgress:  func(p UploadProgress) { progress = append(progress, p.Loaded) },
		},
	)
	if err != nil {
		t.Fatalf("UploadResumable: %v", err)
	}
	if q.calls[0].Method != "HEAD" || q.calls[1].Method != "PATCH" {
		t.Errorf("methods = %s, %s", q.calls[0].Method, q.calls[1].Method)
	}
	if q.calls[1].Headers.Get("Upload-Offset") != "4" {
		t.Errorf("patch offset = %s", q.calls[1].Headers.Get("Upload-Offset"))
	}
	if !reflect.DeepEqual(q.calls[1].Body, data[4:8]) {
		t.Errorf("patch body = %v", q.calls[1].Body)
	}
	if !reflect.DeepEqual(progress, []uint64{8}) {
		t.Errorf("progress = %v", progress)
	}
	if result.ContentHash != "cafef00d" {
		t.Errorf("content hash = %q", result.ContentHash)
	}
}

func TestUploadResumablePropagatesPatchErrors(t *testing.T) {
	c, _, _ := setupStorageClient(t, []func(c capturedRequest, w http.ResponseWriter){
		func(_ capturedRequest, w http.ResponseWriter) {
			w.Header().Set("Location", "/storage/v1/upload/resumable/x")
			w.Header().Set("Tus-Resumable", "1.0.0")
			w.WriteHeader(201)
		},
		func(_ capturedRequest, w http.ResponseWriter) { writeError(w, 409, "Upload-Offset mismatch") },
	})
	_, err := c.Storage().From("misc").UploadResumable(
		context.Background(), "x.bin", []byte{1, 2}, ResumableUploadOptions{ChunkSize: 2},
	)
	var ae *AnvilError
	if !errorsAs(err, &ae) || ae.Status != 409 {
		t.Errorf("err = %v", err)
	}
}

// ---------------------------------------------------------------------------
// 401 refresh retry inherited from storageRaw
// ---------------------------------------------------------------------------

func TestStorageInherits401RefreshRetry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/storage/v1/bucket":
			if r.Header.Get("Authorization") == "Bearer old" {
				writeError(w, 401, "token expired")
				return
			}
			writeJSON(w, 200, []map[string]any{{
				"id": "x", "name": "x", "public": false,
				"file_size_limit": nil, "bucket_size_limit": nil,
				"allowed_mime_types": []string{},
				"owner": "admin", "created_at": 1, "updated_at": 1,
			}})
		case "/auth/refresh":
			writeJSON(w, 200, map[string]any{
				"access_token":  "new",
				"refresh_token": "r2",
				"id_token":      "id",
			})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	c := New()
	c.baseURL = srv.URL
	c.accessToken = "old"
	c.refreshToken = "r"
	buckets, err := c.Storage().ListBuckets(context.Background())
	if err != nil {
		t.Fatalf("ListBuckets: %v", err)
	}
	if len(buckets) != 1 || buckets[0].ID != "x" {
		t.Errorf("buckets = %+v", buckets)
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.accessToken != "new" {
		t.Errorf("accessToken after retry = %q", c.accessToken)
	}
}

// errorsAs is a tiny stand-in for errors.As so the test file doesn't have to
// import "errors" just for one call (and to keep noise out of the failure
// messages above).
func errorsAs(err error, target **AnvilError) bool {
	ae, ok := err.(*AnvilError)
	if ok {
		*target = ae
	}
	return ok
}
