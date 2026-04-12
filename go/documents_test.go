package anvilent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestListCollections(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/docs" || r.Method != http.MethodGet {
			t.Errorf("path/method = %q %q", r.URL.Path, r.Method)
		}
		json.NewEncoder(w).Encode([]Collection{
			{Name: "users", ID: 1},
			{Name: "posts", ID: 2, CompositeKeys: true},
		})
	}))
	defer srv.Close()

	cols, err := newTestClient(srv).ListCollections(context.Background())
	if err != nil {
		t.Fatalf("ListCollections: %v", err)
	}
	if len(cols) != 2 || cols[0].Name != "users" || !cols[1].CompositeKeys {
		t.Errorf("cols = %+v", cols)
	}
}

func TestCreateCollection(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/docs/users" || r.Method != http.MethodPost {
			t.Errorf("path/method = %q %q", r.URL.Path, r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(Collection{Name: "users", ID: 1, CompositeKeys: true})
	}))
	defer srv.Close()

	col, err := newTestClient(srv).CreateCollection(context.Background(), "users", map[string]any{
		"composite_keys": true,
	})
	if err != nil {
		t.Fatalf("CreateCollection: %v", err)
	}
	if col.Name != "users" || !col.CompositeKeys {
		t.Errorf("col = %+v", col)
	}
	if gotBody["composite_keys"] != true {
		t.Errorf("body = %v", gotBody)
	}
}

func TestDropCollection(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/docs/users" || r.Method != http.MethodDelete {
			t.Errorf("path/method = %q %q", r.URL.Path, r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := newTestClient(srv).DropCollection(context.Background(), "users"); err != nil {
		t.Fatalf("DropCollection: %v", err)
	}
}

func TestGetPutDeleteDocument(t *testing.T) {
	var putBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/docs/users/u1":
			json.NewEncoder(w).Encode(Document{ID: 10, Collection: "users", Key: "u1", Version: 3})
		case r.Method == http.MethodPut && r.URL.Path == "/docs/users/u1":
			_ = json.NewDecoder(r.Body).Decode(&putBody)
			json.NewEncoder(w).Encode(Document{ID: 10, Collection: "users", Key: "u1", Version: 4})
		case r.Method == http.MethodDelete && r.URL.Path == "/docs/users/u1":
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := newTestClient(srv)
	ctx := context.Background()

	got, err := c.GetDocument(ctx, "users", "u1")
	if err != nil {
		t.Fatalf("GetDocument: %v", err)
	}
	if got.Version != 3 {
		t.Errorf("version = %d", got.Version)
	}

	put, err := c.PutDocument(ctx, "users", "u1", map[string]any{"name": "alice"})
	if err != nil {
		t.Fatalf("PutDocument: %v", err)
	}
	if put.Version != 4 {
		t.Errorf("put version = %d", put.Version)
	}
	if putBody["name"] != "alice" {
		t.Errorf("put body = %v", putBody)
	}

	if err := c.DeleteDocument(ctx, "users", "u1"); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
}

func TestQueryDocuments(t *testing.T) {
	var gotBody DocumentQuery
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/docs/users/query" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(DocumentQueryResult{
			Documents: []Document{{ID: 1, Key: "u1"}},
			Count:     1,
			Cursor:    "next",
		})
	}))
	defer srv.Close()

	res, err := newTestClient(srv).QueryDocuments(context.Background(), "users", &DocumentQuery{
		PartitionKey: "p1",
		Limit:        50,
	})
	if err != nil {
		t.Fatalf("QueryDocuments: %v", err)
	}
	if res.Count != 1 || res.Cursor != "next" {
		t.Errorf("res = %+v", res)
	}
	if gotBody.PartitionKey != "p1" || gotBody.Limit != 50 {
		t.Errorf("body = %+v", gotBody)
	}
}

func TestScanDocumentsBuildsQuery(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/docs/users/scan") {
			t.Errorf("path = %q", r.URL.Path)
		}
		gotQuery = r.URL.RawQuery
		json.NewEncoder(w).Encode(DocumentQueryResult{})
	}))
	defer srv.Close()

	c := newTestClient(srv)
	if _, err := c.ScanDocuments(context.Background(), "users", 25, "abc"); err != nil {
		t.Fatalf("ScanDocuments: %v", err)
	}
	if !strings.Contains(gotQuery, "limit=25") || !strings.Contains(gotQuery, "cursor=abc") {
		t.Errorf("query = %q", gotQuery)
	}
}

func TestBatchDocuments(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/docs/users/batch" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer srv.Close()

	ops := []map[string]any{
		{"op": "put", "key": "u1"},
		{"op": "delete", "key": "u2"},
	}
	res, err := newTestClient(srv).BatchDocuments(context.Background(), "users", ops)
	if err != nil {
		t.Fatalf("BatchDocuments: %v", err)
	}
	if m, ok := res.(map[string]any); !ok || m["ok"] != true {
		t.Errorf("res = %v", res)
	}
	if got, ok := gotBody["operations"].([]any); !ok || len(got) != 2 {
		t.Errorf("operations body = %v", gotBody["operations"])
	}
}
