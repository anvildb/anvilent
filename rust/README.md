# anvilent

[![Crates.io](https://img.shields.io/crates/v/anvilent.svg)](https://crates.io/crates/anvilent)
[![Docs.rs](https://docs.rs/anvilent/badge.svg)](https://docs.rs/anvilent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official Rust client driver for [Anvil DB](https://github.com/anvildb/anvilent) — a graph database with Cypher query support, document storage, and GraphQL.

- Async/await API built on `reqwest` and `tokio`
- Cypher queries with parameter binding
- Server-side transactions (begin / commit / rollback)
- Document collections (CRUD, query, scan, batch)
- GraphQL endpoint support
- Automatic token refresh on 401
- Cheap to clone, safe to share across tasks
- `anvil://` and `anvil+tls://` connection URIs

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
anvilent = "0.1"
tokio = { version = "1", features = ["full"] }
serde_json = "1"
```

Or via the Cargo CLI:

```bash
cargo add anvilent
cargo add tokio --features full
cargo add serde_json
```

## Connecting

The driver accepts connection URIs in the form:

```
anvil[+tls]://[user:pass@]host[:port][/database]
```

| Scheme | Transport |
|--------|-----------|
| `anvil://` | Plain HTTP |
| `anvil+tls://` | HTTPS (TLS) |

The default port is **7474**. If credentials are included in the URI, the client logs in automatically on connect and stores the resulting access/refresh tokens.

```rust
use anvilent::AnvilClient;

#[tokio::main]
async fn main() -> anvilent::AnvilResult<()> {
    let client = AnvilClient::connect("anvil://admin:password@localhost:7474/mydb").await?;
    let info = client.server_info().await?;
    println!("{:?}", info);
    Ok(())
}
```

You can also construct a client from an explicit base URL and authenticate manually:

```rust
let client = AnvilClient::from_base_url("http://localhost:7474")?;
client.login("admin", "password").await?;
```

## Cypher queries

```rust
use serde_json::json;

let result = client
    .query(
        "MATCH (p:Person {name: $name}) RETURN p.name, p.age",
        Some(json!({ "name": "Alice" })),
    )
    .await?;

for row in &result.rows {
    println!("{:?}", row);
}
```

Target a specific database with `query_db`:

```rust
client.query_db("MATCH (n) RETURN count(n)", None, Some("analytics".into())).await?;
```

## Transactions

```rust
let tx = client.begin_transaction().await?;

tx.query(
    "CREATE (p:Person {name: $name, age: $age})",
    Some(json!({ "name": "Bob", "age": 30 })),
).await?;

tx.query(
    "CREATE (c:Company {name: $name})",
    Some(json!({ "name": "Acme" })),
).await?;

tx.commit().await?;
```

Dropping a `Transaction` without committing does **not** automatically rollback — the server times it out. Call `tx.rollback().await?` explicitly to abort.

## Documents

```rust
use anvilent::{CreateCollectionRequest, PutDocumentRequest};
use serde_json::json;

// Create a collection.
client.create_collection("users", CreateCollectionRequest::default()).await?;

// Upsert a document.
client.put_document(
    "users",
    "user-1",
    PutDocumentRequest {
        data: json!({ "name": "Alice", "email": "alice@example.com" }),
        ..Default::default()
    },
).await?;

// Fetch, scan, and delete.
let doc = client.get_document("users", "user-1").await?;
let page = client.scan_documents("users", Some(50), None, None).await?;
client.delete_document("users", "user-1").await?;
```

## GraphQL

```rust
let response = client
    .graphql(
        "query($id: ID!) { user(id: $id) { name email } }",
        Some(json!({ "id": "user-1" })),
        None,
    )
    .await?;
```

## Error handling

All fallible methods return `AnvilResult<T>` (alias for `Result<T, AnvilError>`). `AnvilError` distinguishes HTTP/transport errors, server errors (with status code and body), URI parse errors, auth/refresh failures, and transaction errors.

```rust
use anvilent::AnvilError;

match client.query("MATCH (n) RETURN n", None).await {
    Ok(result) => println!("{} rows", result.rows.len()),
    Err(AnvilError::Server { status, message }) => {
        eprintln!("server error {status}: {message}");
    }
    Err(e) => eprintln!("other error: {e}"),
}
```

## Cloning and concurrency

`AnvilClient` is cheap to clone — it wraps an `Arc` internally — and is safe to share across tasks. Clone it into each task rather than wrapping it in your own `Arc`.

```rust
let client = AnvilClient::connect("anvil://admin:password@localhost/mydb").await?;

for i in 0..10 {
    let client = client.clone();
    tokio::spawn(async move {
        let _ = client.query("MATCH (n) RETURN n LIMIT 1", None).await;
    });
}
```

## Minimum supported Rust version

Rust 1.75 or newer (2021 edition).

## License

Licensed under the MIT license. See [LICENSE](LICENSE) for details.
