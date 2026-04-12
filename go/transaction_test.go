package anvilent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTransactionLifecycle(t *testing.T) {
	var beginHit, queryHit, commitHit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/db/transaction/begin":
			beginHit = true
			json.NewEncoder(w).Encode(beginTxResponse{TxID: "tx-42"})
		case "/db/transaction/tx-42/query":
			queryHit = true
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["query"] != "RETURN 1" {
				t.Errorf("query = %v", body["query"])
			}
			json.NewEncoder(w).Encode(CypherResult{RowCount: 1})
		case "/db/transaction/tx-42/commit":
			commitHit = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := newTestClient(srv)
	ctx := context.Background()

	tx, err := c.BeginTx(ctx)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	if tx.id != "tx-42" {
		t.Errorf("tx.id = %q", tx.id)
	}

	res, err := tx.Query(ctx, "RETURN 1", nil)
	if err != nil {
		t.Fatalf("tx.Query: %v", err)
	}
	if res.RowCount != 1 {
		t.Errorf("row count = %d", res.RowCount)
	}

	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if !beginHit || !queryHit || !commitHit {
		t.Errorf("hits begin=%v query=%v commit=%v", beginHit, queryHit, commitHit)
	}
}

func TestTransactionRollback(t *testing.T) {
	var rollbackHit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/db/transaction/begin":
			json.NewEncoder(w).Encode(beginTxResponse{TxID: "tx-1"})
		case "/db/transaction/tx-1/rollback":
			rollbackHit = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := newTestClient(srv)
	tx, err := c.BeginTx(context.Background())
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	if err := tx.Rollback(context.Background()); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if !rollbackHit {
		t.Error("rollback endpoint not hit")
	}
}
