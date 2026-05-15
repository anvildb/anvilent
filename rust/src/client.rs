//! The main Anvil DB client.

use std::sync::Arc;

use reqwest::header::HeaderMap;
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::error::{AnvilError, AnvilResult};
use crate::models::*;
use crate::uri::AnvilUri;

// ---------------------------------------------------------------------------
// Internal shared state
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct TokenState {
    access_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Debug)]
struct Inner {
    http: Client,
    base_url: String,
    default_database: Option<String>,
    tokens: RwLock<TokenState>,
}

// ---------------------------------------------------------------------------
// AnvilClient
// ---------------------------------------------------------------------------

/// Client for interacting with an Anvil DB server.
///
/// The client is cheaply cloneable (backed by `Arc`) and safe to share across
/// tasks. Tokens are managed internally and refreshed automatically on 401.
///
/// # Example
///
/// ```no_run
/// # async fn example() -> anvilent::AnvilResult<()> {
/// let client = anvilent::AnvilClient::connect("anvil://admin:password@localhost:7474/mydb").await?;
/// let result = client.query("MATCH (n) RETURN n LIMIT 10", None).await?;
/// println!("{:?}", result.columns);
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Debug)]
pub struct AnvilClient {
    inner: Arc<Inner>,
}

impl AnvilClient {
    /// Connect to an Anvil DB server using a connection URI.
    ///
    /// Supported URI schemes:
    /// - `anvil://[user:pass@]host[:port][/database]` — plain HTTP
    /// - `anvil+tls://[user:pass@]host[:port][/database]` — HTTPS
    ///
    /// If the URI contains credentials, the client will automatically log in
    /// and store the resulting tokens.
    pub async fn connect(uri: &str) -> AnvilResult<Self> {
        let parsed = AnvilUri::parse(uri)?;
        let base_url = parsed.base_url();

        let http = Client::builder()
            .build()
            .map_err(AnvilError::Http)?;

        let client = Self {
            inner: Arc::new(Inner {
                http,
                base_url,
                default_database: parsed.database.clone(),
                tokens: RwLock::new(TokenState {
                    access_token: None,
                    refresh_token: None,
                }),
            }),
        };

        // Auto-login if credentials are present.
        if let (Some(username), Some(password)) = (parsed.username, parsed.password) {
            client.login(&username, &password).await?;
        }

        Ok(client)
    }

    /// Create a client from an explicit base URL (e.g. `http://localhost:7474`)
    /// without parsing an `anvil://` URI.
    pub fn from_base_url(base_url: &str) -> AnvilResult<Self> {
        let base_url = base_url.trim_end_matches('/').to_string();

        let http = Client::builder()
            .build()
            .map_err(AnvilError::Http)?;

        Ok(Self {
            inner: Arc::new(Inner {
                http,
                base_url,
                default_database: None,
                tokens: RwLock::new(TokenState {
                    access_token: None,
                    refresh_token: None,
                }),
            }),
        })
    }

    /// Set the bearer token directly (e.g. if you already have one).
    pub async fn set_token(&self, access_token: String, refresh_token: Option<String>) {
        let mut tokens = self.inner.tokens.write().await;
        tokens.access_token = Some(access_token);
        tokens.refresh_token = refresh_token;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}{path}", self.inner.base_url)
        }
    }

    /// Base URL the client was constructed with. Used by the storage
    /// namespace to build absolute public / signed URLs without re-parsing.
    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    /// Send a JSON-bodied request and return the raw `Response` so callers
    /// can branch on status before deserializing. Inherits the same
    /// `Authorization` header + 401 retry behavior as the other helpers.
    pub(crate) async fn send_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        extra_headers: Option<HeaderMap>,
    ) -> AnvilResult<Response> {
        let url = self.url(path);
        let method_for_build = method.clone();
        let body_for_build = body.clone();
        let headers_for_build = extra_headers.clone();
        self.send_with_retry(move || {
            let mut req = self.inner.http.request(method_for_build.clone(), url.clone());
            if let Some(ref h) = headers_for_build {
                req = req.headers(h.clone());
            }
            if let Some(ref b) = body_for_build {
                req = req.json(b);
            }
            req
        })
        .await
    }

    /// Send a raw-bytes request and return the raw `Response`. The
    /// `Content-Type` is whatever the caller sets in `extra_headers` — we
    /// don't inject JSON-ness here.
    pub(crate) async fn send_bytes(
        &self,
        method: Method,
        path: &str,
        body: Vec<u8>,
        extra_headers: Option<HeaderMap>,
    ) -> AnvilResult<Response> {
        let url = self.url(path);
        let method_for_build = method.clone();
        let headers_for_build = extra_headers.clone();
        // Buffer the body so the retry closure can hand the same bytes to
        // both attempts. Cheap clones via Vec<u8>::clone().
        let body_for_build = body;
        self.send_with_retry(move || {
            let mut req = self.inner.http.request(method_for_build.clone(), url.clone());
            if let Some(ref h) = headers_for_build {
                req = req.headers(h.clone());
            }
            req = req.body(body_for_build.clone());
            req
        })
        .await
    }

    async fn apply_auth(&self, req: RequestBuilder) -> RequestBuilder {
        let tokens = self.inner.tokens.read().await;
        if let Some(ref token) = tokens.access_token {
            req.bearer_auth(token)
        } else {
            req
        }
    }

    /// Send a request, and on 401 attempt a token refresh then retry once.
    async fn send_with_retry(
        &self,
        build: impl Fn() -> RequestBuilder,
    ) -> AnvilResult<Response> {
        let req = self.apply_auth(build()).await;
        let resp = req.send().await.map_err(AnvilError::Http)?;

        if resp.status() == StatusCode::UNAUTHORIZED {
            // Try refreshing.
            if self.try_refresh().await.is_ok() {
                let req = self.apply_auth(build()).await;
                let resp = req.send().await.map_err(AnvilError::Http)?;
                return Ok(resp);
            }
        }

        Ok(resp)
    }

    /// Attempt to refresh the access token using the stored refresh token.
    async fn try_refresh(&self) -> AnvilResult<()> {
        let refresh_token = {
            let tokens = self.inner.tokens.read().await;
            tokens
                .refresh_token
                .clone()
                .ok_or_else(|| AnvilError::RefreshFailed("No refresh token available".into()))?
        };

        let resp = self
            .inner
            .http
            .post(self.url("/auth/refresh"))
            .json(&RefreshRequest {
                refresh_token,
            })
            .send()
            .await
            .map_err(AnvilError::Http)?;

        if !resp.status().is_success() {
            return Err(AnvilError::RefreshFailed(format!(
                "Refresh returned {}",
                resp.status()
            )));
        }

        let auth: AuthTokens = resp.json().await.map_err(AnvilError::Http)?;
        let mut tokens = self.inner.tokens.write().await;
        tokens.access_token = Some(auth.access_token);
        tokens.refresh_token = Some(auth.refresh_token);
        Ok(())
    }

    /// Check a response status and return an error for non-success codes.
    async fn check(resp: Response) -> AnvilResult<Response> {
        if resp.status().is_success() {
            Ok(resp)
        } else {
            let status = resp.status().as_u16();
            let message = resp.text().await.unwrap_or_default();
            Err(AnvilError::Server { status, message })
        }
    }

    /// Send, check status, and deserialize JSON.
    async fn request_json<T: DeserializeOwned>(
        &self,
        build: impl Fn() -> RequestBuilder,
    ) -> AnvilResult<T> {
        let resp = self.send_with_retry(&build).await?;
        let resp = Self::check(resp).await?;
        resp.json::<T>().await.map_err(AnvilError::Http)
    }

    // -----------------------------------------------------------------------
    // Core endpoints
    // -----------------------------------------------------------------------

    /// Retrieve server information.
    pub async fn server_info(&self) -> AnvilResult<ServerInfo> {
        self.request_json(|| self.inner.http.get(self.url("/")))
            .await
    }

    /// Check server health.
    pub async fn health(&self) -> AnvilResult<HealthResponse> {
        self.request_json(|| self.inner.http.get(self.url("/health")))
            .await
    }

    /// Execute a Cypher query.
    ///
    /// If no database is specified in `params`, the default database from the
    /// connection URI is used.
    pub async fn query(
        &self,
        query: &str,
        params: Option<Value>,
    ) -> AnvilResult<CypherResult> {
        let database = self.inner.default_database.clone();
        self.query_db(query, params, database).await
    }

    /// Execute a Cypher query against a specific database.
    pub async fn query_db(
        &self,
        query: &str,
        params: Option<Value>,
        database: Option<String>,
    ) -> AnvilResult<CypherResult> {
        let body = CypherRequest {
            query: query.to_string(),
            params,
            database,
        };
        self.request_json(|| self.inner.http.post(self.url("/db/query")).json(&body))
            .await
    }

    /// List all databases.
    pub async fn databases(&self) -> AnvilResult<Vec<String>> {
        let resp: DatabasesResponse =
            self.request_json(|| self.inner.http.get(self.url("/db"))).await?;
        Ok(resp.databases)
    }

    /// Get the schema for a database.
    pub async fn schema(&self, database: &str) -> AnvilResult<Value> {
        self.request_json(|| {
            self.inner
                .http
                .get(self.url(&format!("/db/{database}/schema")))
        })
        .await
    }

    /// Get the full graph data (nodes and edges) for a database.
    pub async fn graph(&self, database: &str) -> AnvilResult<GraphData> {
        self.request_json(|| {
            self.inner
                .http
                .get(self.url(&format!("/db/{database}/graph")))
        })
        .await
    }

    // -----------------------------------------------------------------------
    // GraphQL
    // -----------------------------------------------------------------------

    /// Execute a GraphQL query.
    pub async fn graphql(
        &self,
        query: &str,
        variables: Option<Value>,
        operation_name: Option<&str>,
    ) -> AnvilResult<GraphQLResponse> {
        let body = GraphQLRequest {
            query: query.to_string(),
            variables,
            operation_name: operation_name.map(String::from),
        };
        self.request_json(|| self.inner.http.post(self.url("/graphql")).json(&body))
            .await
    }

    // -----------------------------------------------------------------------
    // Auth
    // -----------------------------------------------------------------------

    /// Log in with username and password. Stores the resulting tokens.
    pub async fn login(&self, username: &str, password: &str) -> AnvilResult<AuthTokens> {
        let body = LoginRequest {
            username: username.to_string(),
            password: password.to_string(),
        };

        let resp = self
            .inner
            .http
            .post(self.url("/auth/login"))
            .json(&body)
            .send()
            .await
            .map_err(AnvilError::Http)?;

        let resp = Self::check(resp).await?;
        let auth: AuthTokens = resp.json().await.map_err(AnvilError::Http)?;

        {
            let mut tokens = self.inner.tokens.write().await;
            tokens.access_token = Some(auth.access_token.clone());
            tokens.refresh_token = Some(auth.refresh_token.clone());
        }

        Ok(auth)
    }

    /// Refresh the access token using the stored refresh token.
    pub async fn refresh(&self) -> AnvilResult<AuthTokens> {
        let refresh_token = {
            let tokens = self.inner.tokens.read().await;
            tokens
                .refresh_token
                .clone()
                .ok_or_else(|| AnvilError::RefreshFailed("No refresh token available".into()))?
        };

        let body = RefreshRequest { refresh_token };
        let resp = self
            .inner
            .http
            .post(self.url("/auth/refresh"))
            .json(&body)
            .send()
            .await
            .map_err(AnvilError::Http)?;

        let resp = Self::check(resp).await?;
        let auth: AuthTokens = resp.json().await.map_err(AnvilError::Http)?;

        {
            let mut tokens = self.inner.tokens.write().await;
            tokens.access_token = Some(auth.access_token.clone());
            tokens.refresh_token = Some(auth.refresh_token.clone());
        }

        Ok(auth)
    }

    /// Register a new user.
    pub async fn register(
        &self,
        username: &str,
        email: &str,
        password: &str,
        roles: Option<Vec<String>>,
    ) -> AnvilResult<Value> {
        let body = RegisterRequest {
            username: username.to_string(),
            email: email.to_string(),
            password: password.to_string(),
            roles,
        };
        self.request_json(|| self.inner.http.post(self.url("/auth/register")).json(&body))
            .await
    }

    /// Change the current user's password.
    pub async fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> AnvilResult<()> {
        let body = ChangePasswordRequest {
            current_password: current_password.to_string(),
            new_password: new_password.to_string(),
        };
        let resp = self
            .send_with_retry(|| {
                self.inner
                    .http
                    .post(self.url("/auth/change-password"))
                    .json(&body)
            })
            .await?;
        Self::check(resp).await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Documents
    // -----------------------------------------------------------------------

    /// List all document collections.
    pub async fn collections(&self) -> AnvilResult<Vec<Collection>> {
        self.request_json(|| self.inner.http.get(self.url("/docs")))
            .await
    }

    /// Create a new document collection.
    pub async fn create_collection(
        &self,
        name: &str,
        opts: CreateCollectionRequest,
    ) -> AnvilResult<Collection> {
        self.request_json(|| {
            self.inner
                .http
                .post(self.url(&format!("/docs/{name}")))
                .json(&opts)
        })
        .await
    }

    /// Delete a document collection.
    pub async fn delete_collection(&self, name: &str) -> AnvilResult<()> {
        let resp = self
            .send_with_retry(|| {
                self.inner
                    .http
                    .delete(self.url(&format!("/docs/{name}")))
            })
            .await?;
        Self::check(resp).await?;
        Ok(())
    }

    /// Get a single document by collection and ID.
    pub async fn get_document(
        &self,
        collection: &str,
        id: &str,
    ) -> AnvilResult<Document> {
        self.request_json(|| {
            self.inner
                .http
                .get(self.url(&format!("/docs/{collection}/{id}")))
        })
        .await
    }

    /// Put (create or update) a document.
    pub async fn put_document(
        &self,
        collection: &str,
        id: &str,
        request: PutDocumentRequest,
    ) -> AnvilResult<Document> {
        self.request_json(|| {
            self.inner
                .http
                .put(self.url(&format!("/docs/{collection}/{id}")))
                .json(&request)
        })
        .await
    }

    /// Delete a document.
    pub async fn delete_document(
        &self,
        collection: &str,
        id: &str,
    ) -> AnvilResult<()> {
        let resp = self
            .send_with_retry(|| {
                self.inner
                    .http
                    .delete(self.url(&format!("/docs/{collection}/{id}")))
            })
            .await?;
        Self::check(resp).await?;
        Ok(())
    }

    /// Query documents in a collection.
    pub async fn query_documents(
        &self,
        collection: &str,
        query: DocumentQuery,
    ) -> AnvilResult<DocumentQueryResult> {
        self.request_json(|| {
            self.inner
                .http
                .post(self.url(&format!("/docs/{collection}/query")))
                .json(&query)
        })
        .await
    }

    /// Scan documents in a collection with optional pagination.
    pub async fn scan_documents(
        &self,
        collection: &str,
        limit: Option<u64>,
        cursor: Option<&str>,
        projection: Option<&str>,
    ) -> AnvilResult<DocumentQueryResult> {
        self.request_json(|| {
            let mut req = self
                .inner
                .http
                .get(self.url(&format!("/docs/{collection}/scan")));
            if let Some(limit) = limit {
                req = req.query(&[("limit", limit.to_string())]);
            }
            if let Some(cursor) = cursor {
                req = req.query(&[("cursor", cursor)]);
            }
            if let Some(projection) = projection {
                req = req.query(&[("projection", projection)]);
            }
            req
        })
        .await
    }

    /// Execute a batch of document operations.
    pub async fn batch_documents(
        &self,
        collection: &str,
        operations: Vec<BatchOperation>,
    ) -> AnvilResult<BatchResult> {
        let body = BatchRequest { operations };
        self.request_json(|| {
            self.inner
                .http
                .post(self.url(&format!("/docs/{collection}/batch")))
                .json(&body)
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// Get server statistics.
    pub async fn stats(&self) -> AnvilResult<StatsResponse> {
        self.request_json(|| self.inner.http.get(self.url("/admin/stats")))
            .await
    }

    /// List all users.
    pub async fn users(&self) -> AnvilResult<Vec<User>> {
        self.request_json(|| self.inner.http.get(self.url("/admin/users")))
            .await
    }

    /// List all roles.
    pub async fn roles(&self) -> AnvilResult<Vec<Role>> {
        self.request_json(|| self.inner.http.get(self.url("/admin/roles")))
            .await
    }

    /// Query audit events.
    pub async fn events(
        &self,
        event_type: Option<&str>,
        name: Option<&str>,
        limit: Option<u64>,
    ) -> AnvilResult<EventsResponse> {
        self.request_json(|| {
            let mut req = self.inner.http.get(self.url("/admin/events"));
            if let Some(t) = event_type {
                req = req.query(&[("type", t)]);
            }
            if let Some(n) = name {
                req = req.query(&[("name", n)]);
            }
            if let Some(l) = limit {
                req = req.query(&[("limit", l.to_string())]);
            }
            req
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Import
    // -----------------------------------------------------------------------

    /// Import a Cypher script.
    pub async fn import_cypher(&self, script: &str) -> AnvilResult<Value> {
        let body = ImportCypherRequest {
            script: script.to_string(),
        };
        self.request_json(|| {
            self.inner
                .http
                .post(self.url("/db/import/cypher"))
                .json(&body)
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Transactions
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Storage (Phase 25.13)
    // -----------------------------------------------------------------------

    /// File storage namespace. Bucket-level operations live on the returned
    /// [`Storage`], per-bucket object operations live on the
    /// [`StorageBucketBuilder`] returned by `client.storage().from("…")`.
    pub fn storage(&self) -> crate::storage::Storage {
        crate::storage::Storage {
            client: self.clone(),
        }
    }

    /// Begin a new transaction and return a [`Transaction`] handle.
    ///
    /// Use the handle to execute queries, then commit or rollback.
    pub async fn begin_transaction(&self) -> AnvilResult<Transaction> {
        let resp: TransactionBeginResponse = self
            .request_json(|| {
                self.inner
                    .http
                    .post(self.url("/db/transaction/begin"))
            })
            .await?;

        Ok(Transaction {
            client: self.clone(),
            tx_id: resp.tx_id,
            finished: false,
        })
    }
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/// A handle to an open server-side transaction.
///
/// Queries executed through this handle run within the transaction. Call
/// [`commit`](Transaction::commit) or [`rollback`](Transaction::rollback)
/// when finished. Dropping without committing will **not** automatically
/// rollback — the server will time out the transaction eventually.
#[derive(Debug)]
pub struct Transaction {
    client: AnvilClient,
    tx_id: String,
    finished: bool,
}

impl Transaction {
    /// Returns the server-assigned transaction ID.
    pub fn id(&self) -> &str {
        &self.tx_id
    }

    /// Execute a Cypher query within this transaction.
    pub async fn query(
        &self,
        query: &str,
        params: Option<Value>,
    ) -> AnvilResult<CypherResult> {
        if self.finished {
            return Err(AnvilError::Transaction(
                "Transaction is already finished".into(),
            ));
        }

        let body = TransactionQueryRequest {
            query: query.to_string(),
            params,
        };
        let tx_id = &self.tx_id;
        self.client
            .request_json(|| {
                self.client
                    .inner
                    .http
                    .post(self.client.url(&format!("/db/transaction/{tx_id}/query")))
                    .json(&body)
            })
            .await
    }

    /// Commit the transaction.
    pub async fn commit(mut self) -> AnvilResult<()> {
        if self.finished {
            return Err(AnvilError::Transaction(
                "Transaction is already finished".into(),
            ));
        }
        self.finished = true;

        let tx_id = &self.tx_id;
        let resp = self
            .client
            .send_with_retry(|| {
                self.client
                    .inner
                    .http
                    .post(self.client.url(&format!("/db/transaction/{tx_id}/commit")))
            })
            .await?;
        AnvilClient::check(resp).await?;
        Ok(())
    }

    /// Rollback the transaction.
    pub async fn rollback(mut self) -> AnvilResult<()> {
        if self.finished {
            return Err(AnvilError::Transaction(
                "Transaction is already finished".into(),
            ));
        }
        self.finished = true;

        let tx_id = &self.tx_id;
        let resp = self
            .client
            .send_with_retry(|| {
                self.client
                    .inner
                    .http
                    .post(
                        self.client
                            .url(&format!("/db/transaction/{tx_id}/rollback")),
                    )
            })
            .await?;
        AnvilClient::check(resp).await?;
        Ok(())
    }
}
