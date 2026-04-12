package anvilent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// Client is an HTTP client for the Anvil DB REST API.
// It is safe for concurrent use by multiple goroutines.
type Client struct {
	baseURL    string
	httpClient *http.Client
	useTLS     bool
	database   string

	// auth state
	mu           sync.RWMutex
	username     string
	password     string
	accessToken  string
	refreshToken string
}

// New creates a new Anvil DB client with the given options.
// Call Connect to establish a connection to the server.
func New(opts ...Option) *Client {
	c := &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// Connect parses an anvil:// or anvil+tls:// URI and configures the client.
// If the URI contains credentials, the client will automatically log in.
func (c *Client) Connect(ctx context.Context, uri string) error {
	info, err := ParseURI(uri)
	if err != nil {
		return err
	}

	scheme := "http"
	if info.TLS || c.useTLS {
		scheme = "https"
		c.useTLS = true
	}
	c.baseURL = fmt.Sprintf("%s://%s:%s", scheme, info.Host, info.Port)
	c.database = info.Database

	if info.Username != "" {
		c.username = info.Username
		c.password = info.Password
		if err := c.Login(ctx, info.Username, info.Password); err != nil {
			return fmt.Errorf("anvilent: auto-login failed: %w", err)
		}
	}

	return nil
}

// ServerInfo returns information about the connected Anvil DB server.
func (c *Client) ServerInfo(ctx context.Context) (*ServerInfo, error) {
	var info ServerInfo
	if err := c.doJSON(ctx, http.MethodGet, "/", nil, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

// Health checks the health of the Anvil DB server. Returns nil if healthy.
func (c *Client) Health(ctx context.Context) error {
	return c.doJSON(ctx, http.MethodGet, "/health", nil, nil)
}

// Query executes a Cypher query against the server.
// The params map is optional and may be nil.
func (c *Client) Query(ctx context.Context, query string, params map[string]any) (*CypherResult, error) {
	body := map[string]any{"query": query}
	if params != nil {
		body["params"] = params
	}
	if c.database != "" {
		body["database"] = c.database
	}
	var result CypherResult
	if err := c.doJSON(ctx, http.MethodPost, "/db/query", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GraphQL executes a GraphQL query against the server.
func (c *Client) GraphQL(ctx context.Context, query string, variables map[string]any, operationName string) (*GraphQLResponse, error) {
	body := map[string]any{"query": query}
	if variables != nil {
		body["variables"] = variables
	}
	if operationName != "" {
		body["operationName"] = operationName
	}
	var result GraphQLResponse
	if err := c.doJSON(ctx, http.MethodPost, "/graphql", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ListDatabases returns the names of all databases on the server.
func (c *Client) ListDatabases(ctx context.Context) ([]string, error) {
	var dbs []string
	if err := c.doJSON(ctx, http.MethodGet, "/db", nil, &dbs); err != nil {
		return nil, err
	}
	return dbs, nil
}

// GetSchema returns the schema for the named database.
func (c *Client) GetSchema(ctx context.Context, name string) (any, error) {
	var schema any
	if err := c.doJSON(ctx, http.MethodGet, "/db/"+name+"/schema", nil, &schema); err != nil {
		return nil, err
	}
	return schema, nil
}

// GetGraph returns the graph structure for the named database.
func (c *Client) GetGraph(ctx context.Context, name string) (any, error) {
	var graph any
	if err := c.doJSON(ctx, http.MethodGet, "/db/"+name+"/graph", nil, &graph); err != nil {
		return nil, err
	}
	return graph, nil
}

// ImportCypher imports a Cypher script into the server.
func (c *Client) ImportCypher(ctx context.Context, script string) (*CypherResult, error) {
	body := map[string]any{"script": script}
	var result CypherResult
	if err := c.doJSON(ctx, http.MethodPost, "/db/import/cypher", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Stats returns server-wide statistics.
func (c *Client) Stats(ctx context.Context) (*StatsResponse, error) {
	var stats StatsResponse
	if err := c.doJSON(ctx, http.MethodGet, "/admin/stats", nil, &stats); err != nil {
		return nil, err
	}
	return &stats, nil
}

// ListUsers returns all registered users.
func (c *Client) ListUsers(ctx context.Context) ([]User, error) {
	var users []User
	if err := c.doJSON(ctx, http.MethodGet, "/admin/users", nil, &users); err != nil {
		return nil, err
	}
	return users, nil
}

// ListRoles returns all authorization roles.
func (c *Client) ListRoles(ctx context.Context) ([]Role, error) {
	var roles []Role
	if err := c.doJSON(ctx, http.MethodGet, "/admin/roles", nil, &roles); err != nil {
		return nil, err
	}
	return roles, nil
}

// ListEvents returns audit/system events with optional filtering.
func (c *Client) ListEvents(ctx context.Context, eventType, name string, limit int) (*EventsResponse, error) {
	path := "/admin/events?"
	sep := ""
	if eventType != "" {
		path += sep + "type=" + eventType
		sep = "&"
	}
	if name != "" {
		path += sep + "name=" + name
		sep = "&"
	}
	if limit > 0 {
		path += sep + fmt.Sprintf("limit=%d", limit)
	}
	var events EventsResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &events); err != nil {
		return nil, err
	}
	return &events, nil
}

// doJSON performs an HTTP request and decodes the JSON response.
// It handles token attachment and automatic 401 refresh+retry.
func (c *Client) doJSON(ctx context.Context, method, path string, reqBody any, respBody any) error {
	resp, err := c.doRequest(ctx, method, path, reqBody)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// On 401, attempt token refresh and retry once.
	if resp.StatusCode == http.StatusUnauthorized {
		resp.Body.Close()
		if refreshErr := c.doRefreshToken(ctx); refreshErr == nil {
			resp, err = c.doRequest(ctx, method, path, reqBody)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
		}
	}

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return &AnvilError{
			Status:     resp.StatusCode,
			StatusText: http.StatusText(resp.StatusCode),
			Body:       string(body),
		}
	}

	if respBody != nil {
		return json.NewDecoder(resp.Body).Decode(respBody)
	}
	return nil
}

// doRequest builds and executes a single HTTP request with auth headers.
func (c *Client) doRequest(ctx context.Context, method, path string, reqBody any) (*http.Response, error) {
	var bodyReader io.Reader
	if reqBody != nil {
		data, err := json.Marshal(reqBody)
		if err != nil {
			return nil, fmt.Errorf("anvilent: marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("anvilent: create request: %w", err)
	}

	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	c.mu.RLock()
	token := c.accessToken
	c.mu.RUnlock()
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	return c.httpClient.Do(req)
}
