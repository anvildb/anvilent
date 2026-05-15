//! # anvilent
//!
//! Official Rust client driver for [Anvil DB](https://github.com/anvildb/anvilent),
//! a graph database with Cypher query support, document storage, and GraphQL.
//!
//! ## Quick start
//!
//! ```no_run
//! use anvilent::AnvilClient;
//!
//! # async fn example() -> anvilent::AnvilResult<()> {
//! // Connect with auto-login via URI credentials.
//! let client = AnvilClient::connect("anvil://admin:password@localhost:7474/mydb").await?;
//!
//! // Run a Cypher query.
//! let result = client.query("MATCH (n:Person) RETURN n.name LIMIT 5", None).await?;
//! for row in &result.rows {
//!     println!("{:?}", row);
//! }
//!
//! // Transactions.
//! let tx = client.begin_transaction().await?;
//! tx.query("CREATE (n:Person {name: $name})", Some(serde_json::json!({"name": "Alice"}))).await?;
//! tx.commit().await?;
//!
//! // Documents.
//! let collections = client.collections().await?;
//! println!("{:?}", collections);
//! # Ok(())
//! # }
//! ```
//!
//! ## Connection URIs
//!
//! | Scheme | Transport |
//! |--------|-----------|
//! | `anvil://` | Plain HTTP |
//! | `anvil+tls://` | HTTPS (TLS) |
//!
//! Format: `anvil[+tls]://[user:pass@]host[:port][/database]`
//!
//! The default port is **7474**. If credentials are provided, the client
//! automatically logs in on connect.

pub mod client;
pub mod error;
pub mod models;
pub mod storage;
pub mod uri;

// Re-export primary types at the crate root for convenience.
pub use client::{AnvilClient, Transaction};
pub use error::{AnvilError, AnvilResult};
pub use models::*;
pub use storage::{
    Bucket, BucketUsage, CreateBucketOptions, Download, FileObject, ImageTransform, ListOptions,
    ListResult, ObjectMetadata, PublicUrlOptions, PublicUrlResult, ResumableUploadOptions,
    ResumableUploadResult, SignedUploadUrlOptions, SignedUploadUrlResult, SignedUrlOptions,
    SignedUrlResult, SizeLimit, SortBy, SortOrder, Storage, StorageBucketBuilder,
    UpdateBucketOptions, UploadOptions, UploadProgress, UploadResult, UsageReport, UserUsage,
};
pub use uri::AnvilUri;
