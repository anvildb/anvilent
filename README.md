# anvilent

Official client drivers for [Anvil DB](https://github.com/anvildb/anvilent) — a graph database with Cypher query support, document collections, and GraphQL.

This repository hosts four drivers that share a common feature set and connection model:

| Language   | Package                | Directory                     | Status          |
|------------|------------------------|-------------------------------|-----------------|
| Go         | `github.com/anvildb/anvilent/go` | [`go/`](./go)       | Stable          |
| Python     | `anvilent` (PyPI)      | [`python/`](./python)         | In development  |
| Rust       | `anvilent` (crates.io) | [`rust/`](./rust)             | Stable          |
| TypeScript | `anvilent` (npm)       | [`typescript/`](./typescript) | Stable          |

## Features

All four drivers expose the same capabilities against the Anvil DB HTTP API:

- Cypher queries with parameter binding and per-database targeting
- Server-side transactions (begin / commit / rollback)
- Document collections (create, put, get, scan, delete, batch)
- GraphQL endpoint support
- Username/password login with automatic token refresh on `401`
- `anvil://` and `anvil+tls://` connection URIs
- Structured errors that distinguish transport, server, auth, and URI failures

## Connection URIs

Every driver accepts the same URI form:

```
anvil[+tls]://[user:pass@]host[:port][/database]
```

| Scheme          | Transport   |
|-----------------|-------------|
| `anvil://`      | Plain HTTP  |
| `anvil+tls://`  | HTTPS (TLS) |

The default port is **7474**. If credentials are present in the URI, the client authenticates on connect and stores the resulting access/refresh tokens.

## Quick start

### Go

```bash
go get github.com/anvildb/anvilent/go@latest
```

```go
import anvilent "github.com/anvildb/anvilent/go"

client, err := anvilent.Connect(ctx, "anvil://admin:password@localhost:7474/mydb")
if err != nil { panic(err) }
defer client.Close()

result, err := client.Query(ctx, "MATCH (p:Person {name: $name}) RETURN p",
    map[string]any{"name": "Alice"})
```

### Python

> **Status:** in development — API may change before the first release.

```bash
pip install anvilent
```

```python
from anvilent import AnvilClient

async with AnvilClient.connect("anvil://admin:password@localhost:7474/mydb") as client:
    result = await client.query(
        "MATCH (p:Person {name: $name}) RETURN p",
        {"name": "Alice"},
    )
```

### Rust

```bash
cargo add anvilent tokio --features full
```

```rust
use anvilent::AnvilClient;
use serde_json::json;

#[tokio::main]
async fn main() -> anvilent::AnvilResult<()> {
    let client = AnvilClient::connect("anvil://admin:password@localhost:7474/mydb").await?;
    let result = client
        .query("MATCH (p:Person {name: $name}) RETURN p", Some(json!({ "name": "Alice" })))
        .await?;
    println!("{} rows", result.rows.len());
    Ok(())
}
```

### TypeScript

```bash
npm install anvilent
```

```ts
import { AnvilClient } from "anvilent";

const client = await AnvilClient.connect("anvil://admin:password@localhost:7474/mydb");
const result = await client.query(
  "MATCH (p:Person {name: $name}) RETURN p",
  { name: "Alice" },
);
```

## Transactions

Transactions follow a begin / query / commit pattern in every driver. Dropping or garbage-collecting a transaction without committing does **not** automatically rollback — the server times it out. Call `rollback()` explicitly to abort early.

## Documents

Each driver exposes the same document-collection surface: `create_collection`, `put_document`, `get_document`, `delete_document`, `scan_documents`, and batch variants. Documents are arbitrary JSON keyed by a string ID within a named collection.

## GraphQL

Each driver ships a `graphql(query, variables, operation_name)` method that posts to the server's `/graphql` endpoint and returns the raw response.

## Errors

Fallible calls surface structured errors that split HTTP/transport failures, server errors (status + message), URI parse errors, and auth/refresh failures. See each driver's docs for the exact type names:

- Go — `anvilent.Error` with typed fields
- Python — `AnvilError` subclasses (`AnvilServerError`, `AnvilAuthError`, …)
- Rust — `AnvilError` enum, `AnvilResult<T>` alias
- TypeScript — `AnvilError` subclasses exported from the package

## Per-driver documentation

Each driver has its own README, install guide, and license:

- Go — [`go/INSTALL.md`](./go/INSTALL.md)
- Python — [`python/INSTALL.md`](./python/INSTALL.md)
- Rust — [`rust/README.md`](./rust/README.md), [`rust/INSTALL.md`](./rust/INSTALL.md)
- TypeScript — [`typescript/INSTALL.md`](./typescript/INSTALL.md)

## License

All four drivers are released under the MIT license. See the `LICENSE` file inside each driver directory.
