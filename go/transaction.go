package anvilent

import (
	"context"
	"net/http"
)

// Tx represents an open server-side transaction.
// Use Query to execute statements within the transaction,
// then call Commit or Rollback to finalize it.
type Tx struct {
	client *Client
	id     string
}

// beginTxResponse is the internal response from the begin transaction endpoint.
type beginTxResponse struct {
	TxID string `json:"tx_id"`
}

// BeginTx starts a new server-side transaction and returns a Tx handle.
func (c *Client) BeginTx(ctx context.Context) (*Tx, error) {
	var resp beginTxResponse
	if err := c.doJSON(ctx, http.MethodPost, "/db/transaction/begin", nil, &resp); err != nil {
		return nil, err
	}
	return &Tx{client: c, id: resp.TxID}, nil
}

// Query executes a Cypher query within the transaction.
func (tx *Tx) Query(ctx context.Context, query string, params map[string]any) (*CypherResult, error) {
	body := map[string]any{"query": query}
	if params != nil {
		body["params"] = params
	}
	var result CypherResult
	if err := tx.client.doJSON(ctx, http.MethodPost, "/db/transaction/"+tx.id+"/query", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Commit finalizes the transaction, making all changes permanent.
func (tx *Tx) Commit(ctx context.Context) error {
	return tx.client.doJSON(ctx, http.MethodPost, "/db/transaction/"+tx.id+"/commit", nil, nil)
}

// Rollback aborts the transaction, discarding all changes.
func (tx *Tx) Rollback(ctx context.Context) error {
	return tx.client.doJSON(ctx, http.MethodPost, "/db/transaction/"+tx.id+"/rollback", nil, nil)
}
