"""File storage namespace for the Anvil DB Python client (Phase 25.13).

Wraps the ``/storage/v1/...`` REST API exposed by the server. The surface
mirrors the Supabase Storage SDK where the signatures overlap, so existing
code patterns translate directly.

Two layers:
- :class:`Storage` / :class:`AsyncStorage` -- bucket-level CRUD + ``from()`` builder.
- :class:`StorageBucketBuilder` / :class:`AsyncStorageBucketBuilder` -- object operations.

Example::

    storage = client.storage
    storage.create_bucket("avatars", public=True, file_size_limit="5MB")
    storage.from_bucket("avatars").upload("alice.png", png_bytes)
    blob = storage.from_bucket("avatars").download("alice.png")
    url = storage.from_bucket("avatars").get_public_url("alice.png").public_url
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Iterable, Iterator, Sequence
from urllib.parse import quote

if TYPE_CHECKING:
    import httpx

    from .client import AnvilClient, AsyncAnvilClient

from .errors import AnvilError


__all__ = [
    "AsyncStorage",
    "AsyncStorageBucketBuilder",
    "Bucket",
    "BucketUsage",
    "Download",
    "FileObject",
    "ImageTransform",
    "ListOptions",
    "ObjectMetadata",
    "ResumableUploadResult",
    "SignedUploadUrlResult",
    "SignedUrlResult",
    "SortBy",
    "Storage",
    "StorageBucketBuilder",
    "UploadProgress",
    "UploadResult",
    "UsageReport",
    "UserUsage",
    "encode_path",
    "encode_upload_metadata",
    "infer_content_type",
    "parse_byte_size",
]


STORAGE_PREFIX = "/storage/v1"


# Sentinel used to distinguish "not provided" from "set to None" in
# update_bucket: None legitimately means "clear the existing limit", so a
# third state is needed.
class _Unset:
    pass


_UNSET: _Unset = _Unset()


# ---------------------------------------------------------------------------
# Dataclasses (camelCase wire format -> snake_case Python)
# ---------------------------------------------------------------------------


@dataclass
class Bucket:
    """A storage bucket as returned by ``GET /storage/v1/bucket``."""

    id: str
    name: str
    public: bool
    file_size_limit: int | None
    bucket_size_limit: int | None
    allowed_mime_types: list[str]
    owner: str
    created_at: int
    updated_at: int


@dataclass
class UploadProgress:
    """Progress payload emitted during a resumable upload."""

    loaded: int
    total: int
    percent: float


@dataclass
class UploadResult:
    """Object descriptor returned by single-shot and resumable uploads."""

    id: str
    bucket_id: str
    path: str
    name: str
    mime_type: str
    size: int
    etag: str
    content_hash: str
    version: int
    deduped: bool
    created_at: int
    updated_at: int


@dataclass
class ResumableUploadResult:
    """Result of :meth:`AsyncStorageBucketBuilder.upload_resumable`.

    Adds the TUS session URL so callers can resume after a failure.
    """

    result: UploadResult
    session_url: str


@dataclass
class ObjectMetadata(UploadResult):
    """Richer metadata returned by copy/move endpoints."""

    metadata: dict[str, Any] = field(default_factory=dict)
    owner: str = ""
    last_accessed_at: int = 0


@dataclass
class ImageTransform:
    """Image transformation options for ``get_public_url`` / ``create_signed_url``."""

    width: int | None = None
    height: int | None = None
    resize: str | None = None  # "cover" | "contain" | "fill"
    format: str | None = None  # "webp" | "jpeg" | "png" | "avif"
    quality: int | None = None

    def is_empty(self) -> bool:
        return (
            self.width is None
            and self.height is None
            and self.resize is None
            and self.format is None
            and self.quality is None
        )

    def to_query(self) -> str:
        pairs: list[tuple[str, str]] = []
        if self.width is not None:
            pairs.append(("width", str(self.width)))
        if self.height is not None:
            pairs.append(("height", str(self.height)))
        if self.resize is not None:
            pairs.append(("resize", self.resize))
        if self.format is not None:
            pairs.append(("format", self.format))
        if self.quality is not None:
            pairs.append(("quality", str(self.quality)))
        return "&".join(f"{k}={quote(v, safe='')}" for k, v in pairs)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.width is not None:
            out["width"] = self.width
        if self.height is not None:
            out["height"] = self.height
        if self.resize is not None:
            out["resize"] = self.resize
        if self.format is not None:
            out["format"] = self.format
        if self.quality is not None:
            out["quality"] = self.quality
        return out


@dataclass
class Download:
    """Either a bare ``?download`` flag or ``?download=<filename>``."""

    filename: str | None = None  # ``None`` means "bare flag"


@dataclass
class PublicUrlResult:
    public_url: str


@dataclass
class SignedUrlResult:
    signed_url: str
    token: str
    expires_at: int
    expires_in: int


@dataclass
class SignedUploadUrlResult:
    signed_url: str
    token: str
    expires_at: int
    expires_in: int


@dataclass
class SortBy:
    column: str  # "name" | "size" | "created_at" | "updated_at"
    order: str | None = None  # "asc" | "desc"


@dataclass
class ListOptions:
    limit: int | None = None
    offset: int | None = None
    sort_by: SortBy | None = None


@dataclass
class FileObject:
    path: str
    name: str
    size: int
    mime_type: str
    etag: str
    content_hash: str
    created_at: int
    updated_at: int


@dataclass
class ListResult:
    bucket_id: str
    items: list[FileObject]
    total: int
    limit: int
    offset: int


@dataclass
class BucketUsage:
    bucket_id: str
    object_count: int
    total_bytes: int
    bucket_size_limit: int | None = None


@dataclass
class UserUsage:
    owner: str
    object_count: int
    total_bytes: int


@dataclass
class UsageReport:
    object_count: int
    total_bytes: int
    buckets: list[BucketUsage]
    users: list[UserUsage]
    max_total_storage: int | None = None


# ---------------------------------------------------------------------------
# Helpers (pure -- no I/O)
# ---------------------------------------------------------------------------


_BYTE_SIZE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)?$", re.IGNORECASE)
_BYTE_SIZE_MULTS: dict[str, int] = {
    "B": 1,
    "KB": 1_000,
    "MB": 1_000_000,
    "GB": 1_000_000_000,
    "TB": 1_000_000_000_000,
    "KIB": 1024,
    "MIB": 1024 ** 2,
    "GIB": 1024 ** 3,
    "TIB": 1024 ** 4,
}


def parse_byte_size(value: int | str) -> int:
    """Parse a byte-size hint into an integer.

    Accepts either a plain integer (returned unchanged) or a string with a
    unit suffix using either SI (``KB`` / ``MB`` / ``GB`` / ``TB``) or IEC
    (``KiB`` / ``MiB`` / ``GiB`` / ``TiB``) multipliers. Bare numeric strings
    are also accepted.

    Args:
        value: Either an ``int`` byte count or a string like ``"5MB"``.

    Returns:
        The size in bytes.

    Raises:
        ValueError: When the value cannot be parsed or is negative.
    """
    if isinstance(value, int):
        if value < 0:
            raise ValueError(f"invalid byte size: {value}")
        return value
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("empty byte-size string")
    m = _BYTE_SIZE_RE.match(trimmed)
    if not m:
        raise ValueError(f"invalid byte size: {value}")
    n = float(m.group(1))
    unit = (m.group(2) or "B").upper()
    mult = _BYTE_SIZE_MULTS.get(unit)
    if mult is None:
        raise ValueError(f"unknown byte-size unit: {unit}")
    return int(n * mult)


def encode_path(path: str) -> str:
    """Percent-encode each ``/``-separated path segment.

    Slashes are preserved literally (the server uses an axum ``{*path}``
    capture which expects raw separators); everything else is encoded.
    """
    return "/".join(quote(seg, safe="") for seg in path.split("/"))


def encode_upload_metadata(meta: dict[str, str]) -> str:
    """Encode the TUS ``Upload-Metadata`` header.

    Each value is base64-encoded UTF-8 and key/value pairs are joined with
    commas, per the TUS spec.
    """
    return ",".join(
        f"{k} {base64.b64encode(v.encode('utf-8')).decode('ascii')}"
        for k, v in meta.items()
    )


_MIME_BY_EXT: dict[str, str] = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "avif": "image/avif",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "json": "application/json",
    "js": "application/javascript",
    "css": "text/css",
    "html": "text/html",
    "htm": "text/html",
    "csv": "text/csv",
    "md": "text/markdown",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "zip": "application/zip",
}


def infer_content_type(path: str) -> str | None:
    """Guess a MIME type from a file extension. Returns ``None`` on miss."""
    lower = path.lower()
    if "." not in lower:
        return None
    ext = lower.rsplit(".", 1)[1]
    return _MIME_BY_EXT.get(ext)


# ---------------------------------------------------------------------------
# Normalization helpers (server snake_case -> Python dataclasses)
# ---------------------------------------------------------------------------


def _bucket_from_dict(raw: dict[str, Any]) -> Bucket:
    return Bucket(
        id=raw["id"],
        name=raw.get("name", raw["id"]),
        public=bool(raw.get("public", False)),
        file_size_limit=raw.get("file_size_limit"),
        bucket_size_limit=raw.get("bucket_size_limit"),
        allowed_mime_types=list(raw.get("allowed_mime_types") or []),
        owner=raw.get("owner", ""),
        created_at=int(raw.get("created_at", 0)),
        updated_at=int(raw.get("updated_at", 0)),
    )


def _upload_from_dict(raw: dict[str, Any]) -> UploadResult:
    return UploadResult(
        id=raw["id"],
        bucket_id=raw["bucket_id"],
        path=raw["path"],
        name=raw["name"],
        mime_type=raw["mime_type"],
        size=int(raw["size"]),
        etag=raw["etag"],
        content_hash=raw["content_hash"],
        version=int(raw["version"]),
        deduped=bool(raw.get("deduped", False)),
        created_at=int(raw["created_at"]),
        updated_at=int(raw["updated_at"]),
    )


def _metadata_from_dict(raw: dict[str, Any]) -> ObjectMetadata:
    base = _upload_from_dict(raw)
    return ObjectMetadata(
        id=base.id,
        bucket_id=base.bucket_id,
        path=base.path,
        name=base.name,
        mime_type=base.mime_type,
        size=base.size,
        etag=base.etag,
        content_hash=base.content_hash,
        version=base.version,
        deduped=base.deduped,
        created_at=base.created_at,
        updated_at=base.updated_at,
        metadata=dict(raw.get("metadata") or {}),
        owner=raw.get("owner", ""),
        last_accessed_at=int(raw.get("last_accessed_at", 0)),
    )


def _file_from_dict(raw: dict[str, Any]) -> FileObject:
    return FileObject(
        path=raw["path"],
        name=raw["name"],
        size=int(raw["size"]),
        mime_type=raw["mime_type"],
        etag=raw["etag"],
        content_hash=raw["content_hash"],
        created_at=int(raw["created_at"]),
        updated_at=int(raw["updated_at"]),
    )


def _usage_from_dict(raw: dict[str, Any]) -> UsageReport:
    buckets_raw = raw.get("buckets") or []
    users_raw = raw.get("users") or []
    return UsageReport(
        object_count=int(raw.get("object_count", 0)),
        total_bytes=int(raw.get("total_bytes", 0)),
        buckets=[
            BucketUsage(
                bucket_id=b["bucket_id"],
                object_count=int(b.get("object_count", 0)),
                total_bytes=int(b.get("total_bytes", 0)),
                bucket_size_limit=b.get("bucket_size_limit"),
            )
            for b in buckets_raw
        ],
        users=[
            UserUsage(
                owner=u["owner"],
                object_count=int(u.get("object_count", 0)),
                total_bytes=int(u.get("total_bytes", 0)),
            )
            for u in users_raw
        ],
        max_total_storage=raw.get("max_total_storage"),
    )


def _list_from_dict(raw: dict[str, Any]) -> ListResult:
    return ListResult(
        bucket_id=raw["bucket_id"],
        items=[_file_from_dict(x) for x in raw.get("items") or []],
        total=int(raw.get("total", 0)),
        limit=int(raw.get("limit", 0)),
        offset=int(raw.get("offset", 0)),
    )


def _raise_for_response(resp: "httpx.Response") -> None:
    """Raise ``AnvilError`` for any non-2xx response, mirroring the server's
    JSON error body when present.
    """
    if 200 <= resp.status_code < 300:
        return
    body: str | None
    try:
        data = resp.json()
        body = data.get("error") if isinstance(data, dict) else None
    except Exception:
        data = None
        body = None
    if not body:
        body = resp.text
    raise AnvilError(resp.status_code, resp.reason_phrase or "", body)


# ---------------------------------------------------------------------------
# Shared base for builder URL construction
# ---------------------------------------------------------------------------


def _object_path(bucket: str, path: str) -> str:
    return f"{STORAGE_PREFIX}/object/{quote(bucket, safe='')}/{encode_path(path)}"


def _bucket_route(bucket_id: str) -> str:
    return f"{STORAGE_PREFIX}/bucket/{quote(bucket_id, safe='')}"


def _public_url_query(transform: ImageTransform | None, download: Download | None) -> str:
    qs = transform.to_query() if transform else ""
    if download is not None:
        prefix = "&" if qs else ""
        if download.filename is None:
            qs += f"{prefix}download"
        else:
            qs += f"{prefix}download={quote(download.filename, safe='')}"
    return qs


# ---------------------------------------------------------------------------
# Sync API
# ---------------------------------------------------------------------------


class StorageBucketBuilder:
    """Per-bucket synchronous operations. Obtain via :meth:`Storage.from_bucket`."""

    def __init__(self, client: "AnvilClient", bucket: str) -> None:
        self._client = client
        self.bucket = bucket

    # -- upload (single-shot) -------------------------------------------------

    def upload(
        self,
        path: str,
        body: bytes | bytearray | memoryview,
        *,
        content_type: str | None = None,
        upsert: bool = False,
        cache_control: str | None = None,
    ) -> UploadResult:
        """Upload a small file in a single request. Prefer
        :meth:`upload_resumable` for files larger than a few megabytes.
        """
        mime = content_type or infer_content_type(path) or "application/octet-stream"
        headers: dict[str, str] = {"Content-Type": mime}
        if cache_control:
            headers["Cache-Control"] = cache_control
        method = "PUT" if upsert else "POST"
        resp = self._client._storage_raw(  # noqa: SLF001
            method, _object_path(self.bucket, path), content=bytes(body), headers=headers
        )
        _raise_for_response(resp)
        return _upload_from_dict(resp.json())

    # -- upload (resumable) ---------------------------------------------------

    def upload_resumable(
        self,
        path: str,
        body: bytes | bytearray | memoryview,
        *,
        content_type: str | None = None,
        chunk_size: int = 5 * 1024 * 1024,
        on_progress: Callable[[UploadProgress], None] | None = None,
        resume_from: str | None = None,
    ) -> ResumableUploadResult:
        """Upload a file using the TUS 1.0.0 resumable protocol."""
        data = bytes(body)
        total = len(data)
        if chunk_size <= 0:
            raise ValueError("chunk_size must be > 0")
        mime = content_type or infer_content_type(path) or "application/octet-stream"
        if resume_from:
            session_url = resume_from
            offset = self._tus_head_offset(session_url)
        else:
            session_url = self._tus_create(path, total, mime)
            offset = 0

        final_resp = None
        while offset < total:
            end = min(offset + chunk_size, total)
            chunk = data[offset:end]
            offset, final_resp = self._tus_patch(session_url, offset, chunk)
            if on_progress is not None:
                pct = 100.0 if total == 0 else round((offset / total) * 10_000) / 100.0
                on_progress(UploadProgress(loaded=offset, total=total, percent=pct))

        content_hash = ""
        if final_resp is not None:
            content_hash = final_resp.headers.get("x-anvil-content-hash", "")
        etag = f'W/"{content_hash}"' if content_hash else ""
        result = UploadResult(
            id="",
            bucket_id=self.bucket,
            path=path,
            name=path.rsplit("/", 1)[-1],
            mime_type=mime,
            size=total,
            etag=etag,
            content_hash=content_hash,
            version=0,
            deduped=False,
            created_at=0,
            updated_at=0,
        )
        return ResumableUploadResult(result=result, session_url=session_url)

    def _tus_create(self, path: str, length: int, mime: str) -> str:
        metadata = encode_upload_metadata({"bucket": self.bucket, "path": path, "mime": mime})
        headers = {
            "Tus-Resumable": "1.0.0",
            "Upload-Length": str(length),
            "Upload-Metadata": metadata,
        }
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST",
            f"{STORAGE_PREFIX}/upload/resumable",
            content=b"",
            headers=headers,
        )
        if resp.status_code != 201:
            _raise_for_response(resp)
        location = resp.headers.get("Location") or resp.headers.get("location")
        if not location:
            raise AnvilError(0, "TUS server returned no Location header", None)
        return location

    def _tus_head_offset(self, session_url: str) -> int:
        resp = self._client._storage_raw(  # noqa: SLF001
            "HEAD",
            session_url,
            content=b"",
            headers={"Tus-Resumable": "1.0.0"},
        )
        _raise_for_response(resp)
        off = resp.headers.get("Upload-Offset") or resp.headers.get("upload-offset")
        if off is None:
            raise AnvilError(0, "TUS HEAD returned no Upload-Offset header", None)
        return int(off)

    def _tus_patch(
        self,
        session_url: str,
        offset: int,
        chunk: bytes,
    ) -> tuple[int, "httpx.Response"]:
        headers = {
            "Tus-Resumable": "1.0.0",
            "Content-Type": "application/offset+octet-stream",
            "Upload-Offset": str(offset),
        }
        resp = self._client._storage_raw(  # noqa: SLF001
            "PATCH", session_url, content=chunk, headers=headers
        )
        _raise_for_response(resp)
        new_off = resp.headers.get("Upload-Offset") or resp.headers.get("upload-offset")
        if new_off is None:
            raise AnvilError(0, "TUS PATCH returned no Upload-Offset header", None)
        return int(new_off), resp

    # -- download -------------------------------------------------------------

    def download(self, path: str) -> bytes:
        """Download an object as a ``bytes`` object."""
        resp = self._client._storage_raw(  # noqa: SLF001
            "GET", _object_path(self.bucket, path), content=b"", headers={}
        )
        _raise_for_response(resp)
        return resp.content

    def download_stream(self, path: str) -> Iterator[bytes]:
        """Stream an object's bytes in chunks without buffering the whole body."""
        return self._client._storage_stream(  # noqa: SLF001
            "GET", _object_path(self.bucket, path)
        )

    # -- URLs -----------------------------------------------------------------

    def get_public_url(
        self,
        path: str,
        *,
        transform: ImageTransform | None = None,
        download: Download | None = None,
    ) -> PublicUrlResult:
        """Build a public download URL. The bucket must be public."""
        encoded = f"{quote(self.bucket, safe='')}/{encode_path(path)}"
        if transform is not None:
            route = f"{STORAGE_PREFIX}/render/image/public/{encoded}"
        else:
            route = f"{STORAGE_PREFIX}/object/public/{encoded}"
        qs = _public_url_query(transform, download)
        url = f"{self._client._base_url}{route}"  # noqa: SLF001
        if qs:
            url = f"{url}?{qs}"
        return PublicUrlResult(public_url=url)

    def create_signed_url(
        self,
        path: str,
        expires_in: int,
        *,
        transform: ImageTransform | None = None,
        download: Download | None = None,
    ) -> SignedUrlResult:
        """Mint a signed download URL."""
        encoded = f"{quote(self.bucket, safe='')}/{encode_path(path)}"
        route = (
            f"{STORAGE_PREFIX}/render/image/sign/{encoded}"
            if transform is not None
            else f"{STORAGE_PREFIX}/object/sign/{encoded}"
        )
        body: dict[str, Any] = {"expires_in": expires_in}
        if transform is not None:
            body["transform"] = transform.to_json()
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST", route, content=None, json=body, headers={"Content-Type": "application/json"}
        )
        _raise_for_response(resp)
        raw = resp.json()
        signed_url = f"{self._client._base_url}{raw['url']}"  # noqa: SLF001
        if download is not None:
            if download.filename is None:
                signed_url += "?download"
            else:
                signed_url += f"?download={quote(download.filename, safe='')}"
        return SignedUrlResult(
            signed_url=signed_url,
            token=raw["token"],
            expires_at=int(raw["expires_at"]),
            expires_in=int(raw["expires_in"]),
        )

    def create_signed_upload_url(
        self,
        path: str,
        *,
        expires_in: int = 0,
    ) -> SignedUploadUrlResult:
        """Mint a signed upload URL."""
        encoded = f"{quote(self.bucket, safe='')}/{encode_path(path)}"
        route = f"{STORAGE_PREFIX}/object/upload/sign/{encoded}"
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST",
            route,
            content=None,
            json={"expires_in": expires_in},
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        raw = resp.json()
        return SignedUploadUrlResult(
            signed_url=f"{self._client._base_url}{raw['url']}",  # noqa: SLF001
            token=raw["token"],
            expires_at=int(raw["expires_at"]),
            expires_in=int(raw["expires_in"]),
        )

    # -- list / move / copy / remove -----------------------------------------

    def list(
        self,
        prefix: str | None = None,
        *,
        limit: int | None = None,
        offset: int | None = None,
        sort_by: SortBy | None = None,
    ) -> ListResult:
        """List objects, optionally filtered by a path prefix."""
        route = f"{STORAGE_PREFIX}/object/list/{quote(self.bucket, safe='')}"
        body: dict[str, Any] = {}
        if prefix:
            body["prefix"] = prefix
        if limit is not None:
            body["limit"] = limit
        if offset is not None:
            body["offset"] = offset
        if sort_by is not None:
            body["sort_by"] = sort_by.column
            if sort_by.order is not None:
                body["order"] = sort_by.order
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST", route, content=None, json=body, headers={"Content-Type": "application/json"}
        )
        _raise_for_response(resp)
        return _list_from_dict(resp.json())

    def move(self, from_path: str, to_path: str) -> ObjectMetadata:
        return self._move_or_copy("move", from_path, to_path)

    def copy(self, from_path: str, to_path: str) -> ObjectMetadata:
        return self._move_or_copy("copy", from_path, to_path)

    def _move_or_copy(self, op: str, from_path: str, to_path: str) -> ObjectMetadata:
        body = {
            "source_bucket": self.bucket,
            "source_path": from_path,
            "dest_bucket": self.bucket,
            "dest_path": to_path,
        }
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST",
            f"{STORAGE_PREFIX}/object/{op}",
            content=None,
            json=body,
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        return _metadata_from_dict(resp.json())

    def remove(self, paths: Sequence[str]) -> list[str]:
        """Delete one or more objects. Missing paths are skipped silently."""
        deleted: list[str] = []
        for p in paths:
            resp = self._client._storage_raw(  # noqa: SLF001
                "DELETE", _object_path(self.bucket, p), content=b"", headers={}
            )
            if resp.status_code == 404:
                continue
            _raise_for_response(resp)
            deleted.append(p)
        return deleted

    def exists(self, path: str) -> bool:
        """True iff an object exists at the given path."""
        resp = self._client._storage_raw(  # noqa: SLF001
            "HEAD", _object_path(self.bucket, path), content=b"", headers={}
        )
        if resp.status_code == 404:
            return False
        _raise_for_response(resp)
        return True


class Storage:
    """File storage namespace. Obtain via :attr:`AnvilClient.storage`."""

    def __init__(self, client: "AnvilClient") -> None:
        self._client = client

    def from_bucket(self, bucket: str) -> StorageBucketBuilder:
        """Scope subsequent calls to a single bucket."""
        return StorageBucketBuilder(self._client, bucket)

    def create_bucket(
        self,
        bucket_id: str,
        *,
        public: bool = False,
        file_size_limit: int | str | None = None,
        bucket_size_limit: int | str | None = None,
        allowed_mime_types: Iterable[str] | None = None,
    ) -> Bucket:
        body: dict[str, Any] = {"id": bucket_id, "public": public}
        if file_size_limit is not None:
            body["file_size_limit"] = parse_byte_size(file_size_limit)
        if bucket_size_limit is not None:
            body["bucket_size_limit"] = parse_byte_size(bucket_size_limit)
        if allowed_mime_types is not None:
            body["allowed_mime_types"] = list(allowed_mime_types)
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST",
            f"{STORAGE_PREFIX}/bucket",
            content=None,
            json=body,
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        return _bucket_from_dict(resp.json())

    def list_buckets(self) -> list[Bucket]:
        resp = self._client._storage_raw(  # noqa: SLF001
            "GET", f"{STORAGE_PREFIX}/bucket", content=b"", headers={}
        )
        _raise_for_response(resp)
        return [_bucket_from_dict(b) for b in resp.json()]

    def get_bucket(self, bucket_id: str) -> Bucket:
        resp = self._client._storage_raw(  # noqa: SLF001
            "GET", _bucket_route(bucket_id), content=b"", headers={}
        )
        _raise_for_response(resp)
        return _bucket_from_dict(resp.json())

    def update_bucket(
        self,
        bucket_id: str,
        *,
        public: bool | None = None,
        file_size_limit: int | str | None | _Unset = _UNSET,
        bucket_size_limit: int | str | None | _Unset = _UNSET,
        allowed_mime_types: Iterable[str] | None = None,
    ) -> Bucket:
        body: dict[str, Any] = {}
        if public is not None:
            body["public"] = public
        if file_size_limit is not _UNSET:
            body["file_size_limit"] = None if file_size_limit is None else parse_byte_size(file_size_limit)
        if bucket_size_limit is not _UNSET:
            body["bucket_size_limit"] = None if bucket_size_limit is None else parse_byte_size(bucket_size_limit)
        if allowed_mime_types is not None:
            body["allowed_mime_types"] = list(allowed_mime_types)
        resp = self._client._storage_raw(  # noqa: SLF001
            "PUT",
            _bucket_route(bucket_id),
            content=None,
            json=body,
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        return _bucket_from_dict(resp.json())

    def delete_bucket(self, bucket_id: str) -> None:
        resp = self._client._storage_raw(  # noqa: SLF001
            "DELETE", _bucket_route(bucket_id), content=b"", headers={}
        )
        _raise_for_response(resp)

    def empty_bucket(self, bucket_id: str) -> None:
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST", f"{_bucket_route(bucket_id)}/empty", content=b"", headers={}
        )
        _raise_for_response(resp)

    def revoke_signed_urls(self, bucket_id: str) -> None:
        resp = self._client._storage_raw(  # noqa: SLF001
            "POST", f"{_bucket_route(bucket_id)}/sign-revoke", content=b"", headers={}
        )
        _raise_for_response(resp)

    def usage(self) -> UsageReport:
        resp = self._client._storage_raw(  # noqa: SLF001
            "GET", f"{STORAGE_PREFIX}/usage", content=b"", headers={}
        )
        _raise_for_response(resp)
        return _usage_from_dict(resp.json())


# ---------------------------------------------------------------------------
# Async API
# ---------------------------------------------------------------------------


class AsyncStorageBucketBuilder:
    """Per-bucket asynchronous operations. Obtain via :meth:`AsyncStorage.from_bucket`."""

    def __init__(self, client: "AsyncAnvilClient", bucket: str) -> None:
        self._client = client
        self.bucket = bucket

    async def upload(
        self,
        path: str,
        body: bytes | bytearray | memoryview,
        *,
        content_type: str | None = None,
        upsert: bool = False,
        cache_control: str | None = None,
    ) -> UploadResult:
        mime = content_type or infer_content_type(path) or "application/octet-stream"
        headers: dict[str, str] = {"Content-Type": mime}
        if cache_control:
            headers["Cache-Control"] = cache_control
        method = "PUT" if upsert else "POST"
        resp = await self._client._storage_raw(  # noqa: SLF001
            method, _object_path(self.bucket, path), content=bytes(body), headers=headers
        )
        _raise_for_response(resp)
        return _upload_from_dict(resp.json())

    async def upload_resumable(
        self,
        path: str,
        body: bytes | bytearray | memoryview,
        *,
        content_type: str | None = None,
        chunk_size: int = 5 * 1024 * 1024,
        on_progress: Callable[[UploadProgress], None] | None = None,
        resume_from: str | None = None,
    ) -> ResumableUploadResult:
        data = bytes(body)
        total = len(data)
        if chunk_size <= 0:
            raise ValueError("chunk_size must be > 0")
        mime = content_type or infer_content_type(path) or "application/octet-stream"
        if resume_from:
            session_url = resume_from
            offset = await self._tus_head_offset(session_url)
        else:
            session_url = await self._tus_create(path, total, mime)
            offset = 0

        final_resp = None
        while offset < total:
            end = min(offset + chunk_size, total)
            chunk = data[offset:end]
            offset, final_resp = await self._tus_patch(session_url, offset, chunk)
            if on_progress is not None:
                pct = 100.0 if total == 0 else round((offset / total) * 10_000) / 100.0
                on_progress(UploadProgress(loaded=offset, total=total, percent=pct))

        content_hash = ""
        if final_resp is not None:
            content_hash = final_resp.headers.get("x-anvil-content-hash", "")
        etag = f'W/"{content_hash}"' if content_hash else ""
        result = UploadResult(
            id="",
            bucket_id=self.bucket,
            path=path,
            name=path.rsplit("/", 1)[-1],
            mime_type=mime,
            size=total,
            etag=etag,
            content_hash=content_hash,
            version=0,
            deduped=False,
            created_at=0,
            updated_at=0,
        )
        return ResumableUploadResult(result=result, session_url=session_url)

    async def _tus_create(self, path: str, length: int, mime: str) -> str:
        metadata = encode_upload_metadata({"bucket": self.bucket, "path": path, "mime": mime})
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST",
            f"{STORAGE_PREFIX}/upload/resumable",
            content=b"",
            headers={
                "Tus-Resumable": "1.0.0",
                "Upload-Length": str(length),
                "Upload-Metadata": metadata,
            },
        )
        if resp.status_code != 201:
            _raise_for_response(resp)
        location = resp.headers.get("Location") or resp.headers.get("location")
        if not location:
            raise AnvilError(0, "TUS server returned no Location header", None)
        return location

    async def _tus_head_offset(self, session_url: str) -> int:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "HEAD", session_url, content=b"", headers={"Tus-Resumable": "1.0.0"}
        )
        _raise_for_response(resp)
        off = resp.headers.get("Upload-Offset") or resp.headers.get("upload-offset")
        if off is None:
            raise AnvilError(0, "TUS HEAD returned no Upload-Offset header", None)
        return int(off)

    async def _tus_patch(
        self, session_url: str, offset: int, chunk: bytes
    ) -> tuple[int, "httpx.Response"]:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "PATCH",
            session_url,
            content=chunk,
            headers={
                "Tus-Resumable": "1.0.0",
                "Content-Type": "application/offset+octet-stream",
                "Upload-Offset": str(offset),
            },
        )
        _raise_for_response(resp)
        new_off = resp.headers.get("Upload-Offset") or resp.headers.get("upload-offset")
        if new_off is None:
            raise AnvilError(0, "TUS PATCH returned no Upload-Offset header", None)
        return int(new_off), resp

    async def download(self, path: str) -> bytes:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "GET", _object_path(self.bucket, path), content=b"", headers={}
        )
        _raise_for_response(resp)
        return resp.content

    def download_stream(self, path: str) -> AsyncIterator[bytes]:
        """Stream an object's bytes in chunks without buffering the whole body."""
        return self._client._storage_stream(  # noqa: SLF001
            "GET", _object_path(self.bucket, path)
        )

    def get_public_url(
        self,
        path: str,
        *,
        transform: ImageTransform | None = None,
        download: Download | None = None,
    ) -> PublicUrlResult:
        encoded = f"{quote(self.bucket, safe='')}/{encode_path(path)}"
        if transform is not None:
            route = f"{STORAGE_PREFIX}/render/image/public/{encoded}"
        else:
            route = f"{STORAGE_PREFIX}/object/public/{encoded}"
        qs = _public_url_query(transform, download)
        url = f"{self._client._base_url}{route}"  # noqa: SLF001
        if qs:
            url = f"{url}?{qs}"
        return PublicUrlResult(public_url=url)

    async def create_signed_url(
        self,
        path: str,
        expires_in: int,
        *,
        transform: ImageTransform | None = None,
        download: Download | None = None,
    ) -> SignedUrlResult:
        encoded = f"{quote(self.bucket, safe='')}/{encode_path(path)}"
        route = (
            f"{STORAGE_PREFIX}/render/image/sign/{encoded}"
            if transform is not None
            else f"{STORAGE_PREFIX}/object/sign/{encoded}"
        )
        body: dict[str, Any] = {"expires_in": expires_in}
        if transform is not None:
            body["transform"] = transform.to_json()
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST", route, content=None, json=body, headers={"Content-Type": "application/json"}
        )
        _raise_for_response(resp)
        raw = resp.json()
        signed_url = f"{self._client._base_url}{raw['url']}"  # noqa: SLF001
        if download is not None:
            if download.filename is None:
                signed_url += "?download"
            else:
                signed_url += f"?download={quote(download.filename, safe='')}"
        return SignedUrlResult(
            signed_url=signed_url,
            token=raw["token"],
            expires_at=int(raw["expires_at"]),
            expires_in=int(raw["expires_in"]),
        )

    async def create_signed_upload_url(
        self, path: str, *, expires_in: int = 0
    ) -> SignedUploadUrlResult:
        encoded = f"{quote(self.bucket, safe='')}/{encode_path(path)}"
        route = f"{STORAGE_PREFIX}/object/upload/sign/{encoded}"
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST",
            route,
            content=None,
            json={"expires_in": expires_in},
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        raw = resp.json()
        return SignedUploadUrlResult(
            signed_url=f"{self._client._base_url}{raw['url']}",  # noqa: SLF001
            token=raw["token"],
            expires_at=int(raw["expires_at"]),
            expires_in=int(raw["expires_in"]),
        )

    async def list(
        self,
        prefix: str | None = None,
        *,
        limit: int | None = None,
        offset: int | None = None,
        sort_by: SortBy | None = None,
    ) -> ListResult:
        route = f"{STORAGE_PREFIX}/object/list/{quote(self.bucket, safe='')}"
        body: dict[str, Any] = {}
        if prefix:
            body["prefix"] = prefix
        if limit is not None:
            body["limit"] = limit
        if offset is not None:
            body["offset"] = offset
        if sort_by is not None:
            body["sort_by"] = sort_by.column
            if sort_by.order is not None:
                body["order"] = sort_by.order
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST", route, content=None, json=body, headers={"Content-Type": "application/json"}
        )
        _raise_for_response(resp)
        return _list_from_dict(resp.json())

    async def move(self, from_path: str, to_path: str) -> ObjectMetadata:
        return await self._move_or_copy("move", from_path, to_path)

    async def copy(self, from_path: str, to_path: str) -> ObjectMetadata:
        return await self._move_or_copy("copy", from_path, to_path)

    async def _move_or_copy(self, op: str, from_path: str, to_path: str) -> ObjectMetadata:
        body = {
            "source_bucket": self.bucket,
            "source_path": from_path,
            "dest_bucket": self.bucket,
            "dest_path": to_path,
        }
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST",
            f"{STORAGE_PREFIX}/object/{op}",
            content=None,
            json=body,
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        return _metadata_from_dict(resp.json())

    async def remove(self, paths: Sequence[str]) -> list[str]:
        deleted: list[str] = []
        for p in paths:
            resp = await self._client._storage_raw(  # noqa: SLF001
                "DELETE", _object_path(self.bucket, p), content=b"", headers={}
            )
            if resp.status_code == 404:
                continue
            _raise_for_response(resp)
            deleted.append(p)
        return deleted

    async def exists(self, path: str) -> bool:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "HEAD", _object_path(self.bucket, path), content=b"", headers={}
        )
        if resp.status_code == 404:
            return False
        _raise_for_response(resp)
        return True


class AsyncStorage:
    """Async file storage namespace. Obtain via :attr:`AsyncAnvilClient.storage`."""

    def __init__(self, client: "AsyncAnvilClient") -> None:
        self._client = client

    def from_bucket(self, bucket: str) -> AsyncStorageBucketBuilder:
        return AsyncStorageBucketBuilder(self._client, bucket)

    async def create_bucket(
        self,
        bucket_id: str,
        *,
        public: bool = False,
        file_size_limit: int | str | None = None,
        bucket_size_limit: int | str | None = None,
        allowed_mime_types: Iterable[str] | None = None,
    ) -> Bucket:
        body: dict[str, Any] = {"id": bucket_id, "public": public}
        if file_size_limit is not None:
            body["file_size_limit"] = parse_byte_size(file_size_limit)
        if bucket_size_limit is not None:
            body["bucket_size_limit"] = parse_byte_size(bucket_size_limit)
        if allowed_mime_types is not None:
            body["allowed_mime_types"] = list(allowed_mime_types)
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST",
            f"{STORAGE_PREFIX}/bucket",
            content=None,
            json=body,
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        return _bucket_from_dict(resp.json())

    async def list_buckets(self) -> list[Bucket]:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "GET", f"{STORAGE_PREFIX}/bucket", content=b"", headers={}
        )
        _raise_for_response(resp)
        return [_bucket_from_dict(b) for b in resp.json()]

    async def get_bucket(self, bucket_id: str) -> Bucket:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "GET", _bucket_route(bucket_id), content=b"", headers={}
        )
        _raise_for_response(resp)
        return _bucket_from_dict(resp.json())

    async def update_bucket(
        self,
        bucket_id: str,
        *,
        public: bool | None = None,
        file_size_limit: int | str | None | _Unset = _UNSET,
        bucket_size_limit: int | str | None | _Unset = _UNSET,
        allowed_mime_types: Iterable[str] | None = None,
    ) -> Bucket:
        body: dict[str, Any] = {}
        if public is not None:
            body["public"] = public
        if file_size_limit is not _UNSET:
            body["file_size_limit"] = None if file_size_limit is None else parse_byte_size(file_size_limit)
        if bucket_size_limit is not _UNSET:
            body["bucket_size_limit"] = None if bucket_size_limit is None else parse_byte_size(bucket_size_limit)
        if allowed_mime_types is not None:
            body["allowed_mime_types"] = list(allowed_mime_types)
        resp = await self._client._storage_raw(  # noqa: SLF001
            "PUT",
            _bucket_route(bucket_id),
            content=None,
            json=body,
            headers={"Content-Type": "application/json"},
        )
        _raise_for_response(resp)
        return _bucket_from_dict(resp.json())

    async def delete_bucket(self, bucket_id: str) -> None:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "DELETE", _bucket_route(bucket_id), content=b"", headers={}
        )
        _raise_for_response(resp)

    async def empty_bucket(self, bucket_id: str) -> None:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST", f"{_bucket_route(bucket_id)}/empty", content=b"", headers={}
        )
        _raise_for_response(resp)

    async def revoke_signed_urls(self, bucket_id: str) -> None:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "POST", f"{_bucket_route(bucket_id)}/sign-revoke", content=b"", headers={}
        )
        _raise_for_response(resp)

    async def usage(self) -> UsageReport:
        resp = await self._client._storage_raw(  # noqa: SLF001
            "GET", f"{STORAGE_PREFIX}/usage", content=b"", headers={}
        )
        _raise_for_response(resp)
        return _usage_from_dict(resp.json())
