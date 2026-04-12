"""Error types for the Anvil DB client."""

from __future__ import annotations


class AnvilError(Exception):
    """Exception raised when an Anvil DB API request fails.

    Attributes:
        status: The HTTP status code returned by the server.
        status_text: A human-readable description of the HTTP status.
        body: The raw response body, if available.
    """

    def __init__(
        self,
        status: int,
        status_text: str,
        body: str | None = None,
    ) -> None:
        self.status = status
        self.status_text = status_text
        self.body = body
        message = f"AnvilError {status} {status_text}"
        if body:
            message += f": {body}"
        super().__init__(message)
