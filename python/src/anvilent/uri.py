"""URI parsing for Anvil DB connection strings."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import unquote, urlparse


@dataclass(frozen=True)
class AnvilUri:
    """Parsed components of an Anvil DB connection URI.

    Attributes:
        host: The server hostname.
        port: The server port (default 7474).
        database: The target database name, if specified.
        username: The username for authentication, if provided.
        password: The password for authentication, if provided.
        tls: Whether TLS is enabled.
    """

    host: str
    port: int
    database: str | None
    username: str | None
    password: str | None
    tls: bool


def parse_anvil_uri(uri: str) -> AnvilUri:
    """Parse an Anvil DB connection URI.

    Supported schemes:
        - ``anvil://`` for plain connections
        - ``anvil+tls://`` for TLS-encrypted connections

    Format::

        anvil://[user:pass@]host[:port][/database]
        anvil+tls://[user:pass@]host[:port][/database]

    Args:
        uri: The connection URI string.

    Returns:
        A parsed :class:`AnvilUri` instance.

    Raises:
        ValueError: If the URI scheme is not ``anvil`` or ``anvil+tls``.
    """
    # Replace custom scheme with http so urlparse handles it correctly
    tls = False
    if uri.startswith("anvil+tls://"):
        tls = True
        parse_uri = "http://" + uri[len("anvil+tls://"):]
    elif uri.startswith("anvil://"):
        parse_uri = "http://" + uri[len("anvil://"):]
    else:
        raise ValueError(
            f"Invalid Anvil URI scheme: expected 'anvil://' or 'anvil+tls://', got '{uri}'"
        )

    parsed = urlparse(parse_uri)

    host = parsed.hostname or "localhost"
    port = parsed.port or 7474

    username: str | None = None
    password: str | None = None
    if parsed.username:
        username = unquote(parsed.username)
    if parsed.password:
        password = unquote(parsed.password)

    database: str | None = None
    if parsed.path and parsed.path.strip("/"):
        database = parsed.path.strip("/")

    return AnvilUri(
        host=host,
        port=port,
        database=database,
        username=username,
        password=password,
        tls=tls,
    )
