"""Unit tests for the Storage namespace (Phase 25.13)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from anvilent import (
    AnvilClient,
    AnvilError,
    AsyncAnvilClient,
    AsyncStorageBucketBuilder,
    Bucket,
    Download,
    ImageTransform,
    SortBy,
    StorageBucketBuilder,
)
from anvilent.storage import (
    encode_path,
    encode_upload_metadata,
    infer_content_type,
    parse_byte_size,
)


# ---------------------------------------------------------------------------
# Helper: mock transport that records every request and serves a queue of
# responses one at a time, mirroring the TS / vitest pattern.
# ---------------------------------------------------------------------------


class _Recorder:
    def __init__(self, responders: list) -> None:
        self.responders = list(responders)
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if not self.responders:
            raise AssertionError(f"unexpected request: {request.method} {request.url}")
        responder = self.responders.pop(0)
        return responder(request)


def _json_resp(body: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        content=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )


def _err_resp(status: int, error: str) -> httpx.Response:
    return httpx.Response(
        status,
        content=json.dumps({"error": error}).encode(),
        headers={"content-type": "application/json"},
    )


def _empty(status: int = 204, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, content=b"", headers=headers or {})


def _binary(status: int, body: bytes, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, content=body, headers=headers or {})


def _make_client(responders: list) -> tuple[AnvilClient, _Recorder]:
    recorder = _Recorder(responders)
    client = AnvilClient(base_url="http://localhost:7474")
    client._access_token = "test-token"  # noqa: SLF001
    # Swap the httpx.Client for one wired to our MockTransport.
    client._client = httpx.Client(  # noqa: SLF001
        base_url="http://localhost:7474",
        transport=httpx.MockTransport(recorder),
    )
    return client, recorder


def _make_async_client(responders: list) -> tuple[AsyncAnvilClient, _Recorder]:
    recorder = _Recorder(responders)
    client = AsyncAnvilClient(base_url="http://localhost:7474")
    client._access_token = "test-token"  # noqa: SLF001
    client._client = httpx.AsyncClient(  # noqa: SLF001
        base_url="http://localhost:7474",
        transport=httpx.MockTransport(recorder),
    )
    return client, recorder


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestParseByteSize:
    def test_bare_numbers(self) -> None:
        assert parse_byte_size(0) == 0
        assert parse_byte_size(1024) == 1024
        assert parse_byte_size("1024") == 1024

    def test_si_units(self) -> None:
        assert parse_byte_size("5MB") == 5_000_000
        assert parse_byte_size("1GB") == 1_000_000_000
        assert parse_byte_size("250 KB") == 250_000

    def test_iec_units(self) -> None:
        assert parse_byte_size("5MiB") == 5 * 1024 * 1024
        assert parse_byte_size("1GiB") == 1024 ** 3

    def test_garbage_rejected(self) -> None:
        with pytest.raises(ValueError):
            parse_byte_size("nope")
        with pytest.raises(ValueError):
            parse_byte_size("")
        with pytest.raises(ValueError):
            parse_byte_size(-1)


def test_encode_path_preserves_slashes() -> None:
    assert encode_path("users/alice/photo.png") == "users/alice/photo.png"
    assert encode_path("users/with space/file?.png") == "users/with%20space/file%3F.png"


def test_encode_upload_metadata_matches_tus_spec() -> None:
    s = encode_upload_metadata({"bucket": "avatars", "path": "alice.png"})
    assert s == "bucket YXZhdGFycw==,path YWxpY2UucG5n"


def test_infer_content_type_known_extensions() -> None:
    assert infer_content_type("alice.png") == "image/png"
    assert infer_content_type("clip.MP4") == "video/mp4"
    assert infer_content_type("no-extension") is None


# ---------------------------------------------------------------------------
# Storage namespace plumbing
# ---------------------------------------------------------------------------


def test_storage_property_is_cached() -> None:
    client, _ = _make_client([])
    a = client.storage
    b = client.storage
    assert a is b


def test_from_bucket_returns_builder() -> None:
    client, _ = _make_client([])
    builder = client.storage.from_bucket("avatars")
    assert isinstance(builder, StorageBucketBuilder)
    assert builder.bucket == "avatars"


# ---------------------------------------------------------------------------
# Bucket CRUD
# ---------------------------------------------------------------------------


def test_create_bucket_sends_body_and_parses_response() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "id": "avatars",
            "name": "avatars",
            "public": True,
            "file_size_limit": 5_000_000,
            "bucket_size_limit": None,
            "allowed_mime_types": ["image/png"],
            "owner": "admin",
            "created_at": 1700,
            "updated_at": 1700,
        }),
    ])
    bucket = client.storage.create_bucket(
        "avatars",
        public=True,
        file_size_limit="5MB",
        allowed_mime_types=["image/png"],
    )
    req = recorder.calls[0]
    assert req.method == "POST"
    assert str(req.url) == "http://localhost:7474/storage/v1/bucket"
    assert req.headers["authorization"] == "Bearer test-token"
    assert json.loads(req.content) == {
        "id": "avatars",
        "public": True,
        "file_size_limit": 5_000_000,
        "allowed_mime_types": ["image/png"],
    }
    assert isinstance(bucket, Bucket)
    assert bucket.public is True
    assert bucket.file_size_limit == 5_000_000
    assert bucket.bucket_size_limit is None
    assert bucket.allowed_mime_types == ["image/png"]


def test_list_buckets_returns_list() -> None:
    client, _ = _make_client([
        lambda r: _json_resp([
            {
                "id": "a",
                "name": "a",
                "public": False,
                "file_size_limit": None,
                "bucket_size_limit": None,
                "allowed_mime_types": [],
                "owner": "admin",
                "created_at": 1,
                "updated_at": 1,
            },
            {
                "id": "b",
                "name": "b",
                "public": True,
                "file_size_limit": 1000,
                "bucket_size_limit": 5000,
                "allowed_mime_types": ["image/*"],
                "owner": "admin",
                "created_at": 2,
                "updated_at": 2,
            },
        ]),
    ])
    buckets = client.storage.list_buckets()
    assert len(buckets) == 2
    assert buckets[1].bucket_size_limit == 5000


def test_update_bucket_clears_limits_with_none() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "id": "avatars",
            "name": "avatars",
            "public": False,
            "file_size_limit": None,
            "bucket_size_limit": None,
            "allowed_mime_types": [],
            "owner": "admin",
            "created_at": 1,
            "updated_at": 2,
        }),
    ])
    client.storage.update_bucket(
        "avatars",
        public=False,
        file_size_limit=None,
        bucket_size_limit=None,
    )
    body = json.loads(recorder.calls[0].content)
    assert body == {
        "public": False,
        "file_size_limit": None,
        "bucket_size_limit": None,
    }
    assert recorder.calls[0].method == "PUT"


def test_delete_and_empty_bucket_routes() -> None:
    client, recorder = _make_client([
        lambda r: _empty(),
        lambda r: _empty(),
    ])
    client.storage.empty_bucket("avatars")
    client.storage.delete_bucket("avatars")
    assert recorder.calls[0].method == "POST"
    assert str(recorder.calls[0].url) == "http://localhost:7474/storage/v1/bucket/avatars/empty"
    assert recorder.calls[1].method == "DELETE"
    assert str(recorder.calls[1].url) == "http://localhost:7474/storage/v1/bucket/avatars"


def test_create_bucket_propagates_error() -> None:
    client, _ = _make_client([lambda r: _err_resp(409, "bucket already exists")])
    with pytest.raises(AnvilError) as excinfo:
        client.storage.create_bucket("avatars", public=True)
    assert excinfo.value.status == 409
    assert "bucket already exists" in str(excinfo.value)


def test_usage_normalizes_nested_arrays() -> None:
    client, _ = _make_client([
        lambda r: _json_resp({
            "object_count": 42,
            "total_bytes": 1234,
            "buckets": [
                {"bucket_id": "a", "object_count": 1, "total_bytes": 100},
                {"bucket_id": "b", "object_count": 41, "total_bytes": 1134, "bucket_size_limit": 9000},
            ],
            "users": [{"owner": "alice", "object_count": 30, "total_bytes": 900}],
            "max_total_storage": 100000,
        }),
    ])
    usage = client.storage.usage()
    assert usage.object_count == 42
    assert usage.buckets[1].bucket_size_limit == 9000
    assert usage.users[0].owner == "alice"
    assert usage.max_total_storage == 100000


# ---------------------------------------------------------------------------
# Single-shot upload + download
# ---------------------------------------------------------------------------


def test_upload_posts_binary_and_infers_mime() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "id": "obj-1",
            "bucket_id": "avatars",
            "path": "alice.png",
            "name": "alice.png",
            "mime_type": "image/png",
            "size": 4,
            "etag": 'W/"abc"',
            "content_hash": "abc",
            "version": 1,
            "deduped": False,
            "created_at": 100,
            "updated_at": 100,
        }),
    ])
    result = client.storage.from_bucket("avatars").upload("alice.png", b"\x01\x02\x03\x04")
    req = recorder.calls[0]
    assert req.method == "POST"
    assert str(req.url) == "http://localhost:7474/storage/v1/object/avatars/alice.png"
    assert req.headers["content-type"] == "image/png"
    assert req.headers["authorization"] == "Bearer test-token"
    assert req.content == b"\x01\x02\x03\x04"
    assert result.id == "obj-1"
    assert result.content_hash == "abc"
    assert result.version == 1


def test_upload_uses_put_when_upsert() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "id": "obj-1",
            "bucket_id": "avatars",
            "path": "alice.png",
            "name": "alice.png",
            "mime_type": "image/png",
            "size": 1,
            "etag": "x",
            "content_hash": "x",
            "version": 2,
            "deduped": True,
            "created_at": 1,
            "updated_at": 2,
        }),
    ])
    client.storage.from_bucket("avatars").upload(
        "alice.png", b"\x01", upsert=True, content_type="image/png", cache_control="public, max-age=3600"
    )
    assert recorder.calls[0].method == "PUT"
    assert recorder.calls[0].headers["cache-control"] == "public, max-age=3600"


def test_upload_percent_encodes_path_segments() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "id": "x", "bucket_id": "avatars",
            "path": "users/alice has space/photo.png",
            "name": "photo.png", "mime_type": "image/png",
            "size": 1, "etag": "x", "content_hash": "x",
            "version": 1, "deduped": False,
            "created_at": 0, "updated_at": 0,
        }),
    ])
    client.storage.from_bucket("avatars").upload(
        "users/alice has space/photo.png", b"\x01"
    )
    assert str(recorder.calls[0].url) == (
        "http://localhost:7474/storage/v1/object/avatars/users/alice%20has%20space/photo.png"
    )


def test_download_returns_bytes() -> None:
    client, _ = _make_client([
        lambda r: _binary(200, b"\x07\x08\x09", {"content-type": "image/png"}),
    ])
    blob = client.storage.from_bucket("avatars").download("alice.png")
    assert blob == b"\x07\x08\x09"


def test_download_404_raises() -> None:
    client, _ = _make_client([lambda r: _err_resp(404, "not found")])
    with pytest.raises(AnvilError) as excinfo:
        client.storage.from_bucket("avatars").download("missing.png")
    assert excinfo.value.status == 404


# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------


def test_get_public_url_standard() -> None:
    client, _ = _make_client([])
    result = client.storage.from_bucket("avatars").get_public_url("alice.png")
    assert result.public_url == (
        "http://localhost:7474/storage/v1/object/public/avatars/alice.png"
    )


def test_get_public_url_with_transform() -> None:
    client, _ = _make_client([])
    result = client.storage.from_bucket("avatars").get_public_url(
        "alice.png",
        transform=ImageTransform(width=200, height=200, resize="cover", format="webp"),
    )
    assert "/storage/v1/render/image/public/avatars/alice.png" in result.public_url
    for fragment in ("width=200", "height=200", "resize=cover", "format=webp"):
        assert fragment in result.public_url


def test_get_public_url_with_download_filename() -> None:
    client, _ = _make_client([])
    result = client.storage.from_bucket("avatars").get_public_url(
        "alice.png", download=Download(filename="headshot.png")
    )
    assert "download=headshot.png" in result.public_url


def test_create_signed_url_posts_to_sign() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "token": "tok-xyz",
            "url": "/storage/v1/object/signed/tok-xyz",
            "expires_at": 5000,
            "expires_in": 60,
        }),
    ])
    result = client.storage.from_bucket("avatars").create_signed_url("alice.png", 60)
    assert recorder.calls[0].method == "POST"
    assert str(recorder.calls[0].url) == (
        "http://localhost:7474/storage/v1/object/sign/avatars/alice.png"
    )
    assert json.loads(recorder.calls[0].content) == {"expires_in": 60}
    assert result.signed_url == "http://localhost:7474/storage/v1/object/signed/tok-xyz"
    assert result.token == "tok-xyz"


def test_create_signed_url_routes_through_render_with_transform() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "token": "tok-rs",
            "url": "/storage/v1/object/signed/tok-rs",
            "expires_at": 5000,
            "expires_in": 60,
        }),
    ])
    client.storage.from_bucket("avatars").create_signed_url(
        "alice.png", 60, transform=ImageTransform(width=100)
    )
    assert str(recorder.calls[0].url) == (
        "http://localhost:7474/storage/v1/render/image/sign/avatars/alice.png"
    )
    body = json.loads(recorder.calls[0].content)
    assert body["transform"] == {"width": 100}


def test_create_signed_upload_url() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "token": "wtok",
            "url": "/storage/v1/object/upload/signed/wtok",
            "expires_at": 99,
            "expires_in": 99,
        }),
    ])
    result = client.storage.from_bucket("avatars").create_signed_upload_url(
        "alice.png", expires_in=120
    )
    assert str(recorder.calls[0].url) == (
        "http://localhost:7474/storage/v1/object/upload/sign/avatars/alice.png"
    )
    assert json.loads(recorder.calls[0].content) == {"expires_in": 120}
    assert result.signed_url == "http://localhost:7474/storage/v1/object/upload/signed/wtok"


# ---------------------------------------------------------------------------
# List / move / copy / remove
# ---------------------------------------------------------------------------


def test_list_posts_with_prefix_and_sort() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "bucket_id": "avatars",
            "items": [{
                "path": "users/alice.png",
                "name": "alice.png",
                "size": 100,
                "mime_type": "image/png",
                "etag": "x",
                "content_hash": "x",
                "created_at": 1,
                "updated_at": 2,
            }],
            "total": 1,
            "limit": 50,
            "offset": 0,
        }),
    ])
    result = client.storage.from_bucket("avatars").list(
        "users/", limit=50, offset=0, sort_by=SortBy("created_at", "desc")
    )
    assert json.loads(recorder.calls[0].content) == {
        "prefix": "users/",
        "limit": 50,
        "offset": 0,
        "sort_by": "created_at",
        "order": "desc",
    }
    assert result.items[0].path == "users/alice.png"


def test_move_posts_source_and_dest() -> None:
    client, recorder = _make_client([
        lambda r: _json_resp({
            "id": "obj-1",
            "bucket_id": "avatars",
            "path": "new.png",
            "name": "new.png",
            "mime_type": "image/png",
            "size": 1,
            "etag": "x",
            "content_hash": "x",
            "version": 2,
            "deduped": False,
            "metadata": {},
            "owner": "admin",
            "created_at": 1,
            "updated_at": 2,
            "last_accessed_at": 0,
        }),
    ])
    meta = client.storage.from_bucket("avatars").move("old.png", "new.png")
    assert recorder.calls[0].method == "POST"
    assert str(recorder.calls[0].url) == "http://localhost:7474/storage/v1/object/move"
    assert json.loads(recorder.calls[0].content) == {
        "source_bucket": "avatars",
        "source_path": "old.png",
        "dest_bucket": "avatars",
        "dest_path": "new.png",
    }
    assert meta.path == "new.png"


def test_remove_returns_successful_paths() -> None:
    client, recorder = _make_client([
        lambda r: _empty(204),
        lambda r: _err_resp(404, "not found"),
        lambda r: _empty(204),
    ])
    deleted = client.storage.from_bucket("avatars").remove(
        ["a.png", "ghost.png", "b.png"]
    )
    assert len(recorder.calls) == 3
    assert all(c.method == "DELETE" for c in recorder.calls)
    assert sorted(deleted) == ["a.png", "b.png"]


def test_exists_returns_true_for_2xx_and_false_for_404() -> None:
    client, _ = _make_client([
        lambda r: _empty(200),
        lambda r: _err_resp(404, "not found"),
    ])
    bucket = client.storage.from_bucket("avatars")
    assert bucket.exists("a.png") is True
    assert bucket.exists("ghost.png") is False


# ---------------------------------------------------------------------------
# Resumable / TUS
# ---------------------------------------------------------------------------


def test_upload_resumable_full_session() -> None:
    # 10 bytes, chunk_size=4 -> three PATCHes at offsets 0/4/8.
    data = bytes(range(1, 11))
    client, recorder = _make_client([
        lambda r: _empty(
            201,
            headers={
                "Location": "/storage/v1/upload/resumable/session-id",
                "Upload-Offset": "0",
                "Upload-Length": "10",
                "Tus-Resumable": "1.0.0",
            },
        ),
        lambda r: _empty(204, {"Upload-Offset": "4", "Tus-Resumable": "1.0.0"}),
        lambda r: _empty(204, {"Upload-Offset": "8", "Tus-Resumable": "1.0.0"}),
        lambda r: _empty(
            204,
            {
                "Upload-Offset": "10",
                "Tus-Resumable": "1.0.0",
                "Location": "/storage/v1/object/videos/intro.mp4",
                "X-Anvil-Content-Hash": "deadbeef",
            },
        ),
    ])

    progress: list[int] = []
    result = client.storage.from_bucket("videos").upload_resumable(
        "intro.mp4",
        data,
        chunk_size=4,
        content_type="video/mp4",
        on_progress=lambda p: progress.append(p.loaded),
    )
    # Session creation request.
    create_req = recorder.calls[0]
    assert create_req.method == "POST"
    assert str(create_req.url) == "http://localhost:7474/storage/v1/upload/resumable"
    assert create_req.headers["tus-resumable"] == "1.0.0"
    assert create_req.headers["upload-length"] == "10"
    for kw in ("bucket ", "path ", "mime "):
        assert kw in create_req.headers["upload-metadata"]

    # PATCH chunks.
    patch_offsets = [recorder.calls[i].headers["upload-offset"] for i in (1, 2, 3)]
    assert patch_offsets == ["0", "4", "8"]
    bodies = [recorder.calls[i].content for i in (1, 2, 3)]
    assert bodies == [data[0:4], data[4:8], data[8:10]]
    assert recorder.calls[1].headers["content-type"] == "application/offset+octet-stream"
    assert progress == [4, 8, 10]
    assert result.result.path == "intro.mp4"
    assert result.result.bucket_id == "videos"
    assert result.result.size == 10
    assert result.result.content_hash == "deadbeef"
    assert result.session_url == "/storage/v1/upload/resumable/session-id"


def test_upload_resumable_resume_from() -> None:
    data = bytes(range(8))
    client, recorder = _make_client([
        # HEAD: server says offset 4, length 8.
        lambda r: _empty(200, {
            "Upload-Offset": "4",
            "Upload-Length": "8",
            "Tus-Resumable": "1.0.0",
        }),
        # PATCH 4..8 final.
        lambda r: _empty(204, {
            "Upload-Offset": "8",
            "Tus-Resumable": "1.0.0",
            "Location": "/storage/v1/object/videos/clip.mp4",
            "X-Anvil-Content-Hash": "cafef00d",
        }),
    ])
    progress: list[int] = []
    result = client.storage.from_bucket("videos").upload_resumable(
        "clip.mp4",
        data,
        chunk_size=8,
        content_type="video/mp4",
        resume_from="/storage/v1/upload/resumable/existing",
        on_progress=lambda p: progress.append(p.loaded),
    )
    assert recorder.calls[0].method == "HEAD"
    assert recorder.calls[1].method == "PATCH"
    assert recorder.calls[1].headers["upload-offset"] == "4"
    assert recorder.calls[1].content == data[4:8]
    assert progress == [8]
    assert result.result.content_hash == "cafef00d"


def test_upload_resumable_propagates_patch_errors() -> None:
    client, _ = _make_client([
        lambda r: _empty(
            201,
            {"Location": "/storage/v1/upload/resumable/x", "Tus-Resumable": "1.0.0"},
        ),
        lambda r: _err_resp(409, "Upload-Offset mismatch"),
    ])
    with pytest.raises(AnvilError) as excinfo:
        client.storage.from_bucket("misc").upload_resumable(
            "x.bin", b"\x01\x02", chunk_size=2
        )
    assert excinfo.value.status == 409


# ---------------------------------------------------------------------------
# Async API smoke
# ---------------------------------------------------------------------------


def test_async_storage_property_is_cached() -> None:
    client, _ = _make_async_client([])
    a = client.storage
    b = client.storage
    assert a is b


def test_async_create_bucket_and_upload() -> None:
    async def run() -> None:
        client, recorder = _make_async_client([
            lambda r: _json_resp({
                "id": "avatars",
                "name": "avatars",
                "public": True,
                "file_size_limit": None,
                "bucket_size_limit": None,
                "allowed_mime_types": [],
                "owner": "admin",
                "created_at": 1,
                "updated_at": 1,
            }),
            lambda r: _json_resp({
                "id": "obj-1",
                "bucket_id": "avatars",
                "path": "alice.png",
                "name": "alice.png",
                "mime_type": "image/png",
                "size": 1,
                "etag": "x",
                "content_hash": "x",
                "version": 1,
                "deduped": False,
                "created_at": 1,
                "updated_at": 1,
            }),
        ])
        bucket = await client.storage.create_bucket("avatars", public=True)
        assert bucket.public is True
        builder = client.storage.from_bucket("avatars")
        assert isinstance(builder, AsyncStorageBucketBuilder)
        result = await builder.upload("alice.png", b"\x01")
        assert result.id == "obj-1"
        await client.close()

    asyncio.run(run())


def test_async_upload_resumable_full_session() -> None:
    async def run() -> None:
        data = bytes(range(1, 11))
        client, recorder = _make_async_client([
            lambda r: _empty(201, {
                "Location": "/storage/v1/upload/resumable/session-id",
                "Upload-Offset": "0",
                "Upload-Length": "10",
                "Tus-Resumable": "1.0.0",
            }),
            lambda r: _empty(204, {"Upload-Offset": "4", "Tus-Resumable": "1.0.0"}),
            lambda r: _empty(204, {"Upload-Offset": "8", "Tus-Resumable": "1.0.0"}),
            lambda r: _empty(204, {
                "Upload-Offset": "10",
                "Tus-Resumable": "1.0.0",
                "X-Anvil-Content-Hash": "deadbeef",
            }),
        ])
        result = await client.storage.from_bucket("videos").upload_resumable(
            "intro.mp4", data, chunk_size=4, content_type="video/mp4",
        )
        assert result.result.content_hash == "deadbeef"
        assert result.session_url == "/storage/v1/upload/resumable/session-id"
        await client.close()

    asyncio.run(run())


# ---------------------------------------------------------------------------
# 401 refresh retry on storage calls
# ---------------------------------------------------------------------------


def test_storage_inherits_401_refresh_retry() -> None:
    # The retry mechanism on _storage_raw mirrors _request: 401 + refresh
    # token present -> POST /auth/refresh, then replay.
    client = AnvilClient(base_url="http://localhost:7474")
    client._access_token = "old"  # noqa: SLF001
    client._refresh_token = "r"  # noqa: SLF001

    recorder = _Recorder([
        lambda r: _err_resp(401, "token expired"),
        lambda r: _json_resp({"access_token": "new", "refresh_token": "r2", "id_token": "id"}),
        lambda r: _json_resp([{
            "id": "x",
            "name": "x",
            "public": False,
            "file_size_limit": None,
            "bucket_size_limit": None,
            "allowed_mime_types": [],
            "owner": "admin",
            "created_at": 1,
            "updated_at": 1,
        }]),
    ])
    client._client = httpx.Client(  # noqa: SLF001
        base_url="http://localhost:7474",
        transport=httpx.MockTransport(recorder),
    )
    buckets = client.storage.list_buckets()
    assert len(recorder.calls) == 3
    assert recorder.calls[0].headers["authorization"] == "Bearer old"
    # The replay call (calls[2]) uses the new token from /auth/refresh.
    assert recorder.calls[2].headers["authorization"] == "Bearer new"
    assert buckets[0].id == "x"
