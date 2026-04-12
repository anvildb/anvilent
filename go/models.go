package anvilent

// CypherResult represents the result of a Cypher query execution.
type CypherResult struct {
	Columns         []string `json:"columns"`
	Rows            [][]any  `json:"rows"`
	RowCount        int      `json:"row_count"`
	ExecutionTimeMs float64  `json:"execution_time_ms"`
}

// ServerInfo describes the connected Anvil DB server.
type ServerInfo struct {
	Version   string   `json:"version"`
	Edition   string   `json:"edition"`
	Databases []string `json:"databases"`
	Uptime    int      `json:"uptime"`
}

// Collection represents a document collection in Anvil DB.
type Collection struct {
	Name          string `json:"name"`
	ID            int    `json:"id"`
	CompositeKeys bool   `json:"composite_keys"`
	DefaultTTLMs  *int   `json:"default_ttl_ms,omitempty"`
}

// Document represents a single document stored in a collection.
type Document struct {
	ID         int            `json:"id"`
	Collection string         `json:"collection"`
	Key        string         `json:"key"`
	Body       map[string]any `json:"body"`
	ExpiresAt  *int           `json:"expires_at,omitempty"`
	CreatedAt  *int           `json:"created_at,omitempty"`
	UpdatedAt  *int           `json:"updated_at,omitempty"`
	Version    int            `json:"version"`
}

// DocumentQuery describes a query against a document collection.
type DocumentQuery struct {
	Filter       any    `json:"filter,omitempty"`
	PartitionKey string `json:"partition_key,omitempty"`
	SortKeyStart string `json:"sort_key_start,omitempty"`
	Limit        int    `json:"limit,omitempty"`
	Cursor       string `json:"cursor,omitempty"`
}

// DocumentQueryResult is the response from a document query or scan.
type DocumentQueryResult struct {
	Documents []Document `json:"documents"`
	Count     int        `json:"count"`
	Cursor    string     `json:"cursor,omitempty"`
}

// GraphQLResponse represents the result of a GraphQL query.
type GraphQLResponse struct {
	Data   any            `json:"data"`
	Errors []GraphQLError `json:"errors,omitempty"`
}

// GraphQLError is a single error returned from a GraphQL query.
type GraphQLError struct {
	Message string `json:"message"`
}

// StatsResponse contains server-wide statistics.
type StatsResponse struct {
	NodeCount         int `json:"node_count"`
	RelationshipCount int `json:"relationship_count"`
	CollectionCount   int `json:"collection_count"`
	DocumentCount     int `json:"document_count"`
	UptimeSeconds     int `json:"uptime_seconds"`
	SyncRules         int `json:"sync_rules"`
	RlsPolicies       int `json:"rls_policies"`
}

// User represents a registered user account.
type User struct {
	Username           string   `json:"username"`
	Roles              []string `json:"roles"`
	MustChangePassword bool     `json:"must_change_password"`
}

// Role represents an authorization role.
type Role struct {
	Name       string   `json:"name"`
	Privileges []string `json:"privileges"`
}

// EventEntry represents a single audit or system event.
type EventEntry struct {
	ID         int               `json:"id"`
	Timestamp  int               `json:"timestamp"`
	Type       string            `json:"type"`
	Name       string            `json:"name"`
	DurationMs float64           `json:"duration_ms"`
	Success    bool              `json:"success"`
	Error      string            `json:"error,omitempty"`
	User       string            `json:"user,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

// EventsResponse wraps a list of events with pagination info.
type EventsResponse struct {
	Events []EventEntry `json:"events"`
	Count  int          `json:"count"`
	Total  int          `json:"total"`
}
