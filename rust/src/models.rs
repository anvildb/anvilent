//! Request and response types for the Anvil DB REST API.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/// Server information returned by `GET /`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerInfo {
    /// Server version string.
    pub version: String,
    /// Server edition (e.g. "community", "enterprise").
    pub edition: String,
    /// List of available databases.
    pub databases: Vec<String>,
    /// Server uptime as a human-readable string.
    pub uptime: String,
}

/// Health check response from `GET /health`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HealthResponse {
    /// Current health status.
    pub status: String,
}

/// Request body for `POST /db/query`.
#[derive(Debug, Clone, Serialize)]
pub struct CypherRequest {
    /// The Cypher query string.
    pub query: String,
    /// Optional query parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// Optional target database name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
}

/// Result of a Cypher query from `POST /db/query`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypherResult {
    /// Column names in the result set.
    pub columns: Vec<String>,
    /// Row data as JSON arrays.
    pub rows: Vec<Vec<Value>>,
    /// Number of rows returned.
    pub row_count: u64,
    /// Query execution time in milliseconds.
    pub execution_time_ms: f64,
}

/// Response from `GET /db`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DatabasesResponse {
    /// List of database names.
    pub databases: Vec<String>,
}

/// Graph data from `GET /db/{name}/graph`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GraphData {
    /// Nodes in the graph.
    pub nodes: Value,
    /// Edges in the graph.
    pub edges: Value,
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Request body for `POST /auth/login`.
#[derive(Debug, Clone, Serialize)]
pub struct LoginRequest {
    /// Username.
    pub username: String,
    /// Password.
    pub password: String,
}

/// Response from `POST /auth/login` and `POST /auth/refresh`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokens {
    /// JWT access token.
    pub access_token: String,
    /// Refresh token for obtaining new access tokens.
    pub refresh_token: String,
    /// ID token.
    pub id_token: String,
    /// Whether the user must change their password.
    #[serde(default)]
    pub must_change_password: bool,
}

/// Request body for `POST /auth/refresh`.
#[derive(Debug, Clone, Serialize)]
pub struct RefreshRequest {
    /// The refresh token.
    pub refresh_token: String,
}

/// Request body for `POST /auth/register`.
#[derive(Debug, Clone, Serialize)]
pub struct RegisterRequest {
    /// Username for the new account.
    pub username: String,
    /// Email address.
    pub email: String,
    /// Password.
    pub password: String,
    /// Roles to assign.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
}

/// Request body for `POST /auth/change-password`.
#[derive(Debug, Clone, Serialize)]
pub struct ChangePasswordRequest {
    /// Current password.
    pub current_password: String,
    /// New password.
    pub new_password: String,
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// A document collection.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Collection {
    /// Collection name.
    pub name: String,
    /// Collection ID.
    pub id: String,
    /// Composite key fields, if any.
    #[serde(default)]
    pub composite_keys: Vec<String>,
    /// Default time-to-live in milliseconds, if set.
    pub default_ttl_ms: Option<u64>,
}

/// Request body for creating a collection via `POST /docs/{collection}`.
#[derive(Debug, Clone, Serialize, Default)]
pub struct CreateCollectionRequest {
    /// Optional composite key fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composite_keys: Option<Vec<String>>,
    /// Optional default TTL in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_ttl_ms: Option<u64>,
}

/// A single document.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Document {
    /// Document ID.
    pub id: String,
    /// Collection the document belongs to.
    pub collection: String,
    /// Document key.
    pub key: String,
    /// Document body as arbitrary JSON.
    pub body: Value,
    /// Expiration timestamp, if set.
    pub expires_at: Option<String>,
    /// Creation timestamp.
    pub created_at: String,
    /// Last update timestamp.
    pub updated_at: String,
    /// Document version (for optimistic concurrency).
    pub version: u64,
}

/// Request body for `PUT /docs/{collection}/{id}`.
#[derive(Debug, Clone, Serialize)]
pub struct PutDocumentRequest {
    /// Document body.
    pub body: Value,
    /// Optional TTL in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<u64>,
    /// If true, only insert if the document does not already exist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_not_exists: Option<bool>,
}

/// Query body for `POST /docs/{collection}/query`.
#[derive(Debug, Clone, Serialize, Default)]
pub struct DocumentQuery {
    /// Filter conditions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<Value>,
    /// Fields to project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection: Option<Vec<String>>,
    /// Sort order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<Value>,
    /// Maximum number of documents to return.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// Cursor for pagination.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Result of a document query or scan.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DocumentQueryResult {
    /// Matching documents.
    pub documents: Vec<Document>,
    /// Number of documents returned.
    pub count: u64,
    /// Pagination cursor for the next page, if any.
    pub cursor: Option<String>,
}

/// A single batch operation.
#[derive(Debug, Clone, Serialize)]
pub struct BatchOperation {
    /// Operation type (e.g. "put", "delete").
    pub op: String,
    /// Document ID.
    pub id: String,
    /// Document body (for put operations).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
    /// Optional TTL in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<u64>,
}

/// Request body for `POST /docs/{collection}/batch`.
#[derive(Debug, Clone, Serialize)]
pub struct BatchRequest {
    /// List of operations to perform.
    pub operations: Vec<BatchOperation>,
}

/// Result of a batch operation.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BatchResult {
    /// Results for each operation.
    pub results: Value,
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/// Server statistics from `GET /admin/stats`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StatsResponse {
    /// Arbitrary stats as JSON.
    #[serde(flatten)]
    pub data: Value,
}

/// A user record from `GET /admin/users`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct User {
    /// Username.
    pub username: String,
    /// Email address.
    #[serde(default)]
    pub email: Option<String>,
    /// Assigned roles.
    #[serde(default)]
    pub roles: Vec<String>,
    /// Additional fields.
    #[serde(flatten)]
    pub extra: Value,
}

/// A role record from `GET /admin/roles`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Role {
    /// Role name.
    pub name: String,
    /// Additional fields.
    #[serde(flatten)]
    pub extra: Value,
}

/// Response from `GET /admin/events`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EventsResponse {
    /// List of events.
    pub events: Vec<Value>,
    /// Number of events returned.
    pub count: u64,
    /// Total number of matching events.
    pub total: u64,
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

/// Request body for `POST /graphql`.
#[derive(Debug, Clone, Serialize)]
pub struct GraphQLRequest {
    /// The GraphQL query string.
    pub query: String,
    /// Optional variables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variables: Option<Value>,
    /// Optional operation name.
    #[serde(rename = "operationName", skip_serializing_if = "Option::is_none")]
    pub operation_name: Option<String>,
}

/// Response from `POST /graphql`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GraphQLResponse {
    /// Query result data.
    pub data: Option<Value>,
    /// Errors, if any.
    pub errors: Option<Vec<Value>>,
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Request body for `POST /db/import/cypher`.
#[derive(Debug, Clone, Serialize)]
pub struct ImportCypherRequest {
    /// The Cypher script to import.
    pub script: String,
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/// Response from `POST /db/transaction/begin`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionBeginResponse {
    /// The transaction ID.
    pub tx_id: String,
}

/// Request body for a query within a transaction.
#[derive(Debug, Clone, Serialize)]
pub struct TransactionQueryRequest {
    /// The Cypher query string.
    pub query: String,
    /// Optional query parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}
