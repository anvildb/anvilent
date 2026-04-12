package anvilent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// newTestClient returns a Client pointed at the given test server.
func newTestClient(srv *httptest.Server) *Client {
	c := New()
	c.baseURL = srv.URL
	return c
}

func TestConnectParsesAndStoresBaseURL(t *testing.T) {
	c := New()
	err := c.Connect(context.Background(), "anvil://host.example.com:1234/mydb")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if c.baseURL != "http://host.example.com:1234" {
		t.Errorf("baseURL = %q", c.baseURL)
	}
	if c.database != "mydb" {
		t.Errorf("database = %q", c.database)
	}
	if c.useTLS {
		t.Error("useTLS should be false for anvil://")
	}
}

func TestConnectTLSForcesHTTPS(t *testing.T) {
	c := New()
	err := c.Connect(context.Background(), "anvil+tls://host")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !strings.HasPrefix(c.baseURL, "https://") {
		t.Errorf("baseURL should start with https://, got %q", c.baseURL)
	}
	if !c.useTLS {
		t.Error("useTLS should be true")
	}
}

func TestConnectInvalidURI(t *testing.T) {
	c := New()
	if err := c.Connect(context.Background(), "not-a-uri"); err == nil {
		t.Error("expected error on invalid URI")
	}
}

func TestServerInfoAndHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			json.NewEncoder(w).Encode(ServerInfo{
				Version: "1.0", Edition: "core",
				Databases: []string{"a", "b"}, Uptime: 42,
			})
		case "/health":
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := newTestClient(srv)
	info, err := c.ServerInfo(context.Background())
	if err != nil {
		t.Fatalf("ServerInfo: %v", err)
	}
	if info.Version != "1.0" || info.Edition != "core" || info.Uptime != 42 {
		t.Errorf("info = %+v", info)
	}
	if len(info.Databases) != 2 {
		t.Errorf("databases len = %d", len(info.Databases))
	}

	if err := c.Health(context.Background()); err != nil {
		t.Errorf("Health: %v", err)
	}
}

func TestQueryPassesDatabaseAndParams(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/db/query" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("method = %q", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type = %q", ct)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(CypherResult{
			Columns:  []string{"n"},
			Rows:     [][]any{{"alice"}},
			RowCount: 1,
		})
	}))
	defer srv.Close()

	c := newTestClient(srv)
	c.database = "mydb"
	res, err := c.Query(context.Background(), "MATCH (n) RETURN n", map[string]any{"k": "v"})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if res.RowCount != 1 {
		t.Errorf("row count = %d", res.RowCount)
	}
	if gotBody["query"] != "MATCH (n) RETURN n" {
		t.Errorf("query = %v", gotBody["query"])
	}
	if gotBody["database"] != "mydb" {
		t.Errorf("database = %v", gotBody["database"])
	}
	if params, ok := gotBody["params"].(map[string]any); !ok || params["k"] != "v" {
		t.Errorf("params = %v", gotBody["params"])
	}
}

func TestQueryOmitsNilParams(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(CypherResult{})
	}))
	defer srv.Close()

	c := newTestClient(srv)
	if _, err := c.Query(context.Background(), "RETURN 1", nil); err != nil {
		t.Fatalf("Query: %v", err)
	}
	if _, has := gotBody["params"]; has {
		t.Error("params should be omitted when nil")
	}
	if _, has := gotBody["database"]; has {
		t.Error("database should be omitted when empty")
	}
}

func TestErrorResponseReturnsAnvilError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("bad query"))
	}))
	defer srv.Close()

	c := newTestClient(srv)
	_, err := c.Query(context.Background(), "RETURN 1", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	ae, ok := err.(*AnvilError)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	if ae.Status != 400 || ae.Body != "bad query" {
		t.Errorf("ae = %+v", ae)
	}
}

func TestAuthHeaderAttachedWhenTokenPresent(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newTestClient(srv)
	c.accessToken = "tok123"
	if err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
	if gotAuth != "Bearer tok123" {
		t.Errorf("Authorization header = %q", gotAuth)
	}
}

func TestUnauthorizedTriggersRefreshAndRetry(t *testing.T) {
	var queryHits int32
	var refreshHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/db/query":
			n := atomic.AddInt32(&queryHits, 1)
			if n == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if r.Header.Get("Authorization") != "Bearer newtok" {
				t.Errorf("retry did not use refreshed token, got %q", r.Header.Get("Authorization"))
			}
			json.NewEncoder(w).Encode(CypherResult{RowCount: 1})
		case "/auth/refresh":
			atomic.AddInt32(&refreshHits, 1)
			json.NewEncoder(w).Encode(loginResponse{
				AccessToken: "newtok", RefreshToken: "newrt",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := newTestClient(srv)
	c.accessToken = "oldtok"
	c.refreshToken = "oldrt"

	res, err := c.Query(context.Background(), "RETURN 1", nil)
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if res.RowCount != 1 {
		t.Errorf("row count = %d", res.RowCount)
	}
	if atomic.LoadInt32(&queryHits) != 2 {
		t.Errorf("query hits = %d, want 2", queryHits)
	}
	if atomic.LoadInt32(&refreshHits) != 1 {
		t.Errorf("refresh hits = %d, want 1", refreshHits)
	}
	if c.accessToken != "newtok" || c.refreshToken != "newrt" {
		t.Errorf("tokens not updated: %q / %q", c.accessToken, c.refreshToken)
	}
}

func TestListDatabases(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/db" {
			t.Errorf("path = %q", r.URL.Path)
		}
		json.NewEncoder(w).Encode([]string{"default", "analytics"})
	}))
	defer srv.Close()

	dbs, err := newTestClient(srv).ListDatabases(context.Background())
	if err != nil {
		t.Fatalf("ListDatabases: %v", err)
	}
	if len(dbs) != 2 || dbs[0] != "default" {
		t.Errorf("dbs = %v", dbs)
	}
}

func TestListEventsBuildsQueryString(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		json.NewEncoder(w).Encode(EventsResponse{Count: 0, Total: 0})
	}))
	defer srv.Close()

	c := newTestClient(srv)
	if _, err := c.ListEvents(context.Background(), "audit", "foo", 10); err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if !strings.Contains(gotQuery, "type=audit") ||
		!strings.Contains(gotQuery, "name=foo") ||
		!strings.Contains(gotQuery, "limit=10") {
		t.Errorf("query = %q", gotQuery)
	}
}
