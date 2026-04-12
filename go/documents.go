package anvilent

import (
	"context"
	"fmt"
	"net/http"
)

// ListCollections returns all document collections.
func (c *Client) ListCollections(ctx context.Context) ([]Collection, error) {
	var cols []Collection
	if err := c.doJSON(ctx, http.MethodGet, "/docs", nil, &cols); err != nil {
		return nil, err
	}
	return cols, nil
}

// CreateCollection creates a new document collection with the given name.
// The body map may contain additional collection options (e.g. composite_keys, default_ttl_ms).
func (c *Client) CreateCollection(ctx context.Context, name string, body map[string]any) (*Collection, error) {
	var col Collection
	if err := c.doJSON(ctx, http.MethodPost, "/docs/"+name, body, &col); err != nil {
		return nil, err
	}
	return &col, nil
}

// DropCollection deletes a collection and all its documents.
func (c *Client) DropCollection(ctx context.Context, name string) error {
	return c.doJSON(ctx, http.MethodDelete, "/docs/"+name, nil, nil)
}

// GetDocument retrieves a single document by collection name and document ID.
func (c *Client) GetDocument(ctx context.Context, collection string, id string) (*Document, error) {
	var doc Document
	if err := c.doJSON(ctx, http.MethodGet, "/docs/"+collection+"/"+id, nil, &doc); err != nil {
		return nil, err
	}
	return &doc, nil
}

// PutDocument creates or updates a document in the given collection.
// The body is stored as the document content.
func (c *Client) PutDocument(ctx context.Context, collection string, id string, body map[string]any) (*Document, error) {
	var doc Document
	if err := c.doJSON(ctx, http.MethodPut, "/docs/"+collection+"/"+id, body, &doc); err != nil {
		return nil, err
	}
	return &doc, nil
}

// DeleteDocument removes a document from a collection.
func (c *Client) DeleteDocument(ctx context.Context, collection string, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/docs/"+collection+"/"+id, nil, nil)
}

// QueryDocuments runs a query against a document collection.
func (c *Client) QueryDocuments(ctx context.Context, collection string, query *DocumentQuery) (*DocumentQueryResult, error) {
	var result DocumentQueryResult
	if err := c.doJSON(ctx, http.MethodPost, "/docs/"+collection+"/query", query, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ScanDocuments iterates over documents in a collection with optional pagination.
// Pass an empty cursor to start from the beginning.
func (c *Client) ScanDocuments(ctx context.Context, collection string, limit int, cursor string) (*DocumentQueryResult, error) {
	path := "/docs/" + collection + "/scan?"
	sep := ""
	if limit > 0 {
		path += fmt.Sprintf("limit=%d", limit)
		sep = "&"
	}
	if cursor != "" {
		path += sep + "cursor=" + cursor
	}
	var result DocumentQueryResult
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// BatchDocuments executes a batch of document operations against a collection.
// The operations slice should contain maps describing each operation.
func (c *Client) BatchDocuments(ctx context.Context, collection string, operations []map[string]any) (any, error) {
	body := map[string]any{"operations": operations}
	var result any
	if err := c.doJSON(ctx, http.MethodPost, "/docs/"+collection+"/batch", body, &result); err != nil {
		return nil, err
	}
	return result, nil
}
