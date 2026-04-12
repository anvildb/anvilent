"""Data models for Anvil DB API requests and responses."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class CypherResult:
    """Result of a Cypher query execution.

    Attributes:
        columns: Column names returned by the query.
        rows: Row data, each row is a list of values.
        row_count: Total number of rows returned.
        execution_time_ms: Query execution time in milliseconds.
    """

    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    execution_time_ms: float


@dataclass
class ServerInfo:
    """Information about the Anvil DB server.

    Attributes:
        version: Server version string.
        edition: Server edition (e.g. community, enterprise).
        databases: List of available database names.
        uptime: Server uptime as a human-readable string.
    """

    version: str
    edition: str
    databases: list[str]
    uptime: str


@dataclass
class Collection:
    """A document collection definition.

    Attributes:
        name: The collection name.
        id: The collection identifier.
        composite_keys: List of composite key field names.
        default_ttl_ms: Default time-to-live in milliseconds, if set.
    """

    name: str
    id: str
    composite_keys: list[str] = field(default_factory=list)
    default_ttl_ms: int | None = None


@dataclass
class Document:
    """A document stored in a collection.

    Attributes:
        id: Unique document identifier.
        collection: Name of the containing collection.
        key: The document key.
        body: The document body as a dictionary.
        expires_at: Expiration timestamp, if set.
        created_at: Creation timestamp.
        updated_at: Last update timestamp.
        version: Document version number.
    """

    id: str
    collection: str
    key: str
    body: dict[str, Any]
    expires_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    version: int = 1


@dataclass
class DocumentQuery:
    """Parameters for querying documents in a collection.

    Attributes:
        filter: Filter expression for matching documents.
        partition_key: Partition key to scope the query.
        sort_key_start: Starting sort key for range queries.
        limit: Maximum number of documents to return.
        cursor: Pagination cursor from a previous query.
    """

    filter: dict[str, Any] | None = None
    partition_key: str | None = None
    sort_key_start: str | None = None
    limit: int | None = None
    cursor: str | None = None


@dataclass
class DocumentQueryResult:
    """Result of a document query.

    Attributes:
        documents: List of matching documents.
        count: Total number of matching documents.
        cursor: Pagination cursor for fetching the next page.
    """

    documents: list[Document]
    count: int
    cursor: str | None = None


@dataclass
class GraphQLResponse:
    """Response from a GraphQL query.

    Attributes:
        data: The response data payload.
        errors: List of GraphQL errors, if any.
    """

    data: Any | None = None
    errors: list[dict[str, Any]] | None = None


@dataclass
class StatsResponse:
    """Server statistics.

    Attributes:
        node_count: Total number of graph nodes.
        relationship_count: Total number of graph relationships.
        collection_count: Total number of document collections.
        document_count: Total number of documents.
        uptime_seconds: Server uptime in seconds.
        sync_rules: Number of active sync rules.
        rls_policies: Number of active row-level security policies.
    """

    node_count: int
    relationship_count: int
    collection_count: int
    document_count: int
    uptime_seconds: float
    sync_rules: int
    rls_policies: int


@dataclass
class User:
    """An Anvil DB user account.

    Attributes:
        username: The user's login name.
        roles: List of role names assigned to the user.
        must_change_password: Whether the user must change their password.
    """

    username: str
    roles: list[str] = field(default_factory=list)
    must_change_password: bool = False


@dataclass
class Role:
    """A security role definition.

    Attributes:
        name: The role name.
        privileges: List of privilege strings granted by this role.
    """

    name: str
    privileges: list[str] = field(default_factory=list)


@dataclass
class EventEntry:
    """An audit/event log entry.

    Attributes:
        id: Unique event identifier.
        timestamp: When the event occurred.
        type: Event type category.
        name: Event name.
        duration_ms: Duration of the event in milliseconds.
        success: Whether the event completed successfully.
        error: Error message, if the event failed.
        user: The user who triggered the event.
        metadata: Additional event metadata.
    """

    id: str
    timestamp: str
    type: str
    name: str
    duration_ms: float
    success: bool
    error: str | None = None
    user: str | None = None
    metadata: dict[str, Any] | None = None
