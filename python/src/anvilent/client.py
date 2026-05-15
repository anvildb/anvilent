"""Synchronous and asynchronous HTTP clients for Anvil DB."""

from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING, Any, AsyncIterator, Iterator

if TYPE_CHECKING:
    from typing import Self

    from .storage import AsyncStorage, Storage

import httpx

from .errors import AnvilError
from .models import (
    Collection,
    CypherResult,
    Document,
    DocumentQuery,
    DocumentQueryResult,
    EventEntry,
    GraphQLResponse,
    Role,
    ServerInfo,
    StatsResponse,
    User,
)
from .uri import AnvilUri, parse_anvil_uri


def _base_url(uri: AnvilUri) -> str:
    scheme = "https" if uri.tls else "http"
    return f"{scheme}://{uri.host}:{uri.port}"


def _check_response(resp: httpx.Response) -> None:
    if resp.status_code >= 400:
        body: str | None = None
        try:
            body = resp.text
        except Exception:
            pass
        raise AnvilError(resp.status_code, resp.reason_phrase or "", body)


def _parse_document(data: dict[str, Any]) -> Document:
    return Document(
        id=data["id"],
        collection=data.get("collection", ""),
        key=data.get("key", ""),
        body=data.get("body", {}),
        expires_at=data.get("expires_at"),
        created_at=data.get("created_at"),
        updated_at=data.get("updated_at"),
        version=data.get("version", 1),
    )


def _strip_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------


class _TransactionContext:
    """Context manager for a database transaction."""

    def __init__(self, client: AnvilClient, tx_id: str) -> None:
        self._client = client
        self.tx_id = tx_id

    def query(self, cypher: str, params: dict[str, Any] | None = None) -> CypherResult:
        """Execute a Cypher query within this transaction.

        Args:
            cypher: The Cypher query string.
            params: Optional query parameters.

        Returns:
            The query result.
        """
        return self._client.transaction_query(self.tx_id, cypher, params)

    def commit(self) -> None:
        """Commit the transaction."""
        self._client.commit_transaction(self.tx_id)

    def rollback(self) -> None:
        """Roll back the transaction."""
        self._client.rollback_transaction(self.tx_id)

    def __enter__(self) -> _TransactionContext:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is not None:
            self.rollback()
        else:
            self.commit()


class AnvilClient:
    """Synchronous HTTP client for Anvil DB.

    Use :meth:`connect` to create a client from a connection URI, or
    instantiate directly with a base URL.

    Args:
        base_url: The base URL of the Anvil DB server (e.g. ``http://localhost:7474``).
        database: Default database name to use for queries.
        timeout: Request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str,
        database: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._database = database
        self._timeout = timeout
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        self._client = httpx.Client(base_url=self._base_url, timeout=timeout)

    @classmethod
    def connect(cls, uri: str, *, timeout: float = 30.0) -> AnvilClient:
        """Create and authenticate a client from an Anvil connection URI.

        Parses the URI, constructs the base URL, and automatically logs in
        if credentials are present.

        Args:
            uri: Connection URI in the form ``anvil://[user:pass@]host[:port][/db]``.
            timeout: Request timeout in seconds.

        Returns:
            A connected :class:`AnvilClient` instance.
        """
        parsed = parse_anvil_uri(uri)
        client = cls(
            base_url=_base_url(parsed),
            database=parsed.database,
            timeout=timeout,
        )
        if parsed.username and parsed.password:
            client.login(parsed.username, parsed.password)
        return client

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    # -- internal helpers ---------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        _retry_auth: bool = True,
    ) -> httpx.Response:
        resp = self._client.request(
            method,
            path,
            json=json,
            params=params,
            headers=self._headers(),
        )
        if resp.status_code == 401 and _retry_auth and self._refresh_token:
            self._do_refresh()
            resp = self._client.request(
                method,
                path,
                json=json,
                params=params,
                headers=self._headers(),
            )
        _check_response(resp)
        return resp

    # -- storage plumbing ---------------------------------------------------

    def _storage_raw(
        self,
        method: str,
        path: str,
        *,
        content: bytes | None = b"",
        json: Any = None,
        headers: dict[str, str] | None = None,
        _retry_auth: bool = True,
    ) -> httpx.Response:
        """Authenticated raw request used by the storage namespace.

        Differs from :meth:`_request` in three ways:
        - returns the response even for 4xx / 5xx so callers can branch on
          status (HEAD exists-checks, 404 misses in batch delete, etc.).
        - accepts raw ``content`` bytes for binary uploads.
        - falls through to a per-call header dict so the caller can set
          Content-Type, TUS headers, etc.
        """
        request_headers = dict(headers or {})
        request_headers.update(self._headers())
        resp = self._client.request(
            method,
            path,
            content=content,
            json=json,
            headers=request_headers,
        )
        if resp.status_code == 401 and _retry_auth and self._refresh_token:
            self._do_refresh()
            request_headers = dict(headers or {})
            request_headers.update(self._headers())
            resp = self._client.request(
                method,
                path,
                content=content,
                json=json,
                headers=request_headers,
            )
        return resp

    def _storage_stream(self, method: str, path: str) -> Iterator[bytes]:
        """Stream a response body as a synchronous iterator of byte chunks."""
        with self._client.stream(method, path, headers=self._headers()) as resp:
            if resp.status_code >= 400:
                resp.read()
                _check_response(resp)
            yield from resp.iter_bytes()

    @property
    def storage(self) -> "Storage":
        """File storage namespace (Phase 25.13)."""
        cached = getattr(self, "_storage_ns", None)
        if cached is None:
            from .storage import Storage

            cached = Storage(self)
            self._storage_ns = cached
        return cached

    def _do_refresh(self) -> None:
        resp = self._client.post(
            "/auth/refresh",
            json={"refresh_token": self._refresh_token},
        )
        if resp.status_code >= 400:
            self._access_token = None
            self._refresh_token = None
            return
        data = resp.json()
        self._access_token = data.get("access_token")
        self._refresh_token = data.get("refresh_token", self._refresh_token)

    # -- auth ---------------------------------------------------------------

    def login(self, username: str, password: str) -> dict[str, Any]:
        """Authenticate with the server.

        Args:
            username: The username.
            password: The password.

        Returns:
            The raw authentication response containing tokens.
        """
        resp = self._request(
            "POST",
            "/auth/login",
            json={"username": username, "password": password},
            _retry_auth=False,
        )
        data: dict[str, Any] = resp.json()
        self._access_token = data.get("access_token")
        self._refresh_token = data.get("refresh_token")
        return data

    def refresh(self) -> dict[str, Any]:
        """Manually refresh the authentication token.

        Returns:
            The raw refresh response containing new tokens.
        """
        self._do_refresh()
        return {"access_token": self._access_token, "refresh_token": self._refresh_token}

    def register(self, username: str, password: str, roles: list[str] | None = None) -> dict[str, Any]:
        """Register a new user account.

        Args:
            username: Desired username.
            password: Desired password.
            roles: Optional list of roles to assign.

        Returns:
            The raw registration response.
        """
        body: dict[str, Any] = {"username": username, "password": password}
        if roles:
            body["roles"] = roles
        return self._request("POST", "/auth/register", json=body).json()

    def change_password(self, old_password: str, new_password: str) -> dict[str, Any]:
        """Change the current user's password.

        Args:
            old_password: The current password.
            new_password: The new password.

        Returns:
            The raw response.
        """
        return self._request(
            "POST",
            "/auth/change-password",
            json={"old_password": old_password, "new_password": new_password},
        ).json()

    # -- core ---------------------------------------------------------------

    def server_info(self) -> ServerInfo:
        """Retrieve server information.

        Returns:
            A :class:`ServerInfo` instance.
        """
        data = self._request("GET", "/").json()
        return ServerInfo(
            version=data["version"],
            edition=data.get("edition", ""),
            databases=data.get("databases", []),
            uptime=data.get("uptime", ""),
        )

    def health(self) -> dict[str, Any]:
        """Check server health.

        Returns:
            The raw health check response.
        """
        return self._request("GET", "/health").json()

    def query(self, cypher: str, params: dict[str, Any] | None = None, database: str | None = None) -> CypherResult:
        """Execute a Cypher query.

        Args:
            cypher: The Cypher query string.
            params: Optional query parameters.
            database: Database to query; uses the default if not specified.

        Returns:
            A :class:`CypherResult` with the query results.
        """
        body: dict[str, Any] = {"query": cypher}
        if params:
            body["params"] = params
        db = database or self._database
        if db:
            body["database"] = db
        data = self._request("POST", "/db/query", json=body).json()
        return CypherResult(
            columns=data.get("columns", []),
            rows=data.get("rows", []),
            row_count=data.get("row_count", 0),
            execution_time_ms=data.get("execution_time_ms", 0.0),
        )

    def list_databases(self) -> list[dict[str, Any]]:
        """List all databases.

        Returns:
            A list of database info dictionaries.
        """
        return self._request("GET", "/db").json()

    def get_schema(self, database: str | None = None) -> dict[str, Any]:
        """Get the schema for a database.

        Args:
            database: Database name; uses the default if not specified.

        Returns:
            The schema as a dictionary.
        """
        db = database or self._database or "default"
        return self._request("GET", f"/db/{db}/schema").json()

    def get_graph(self, database: str | None = None) -> dict[str, Any]:
        """Get graph data for a database.

        Args:
            database: Database name; uses the default if not specified.

        Returns:
            Graph data as a dictionary.
        """
        db = database or self._database or "default"
        return self._request("GET", f"/db/{db}/graph").json()

    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> GraphQLResponse:
        """Execute a GraphQL query.

        Args:
            query: The GraphQL query string.
            variables: Optional query variables.

        Returns:
            A :class:`GraphQLResponse` with the results.
        """
        body: dict[str, Any] = {"query": query}
        if variables:
            body["variables"] = variables
        data = self._request("POST", "/graphql", json=body).json()
        return GraphQLResponse(data=data.get("data"), errors=data.get("errors"))

    def import_cypher(self, script: str) -> dict[str, Any]:
        """Import data via a Cypher script.

        Args:
            script: The Cypher script to execute.

        Returns:
            The raw import response.
        """
        return self._request("POST", "/db/import/cypher", json={"script": script}).json()

    # -- transactions -------------------------------------------------------

    def begin_transaction(self) -> _TransactionContext:
        """Begin a new database transaction.

        Returns a context manager that automatically commits on success
        or rolls back on exception::

            with client.begin_transaction() as tx:
                tx.query("CREATE (n:Node {name: $name})", {"name": "foo"})

        Returns:
            A :class:`_TransactionContext` instance.
        """
        data = self._request("POST", "/db/transaction/begin").json()
        tx_id: str = data.get("transaction_id") or data.get("tx_id") or data["id"]
        return _TransactionContext(self, tx_id)

    def transaction_query(self, tx_id: str, cypher: str, params: dict[str, Any] | None = None) -> CypherResult:
        """Execute a query within a transaction.

        Args:
            tx_id: The transaction identifier.
            cypher: The Cypher query string.
            params: Optional query parameters.

        Returns:
            The query result.
        """
        body: dict[str, Any] = {"query": cypher}
        if params:
            body["params"] = params
        data = self._request("POST", f"/db/transaction/{tx_id}/query", json=body).json()
        return CypherResult(
            columns=data.get("columns", []),
            rows=data.get("rows", []),
            row_count=data.get("row_count", 0),
            execution_time_ms=data.get("execution_time_ms", 0.0),
        )

    def commit_transaction(self, tx_id: str) -> dict[str, Any]:
        """Commit a transaction.

        Args:
            tx_id: The transaction identifier.

        Returns:
            The raw commit response.
        """
        return self._request("POST", f"/db/transaction/{tx_id}/commit").json()

    def rollback_transaction(self, tx_id: str) -> dict[str, Any]:
        """Roll back a transaction.

        Args:
            tx_id: The transaction identifier.

        Returns:
            The raw rollback response.
        """
        return self._request("POST", f"/db/transaction/{tx_id}/rollback").json()

    # -- documents ----------------------------------------------------------

    def list_collections(self) -> list[Collection]:
        """List all document collections.

        Returns:
            A list of :class:`Collection` instances.
        """
        data = self._request("GET", "/docs").json()
        results: list[Collection] = []
        for item in data if isinstance(data, list) else data.get("collections", []):
            results.append(
                Collection(
                    name=item["name"],
                    id=item.get("id", ""),
                    composite_keys=item.get("composite_keys", []),
                    default_ttl_ms=item.get("default_ttl_ms"),
                )
            )
        return results

    def create_document(self, collection: str, body: dict[str, Any], key: str | None = None) -> Document:
        """Create a document in a collection.

        Args:
            collection: The collection name.
            body: The document body.
            key: Optional document key.

        Returns:
            The created :class:`Document`.
        """
        payload: dict[str, Any] = {"body": body}
        if key:
            payload["key"] = key
        data = self._request("POST", f"/docs/{collection}", json=payload).json()
        return _parse_document(data)

    def delete_collection(self, collection: str) -> dict[str, Any]:
        """Delete an entire collection.

        Args:
            collection: The collection name.

        Returns:
            The raw deletion response.
        """
        return self._request("DELETE", f"/docs/{collection}").json()

    def get_document(self, collection: str, doc_id: str) -> Document:
        """Retrieve a document by ID.

        Args:
            collection: The collection name.
            doc_id: The document identifier.

        Returns:
            The :class:`Document`.
        """
        data = self._request("GET", f"/docs/{collection}/{doc_id}").json()
        return _parse_document(data)

    def update_document(self, collection: str, doc_id: str, body: dict[str, Any]) -> Document:
        """Update a document.

        Args:
            collection: The collection name.
            doc_id: The document identifier.
            body: The new document body.

        Returns:
            The updated :class:`Document`.
        """
        data = self._request("PUT", f"/docs/{collection}/{doc_id}", json={"body": body}).json()
        return _parse_document(data)

    def delete_document(self, collection: str, doc_id: str) -> dict[str, Any]:
        """Delete a document.

        Args:
            collection: The collection name.
            doc_id: The document identifier.

        Returns:
            The raw deletion response.
        """
        return self._request("DELETE", f"/docs/{collection}/{doc_id}").json()

    def query_documents(self, collection: str, query: DocumentQuery | None = None) -> DocumentQueryResult:
        """Query documents in a collection.

        Args:
            collection: The collection name.
            query: Optional query parameters.

        Returns:
            A :class:`DocumentQueryResult` with matching documents.
        """
        body = _strip_none(asdict(query)) if query else {}
        data = self._request("POST", f"/docs/{collection}/query", json=body).json()
        docs = [_parse_document(d) for d in data.get("documents", [])]
        return DocumentQueryResult(
            documents=docs,
            count=data.get("count", len(docs)),
            cursor=data.get("cursor"),
        )

    def scan_documents(self, collection: str, limit: int | None = None, cursor: str | None = None) -> DocumentQueryResult:
        """Scan all documents in a collection.

        Args:
            collection: The collection name.
            limit: Maximum number of documents to return.
            cursor: Pagination cursor from a previous scan.

        Returns:
            A :class:`DocumentQueryResult` with documents.
        """
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        data = self._request("GET", f"/docs/{collection}/scan", params=params).json()
        docs = [_parse_document(d) for d in data.get("documents", [])]
        return DocumentQueryResult(
            documents=docs,
            count=data.get("count", len(docs)),
            cursor=data.get("cursor"),
        )

    def batch_documents(self, collection: str, documents: list[dict[str, Any]]) -> list[Document]:
        """Create or update documents in batch.

        Args:
            collection: The collection name.
            documents: List of document payloads.

        Returns:
            A list of created/updated :class:`Document` instances.
        """
        data = self._request("POST", f"/docs/{collection}/batch", json={"documents": documents}).json()
        items = data if isinstance(data, list) else data.get("documents", [])
        return [_parse_document(d) for d in items]

    # -- admin --------------------------------------------------------------

    def stats(self) -> StatsResponse:
        """Retrieve server statistics.

        Returns:
            A :class:`StatsResponse` instance.
        """
        data = self._request("GET", "/admin/stats").json()
        return StatsResponse(
            node_count=data.get("node_count", 0),
            relationship_count=data.get("relationship_count", 0),
            collection_count=data.get("collection_count", 0),
            document_count=data.get("document_count", 0),
            uptime_seconds=data.get("uptime_seconds", 0.0),
            sync_rules=data.get("sync_rules", 0),
            rls_policies=data.get("rls_policies", 0),
        )

    def list_users(self) -> list[User]:
        """List all user accounts.

        Returns:
            A list of :class:`User` instances.
        """
        data = self._request("GET", "/admin/users").json()
        items = data if isinstance(data, list) else data.get("users", [])
        return [
            User(
                username=u["username"],
                roles=u.get("roles", []),
                must_change_password=u.get("must_change_password", False),
            )
            for u in items
        ]

    def list_roles(self) -> list[Role]:
        """List all security roles.

        Returns:
            A list of :class:`Role` instances.
        """
        data = self._request("GET", "/admin/roles").json()
        items = data if isinstance(data, list) else data.get("roles", [])
        return [
            Role(name=r["name"], privileges=r.get("privileges", []))
            for r in items
        ]

    def list_events(self) -> list[EventEntry]:
        """List audit/event log entries.

        Returns:
            A list of :class:`EventEntry` instances.
        """
        data = self._request("GET", "/admin/events").json()
        items = data if isinstance(data, list) else data.get("events", [])
        return [
            EventEntry(
                id=e["id"],
                timestamp=e["timestamp"],
                type=e["type"],
                name=e["name"],
                duration_ms=e.get("duration_ms", 0.0),
                success=e.get("success", True),
                error=e.get("error"),
                user=e.get("user"),
                metadata=e.get("metadata"),
            )
            for e in items
        ]


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------


class _AsyncTransactionContext:
    """Async context manager for a database transaction."""

    def __init__(self, client: AsyncAnvilClient, tx_id: str) -> None:
        self._client = client
        self.tx_id = tx_id

    async def query(self, cypher: str, params: dict[str, Any] | None = None) -> CypherResult:
        """Execute a Cypher query within this transaction.

        Args:
            cypher: The Cypher query string.
            params: Optional query parameters.

        Returns:
            The query result.
        """
        return await self._client.transaction_query(self.tx_id, cypher, params)

    async def commit(self) -> None:
        """Commit the transaction."""
        await self._client.commit_transaction(self.tx_id)

    async def rollback(self) -> None:
        """Roll back the transaction."""
        await self._client.rollback_transaction(self.tx_id)

    async def __aenter__(self) -> _AsyncTransactionContext:
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is not None:
            await self.rollback()
        else:
            await self.commit()


class AsyncAnvilClient:
    """Asynchronous HTTP client for Anvil DB.

    Use :meth:`connect` to create a client from a connection URI, or
    instantiate directly with a base URL.

    Args:
        base_url: The base URL of the Anvil DB server (e.g. ``http://localhost:7474``).
        database: Default database name to use for queries.
        timeout: Request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str,
        database: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._database = database
        self._timeout = timeout
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=timeout)

    @classmethod
    async def connect(cls, uri: str, *, timeout: float = 30.0) -> AsyncAnvilClient:
        """Create and authenticate a client from an Anvil connection URI.

        Parses the URI, constructs the base URL, and automatically logs in
        if credentials are present.

        Args:
            uri: Connection URI in the form ``anvil://[user:pass@]host[:port][/db]``.
            timeout: Request timeout in seconds.

        Returns:
            A connected :class:`AsyncAnvilClient` instance.
        """
        parsed = parse_anvil_uri(uri)
        client = cls(
            base_url=_base_url(parsed),
            database=parsed.database,
            timeout=timeout,
        )
        if parsed.username and parsed.password:
            await client.login(parsed.username, parsed.password)
        return client

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> AsyncAnvilClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    # -- internal helpers ---------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        _retry_auth: bool = True,
    ) -> httpx.Response:
        resp = await self._client.request(
            method,
            path,
            json=json,
            params=params,
            headers=self._headers(),
        )
        if resp.status_code == 401 and _retry_auth and self._refresh_token:
            await self._do_refresh()
            resp = await self._client.request(
                method,
                path,
                json=json,
                params=params,
                headers=self._headers(),
            )
        _check_response(resp)
        return resp

    # -- storage plumbing ---------------------------------------------------

    async def _storage_raw(
        self,
        method: str,
        path: str,
        *,
        content: bytes | None = b"",
        json: Any = None,
        headers: dict[str, str] | None = None,
        _retry_auth: bool = True,
    ) -> httpx.Response:
        """Authenticated raw request used by the async storage namespace."""
        request_headers = dict(headers or {})
        request_headers.update(self._headers())
        resp = await self._client.request(
            method,
            path,
            content=content,
            json=json,
            headers=request_headers,
        )
        if resp.status_code == 401 and _retry_auth and self._refresh_token:
            await self._do_refresh()
            request_headers = dict(headers or {})
            request_headers.update(self._headers())
            resp = await self._client.request(
                method,
                path,
                content=content,
                json=json,
                headers=request_headers,
            )
        return resp

    async def _storage_stream(self, method: str, path: str) -> AsyncIterator[bytes]:
        """Stream a response body as an async iterator of byte chunks."""
        async with self._client.stream(method, path, headers=self._headers()) as resp:
            if resp.status_code >= 400:
                await resp.aread()
                _check_response(resp)
            async for chunk in resp.aiter_bytes():
                yield chunk

    @property
    def storage(self) -> "AsyncStorage":
        """Async file storage namespace (Phase 25.13)."""
        cached = getattr(self, "_storage_ns", None)
        if cached is None:
            from .storage import AsyncStorage

            cached = AsyncStorage(self)
            self._storage_ns = cached
        return cached

    async def _do_refresh(self) -> None:
        resp = await self._client.post(
            "/auth/refresh",
            json={"refresh_token": self._refresh_token},
        )
        if resp.status_code >= 400:
            self._access_token = None
            self._refresh_token = None
            return
        data = resp.json()
        self._access_token = data.get("access_token")
        self._refresh_token = data.get("refresh_token", self._refresh_token)

    # -- auth ---------------------------------------------------------------

    async def login(self, username: str, password: str) -> dict[str, Any]:
        """Authenticate with the server.

        Args:
            username: The username.
            password: The password.

        Returns:
            The raw authentication response containing tokens.
        """
        resp = await self._request(
            "POST",
            "/auth/login",
            json={"username": username, "password": password},
            _retry_auth=False,
        )
        data: dict[str, Any] = resp.json()
        self._access_token = data.get("access_token")
        self._refresh_token = data.get("refresh_token")
        return data

    async def refresh(self) -> dict[str, Any]:
        """Manually refresh the authentication token.

        Returns:
            The raw refresh response containing new tokens.
        """
        await self._do_refresh()
        return {"access_token": self._access_token, "refresh_token": self._refresh_token}

    async def register(self, username: str, password: str, roles: list[str] | None = None) -> dict[str, Any]:
        """Register a new user account.

        Args:
            username: Desired username.
            password: Desired password.
            roles: Optional list of roles to assign.

        Returns:
            The raw registration response.
        """
        body: dict[str, Any] = {"username": username, "password": password}
        if roles:
            body["roles"] = roles
        return (await self._request("POST", "/auth/register", json=body)).json()

    async def change_password(self, old_password: str, new_password: str) -> dict[str, Any]:
        """Change the current user's password.

        Args:
            old_password: The current password.
            new_password: The new password.

        Returns:
            The raw response.
        """
        return (await self._request(
            "POST",
            "/auth/change-password",
            json={"old_password": old_password, "new_password": new_password},
        )).json()

    # -- core ---------------------------------------------------------------

    async def server_info(self) -> ServerInfo:
        """Retrieve server information.

        Returns:
            A :class:`ServerInfo` instance.
        """
        data = (await self._request("GET", "/")).json()
        return ServerInfo(
            version=data["version"],
            edition=data.get("edition", ""),
            databases=data.get("databases", []),
            uptime=data.get("uptime", ""),
        )

    async def health(self) -> dict[str, Any]:
        """Check server health.

        Returns:
            The raw health check response.
        """
        return (await self._request("GET", "/health")).json()

    async def query(self, cypher: str, params: dict[str, Any] | None = None, database: str | None = None) -> CypherResult:
        """Execute a Cypher query.

        Args:
            cypher: The Cypher query string.
            params: Optional query parameters.
            database: Database to query; uses the default if not specified.

        Returns:
            A :class:`CypherResult` with the query results.
        """
        body: dict[str, Any] = {"query": cypher}
        if params:
            body["params"] = params
        db = database or self._database
        if db:
            body["database"] = db
        data = (await self._request("POST", "/db/query", json=body)).json()
        return CypherResult(
            columns=data.get("columns", []),
            rows=data.get("rows", []),
            row_count=data.get("row_count", 0),
            execution_time_ms=data.get("execution_time_ms", 0.0),
        )

    async def list_databases(self) -> list[dict[str, Any]]:
        """List all databases.

        Returns:
            A list of database info dictionaries.
        """
        return (await self._request("GET", "/db")).json()

    async def get_schema(self, database: str | None = None) -> dict[str, Any]:
        """Get the schema for a database.

        Args:
            database: Database name; uses the default if not specified.

        Returns:
            The schema as a dictionary.
        """
        db = database or self._database or "default"
        return (await self._request("GET", f"/db/{db}/schema")).json()

    async def get_graph(self, database: str | None = None) -> dict[str, Any]:
        """Get graph data for a database.

        Args:
            database: Database name; uses the default if not specified.

        Returns:
            Graph data as a dictionary.
        """
        db = database or self._database or "default"
        return (await self._request("GET", f"/db/{db}/graph")).json()

    async def graphql(self, query: str, variables: dict[str, Any] | None = None) -> GraphQLResponse:
        """Execute a GraphQL query.

        Args:
            query: The GraphQL query string.
            variables: Optional query variables.

        Returns:
            A :class:`GraphQLResponse` with the results.
        """
        body: dict[str, Any] = {"query": query}
        if variables:
            body["variables"] = variables
        data = (await self._request("POST", "/graphql", json=body)).json()
        return GraphQLResponse(data=data.get("data"), errors=data.get("errors"))

    async def import_cypher(self, script: str) -> dict[str, Any]:
        """Import data via a Cypher script.

        Args:
            script: The Cypher script to execute.

        Returns:
            The raw import response.
        """
        return (await self._request("POST", "/db/import/cypher", json={"script": script})).json()

    # -- transactions -------------------------------------------------------

    async def begin_transaction(self) -> _AsyncTransactionContext:
        """Begin a new database transaction.

        Returns an async context manager that automatically commits on
        success or rolls back on exception::

            async with client.begin_transaction() as tx:
                await tx.query("CREATE (n:Node {name: $name})", {"name": "foo"})

        Returns:
            An :class:`_AsyncTransactionContext` instance.
        """
        data = (await self._request("POST", "/db/transaction/begin")).json()
        tx_id: str = data.get("transaction_id") or data.get("tx_id") or data["id"]
        return _AsyncTransactionContext(self, tx_id)

    async def transaction_query(self, tx_id: str, cypher: str, params: dict[str, Any] | None = None) -> CypherResult:
        """Execute a query within a transaction.

        Args:
            tx_id: The transaction identifier.
            cypher: The Cypher query string.
            params: Optional query parameters.

        Returns:
            The query result.
        """
        body: dict[str, Any] = {"query": cypher}
        if params:
            body["params"] = params
        data = (await self._request("POST", f"/db/transaction/{tx_id}/query", json=body)).json()
        return CypherResult(
            columns=data.get("columns", []),
            rows=data.get("rows", []),
            row_count=data.get("row_count", 0),
            execution_time_ms=data.get("execution_time_ms", 0.0),
        )

    async def commit_transaction(self, tx_id: str) -> dict[str, Any]:
        """Commit a transaction.

        Args:
            tx_id: The transaction identifier.

        Returns:
            The raw commit response.
        """
        return (await self._request("POST", f"/db/transaction/{tx_id}/commit")).json()

    async def rollback_transaction(self, tx_id: str) -> dict[str, Any]:
        """Roll back a transaction.

        Args:
            tx_id: The transaction identifier.

        Returns:
            The raw rollback response.
        """
        return (await self._request("POST", f"/db/transaction/{tx_id}/rollback")).json()

    # -- documents ----------------------------------------------------------

    async def list_collections(self) -> list[Collection]:
        """List all document collections.

        Returns:
            A list of :class:`Collection` instances.
        """
        data = (await self._request("GET", "/docs")).json()
        results: list[Collection] = []
        for item in data if isinstance(data, list) else data.get("collections", []):
            results.append(
                Collection(
                    name=item["name"],
                    id=item.get("id", ""),
                    composite_keys=item.get("composite_keys", []),
                    default_ttl_ms=item.get("default_ttl_ms"),
                )
            )
        return results

    async def create_document(self, collection: str, body: dict[str, Any], key: str | None = None) -> Document:
        """Create a document in a collection.

        Args:
            collection: The collection name.
            body: The document body.
            key: Optional document key.

        Returns:
            The created :class:`Document`.
        """
        payload: dict[str, Any] = {"body": body}
        if key:
            payload["key"] = key
        data = (await self._request("POST", f"/docs/{collection}", json=payload)).json()
        return _parse_document(data)

    async def delete_collection(self, collection: str) -> dict[str, Any]:
        """Delete an entire collection.

        Args:
            collection: The collection name.

        Returns:
            The raw deletion response.
        """
        return (await self._request("DELETE", f"/docs/{collection}")).json()

    async def get_document(self, collection: str, doc_id: str) -> Document:
        """Retrieve a document by ID.

        Args:
            collection: The collection name.
            doc_id: The document identifier.

        Returns:
            The :class:`Document`.
        """
        data = (await self._request("GET", f"/docs/{collection}/{doc_id}")).json()
        return _parse_document(data)

    async def update_document(self, collection: str, doc_id: str, body: dict[str, Any]) -> Document:
        """Update a document.

        Args:
            collection: The collection name.
            doc_id: The document identifier.
            body: The new document body.

        Returns:
            The updated :class:`Document`.
        """
        data = (await self._request("PUT", f"/docs/{collection}/{doc_id}", json={"body": body})).json()
        return _parse_document(data)

    async def delete_document(self, collection: str, doc_id: str) -> dict[str, Any]:
        """Delete a document.

        Args:
            collection: The collection name.
            doc_id: The document identifier.

        Returns:
            The raw deletion response.
        """
        return (await self._request("DELETE", f"/docs/{collection}/{doc_id}")).json()

    async def query_documents(self, collection: str, query: DocumentQuery | None = None) -> DocumentQueryResult:
        """Query documents in a collection.

        Args:
            collection: The collection name.
            query: Optional query parameters.

        Returns:
            A :class:`DocumentQueryResult` with matching documents.
        """
        body = _strip_none(asdict(query)) if query else {}
        data = (await self._request("POST", f"/docs/{collection}/query", json=body)).json()
        docs = [_parse_document(d) for d in data.get("documents", [])]
        return DocumentQueryResult(
            documents=docs,
            count=data.get("count", len(docs)),
            cursor=data.get("cursor"),
        )

    async def scan_documents(self, collection: str, limit: int | None = None, cursor: str | None = None) -> DocumentQueryResult:
        """Scan all documents in a collection.

        Args:
            collection: The collection name.
            limit: Maximum number of documents to return.
            cursor: Pagination cursor from a previous scan.

        Returns:
            A :class:`DocumentQueryResult` with documents.
        """
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        data = (await self._request("GET", f"/docs/{collection}/scan", params=params)).json()
        docs = [_parse_document(d) for d in data.get("documents", [])]
        return DocumentQueryResult(
            documents=docs,
            count=data.get("count", len(docs)),
            cursor=data.get("cursor"),
        )

    async def batch_documents(self, collection: str, documents: list[dict[str, Any]]) -> list[Document]:
        """Create or update documents in batch.

        Args:
            collection: The collection name.
            documents: List of document payloads.

        Returns:
            A list of created/updated :class:`Document` instances.
        """
        data = (await self._request("POST", f"/docs/{collection}/batch", json={"documents": documents})).json()
        items = data if isinstance(data, list) else data.get("documents", [])
        return [_parse_document(d) for d in items]

    # -- admin --------------------------------------------------------------

    async def stats(self) -> StatsResponse:
        """Retrieve server statistics.

        Returns:
            A :class:`StatsResponse` instance.
        """
        data = (await self._request("GET", "/admin/stats")).json()
        return StatsResponse(
            node_count=data.get("node_count", 0),
            relationship_count=data.get("relationship_count", 0),
            collection_count=data.get("collection_count", 0),
            document_count=data.get("document_count", 0),
            uptime_seconds=data.get("uptime_seconds", 0.0),
            sync_rules=data.get("sync_rules", 0),
            rls_policies=data.get("rls_policies", 0),
        )

    async def list_users(self) -> list[User]:
        """List all user accounts.

        Returns:
            A list of :class:`User` instances.
        """
        data = (await self._request("GET", "/admin/users")).json()
        items = data if isinstance(data, list) else data.get("users", [])
        return [
            User(
                username=u["username"],
                roles=u.get("roles", []),
                must_change_password=u.get("must_change_password", False),
            )
            for u in items
        ]

    async def list_roles(self) -> list[Role]:
        """List all security roles.

        Returns:
            A list of :class:`Role` instances.
        """
        data = (await self._request("GET", "/admin/roles")).json()
        items = data if isinstance(data, list) else data.get("roles", [])
        return [
            Role(name=r["name"], privileges=r.get("privileges", []))
            for r in items
        ]

    async def list_events(self) -> list[EventEntry]:
        """List audit/event log entries.

        Returns:
            A list of :class:`EventEntry` instances.
        """
        data = (await self._request("GET", "/admin/events")).json()
        items = data if isinstance(data, list) else data.get("events", [])
        return [
            EventEntry(
                id=e["id"],
                timestamp=e["timestamp"],
                type=e["type"],
                name=e["name"],
                duration_ms=e.get("duration_ms", 0.0),
                success=e.get("success", True),
                error=e.get("error"),
                user=e.get("user"),
                metadata=e.get("metadata"),
            )
            for e in items
        ]
