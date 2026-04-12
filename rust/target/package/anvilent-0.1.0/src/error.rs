//! Error types for the Anvil DB client.

use thiserror::Error;

/// All errors that can occur when interacting with the Anvil DB client.
#[derive(Debug, Error)]
pub enum AnvilError {
    /// An HTTP request failed.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// The server returned an error status code.
    #[error("Server error ({status}): {message}")]
    Server {
        /// HTTP status code.
        status: u16,
        /// Error message from the server.
        message: String,
    },

    /// Failed to parse or serialize JSON.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// The provided URI is invalid.
    #[error("Invalid URI: {0}")]
    InvalidUri(String),

    /// Authentication failed.
    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    /// The token refresh attempt failed and the request could not be retried.
    #[error("Token refresh failed: {0}")]
    RefreshFailed(String),

    /// A transaction error occurred.
    #[error("Transaction error: {0}")]
    Transaction(String),
}

/// Convenience result type for Anvil DB operations.
pub type AnvilResult<T> = Result<T, AnvilError>;
