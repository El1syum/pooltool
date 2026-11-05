"""Shared model persistence, bounded GLB ingestion and separate admin auth."""

from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import re
import struct
import threading

from fastapi.testclient import TestClient
import pytest

from online.server.app import create_app
from online.server import assets


PASSWORD = "test-only-unique-password-123"
PASSWORD_HASH = assets.hash_admin_password(PASSWORD, salt=b"test-assets-salt")


def triangle_document(binary_size=36):
    return {
        "asset": {"version": "2.0"}, "scene": 0,
        "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
                       "min": [0, 0, 0], "max": [1, 1, 0]}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}],
        "buffers": [{"byteLength": binary_size}],
    }


def glb(document=None, *, binary_size=36):
    document = triangle_document(binary_size) if document is None else document
    raw = json.dumps(document, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 4)
    binary = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0) + b"\0" * (binary_size - 36)
    binary += b"\0" * (-len(binary) % 4)
    length = 12 + 8 + len(raw) + 8 + len(binary)
    return struct.pack("<4sII", b"glTF", 2, length) + struct.pack("<II", len(raw), 0x4E4F534A) + raw + struct.pack("<II", len(binary), 0x004E4942) + binary


@pytest.fixture
def factory(tmp_path, monkeypatch):
    monkeypatch.setenv("ASSET_ADMIN_USERNAME", "asset-admin")
    monkeypatch.setenv("ASSET_ADMIN_PASSWORD_HASH", PASSWORD_HASH)
    clock = [1_800_000_000.0]

    @contextmanager
    def start(*, scheme="http"):
        app = create_app(database=str(tmp_path / "game.db"), assets_root=tmp_path / "library",
                         engine=object(), process_pool=False, background=False, now=lambda: clock[0])
        with TestClient(app, base_url=f"{scheme}://testserver") as client:
            client.clock = clock
            yield client
    return start


@pytest.fixture
def client(factory):
    with factory() as client:
        yield client


def login(client):
    response = client.post("/api/assets/admin/login", json={"username": "asset-admin", "password": PASSWORD})
    assert response.status_code == 200, response.text
    return {assets.CSRF_HEADER: response.json()["csrfToken"]}


def upload(client, headers, *, role="table", name="Стол", content=None):
    response = client.post("/api/assets/models", params={"name": name, "role": role},
                           content=glb() if content is None else content,
                           headers={**headers, "Content-Type": "model/gltf-binary"})
    assert response.status_code == 200, response.text
    return response.json()["asset"]


def test_public_empty_library_and_fail_closed_auth(client, monkeypatch):
    snapshot = client.get("/api/assets/library").json()
    assert snapshot["assets"] == []
    assert snapshot["profile"] == {"tableId": None, "environmentId": None}
    assert client.get("/api/assets/admin/session").json() == {"authenticated": False, "configured": True}
    assert client.get("/api/assets/library?includeDisabled=true").status_code == 401
    response = client.post("/api/assets/models", content=glb(), headers={"Authorization": "Bearer guest", "Content-Type": "model/gltf-binary"})
    assert response.status_code == 401
    library = client.app.state.asset_library
    library.password_hash = ""
    assert client.get("/api/assets/admin/session").json()["configured"] is False
    assert client.post("/api/assets/admin/login", json={"username": "asset-admin", "password": PASSWORD}).status_code == 503


def test_http_cookie_session_csrf_and_logout(client):
    response = client.post("/api/assets/admin/login", json={"username": "asset-admin", "password": PASSWORD})
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    assert "Secure" not in response.headers["set-cookie"]
    csrf = response.json()["csrfToken"]
    assert re.fullmatch(r"[0-9a-f]{64}", csrf)
    session = client.get("/api/assets/admin/session").json()
    assert session["authenticated"] and session["csrfToken"] == csrf
    assert isinstance(session["expiresAt"], str) and session["expiresAt"].endswith("Z")
    assert client.put("/api/assets/library/profile", json={"tableId": None, "environmentId": None}).status_code == 403
    assert client.put("/api/assets/library/profile", json={"tableId": None, "environmentId": None}, headers={assets.CSRF_HEADER: "wrong"}).status_code == 403
    headers = {assets.CSRF_HEADER: csrf}
    assert client.put("/api/assets/library/profile", json={"tableId": None, "environmentId": None}, headers={**headers, "Origin": "http://evil.invalid"}).status_code == 403
    assert client.post("/api/assets/admin/logout").status_code == 403
    assert client.post("/api/assets/admin/logout", headers=headers).json() == {"authenticated": False}
    assert client.get("/api/assets/admin/session").json()["authenticated"] is False


def test_https_cookie_and_no_forwarded_auth(factory):
    with factory(scheme="https") as client:
        response = client.post("/api/assets/admin/login", json={"username": "asset-admin", "password": PASSWORD})
        assert "Secure" in response.headers["set-cookie"]
        assert client.get("/api/assets/admin/session").json()["authenticated"] is True
    with factory() as client:
        assert client.get("/api/assets/library?includeDisabled=true", headers={"X-Forwarded-User": "asset-admin", "X-Asset-Admin-Token": PASSWORD}).status_code == 401


def test_bounded_login_input_and_rate_limit(client):
    for _ in range(5):
        response = client.post("/api/assets/admin/login", json={"username": "asset-admin", "password": "incorrect"})
        assert response.status_code == 401
        assert "incorrect" not in response.text
    assert client.post("/api/assets/admin/login", json={"username": "asset-admin", "password": PASSWORD}).status_code == 429
    client.clock[0] += 61
    login(client)
    response = client.post("/api/assets/admin/login", json={"username": "asset-admin", "password": "secret-" * 100})
    assert response.status_code == 422 and "secret-" not in response.text
    assert client.post("/api/assets/admin/login", content=b" " * 5000, headers={"Content-Type": "application/json"}).status_code == 413


def test_valid_upload_binary_read_opaque_paths_and_hash(client):
    headers = login(client)
    # A real GLB larger than the global 64 KiB JSON limit must stream normally.
    content = glb(binary_size=70_000)
    asset = upload(client, headers, content=content, name="../../not-a-server-path.glb")
    assert re.fullmatch(r"[0-9a-f]{32}", asset["id"])
    assert asset["sha256"] == hashlib.sha256(content).hexdigest()
    assert asset["bytes"] == len(content)
    assert asset["url"] == f"/models/library/{asset['id']}.glb"
    response = client.get(asset["url"])
    assert response.status_code == 200 and response.content == content
    assert response.headers["content-type"] == "model/gltf-binary"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["etag"] == f'"{asset["sha256"]}"'
    assert client.head(asset["url"]).status_code == 200
    assert client.get("/models/library/not-an-id.glb").status_code == 404
    assert [path.name for path in client.app.state.asset_library.root.iterdir()] == [asset["id"] + ".glb"]
    snapshot = client.get("/api/assets/library").json()
    assert snapshot["version"] == 1 and snapshot["assets"] == [asset]


@pytest.mark.parametrize("fault", ["external", "buffer", "cycle", "nan", "infinity", "vertices", "decoder", "magic"])
def test_rejects_invalid_glb_without_leaving_files(client, fault):
    headers = login(client)
    document = triangle_document()
    if fault == "external":
        document["images"] = [{"uri": "https://evil.invalid/texture.png"}]
    elif fault == "buffer":
        document["bufferViews"][0]["byteLength"] = 1000
    elif fault == "cycle":
        document["nodes"][0]["children"] = [0]
    elif fault in ("nan", "infinity"):
        document["nodes"][0]["translation"] = [float("nan") if fault == "nan" else float("inf"), 0, 0]
    elif fault == "vertices":
        document["accessors"][0]["count"] = 1_000_001
    elif fault == "decoder":
        document["extensionsRequired"] = ["KHR_draco_mesh_compression"]
    content = glb(document)
    if fault == "magic":
        content = b"NOPE" + content[4:]
    response = client.post("/api/assets/models", content=content, headers={**headers, "Content-Type": "model/gltf-binary"})
    assert response.status_code == 422, response.text
    assert client.get("/api/assets/library").json()["assets"] == []
    assert list(client.app.state.asset_library.root.iterdir()) == []


def test_rejects_mime_per_file_stream_and_total_quota(client, monkeypatch):
    headers = login(client)
    assert client.post("/api/assets/models", content=glb(), headers={**headers, "Content-Type": "image/png"}).status_code == 415
    monkeypatch.setattr(assets, "MAX_MODEL_BYTES", 100)
    assert client.post("/api/assets/models", content=glb(), headers={**headers, "Content-Type": "model/gltf-binary"}).status_code == 413
    def chunks():
        yield b"x" * 60
        yield b"x" * 60
    assert client.post("/api/assets/models", content=chunks(), headers={**headers, "Content-Type": "model/gltf-binary"}).status_code == 413
    assert list(client.app.state.asset_library.root.iterdir()) == []
    monkeypatch.setattr(assets, "MAX_MODEL_BYTES", 50 * 1024 * 1024)
    monkeypatch.setattr(assets, "MAX_LIBRARY_BYTES", 10)
    assert client.post("/api/assets/models", content=glb(), headers={**headers, "Content-Type": "model/gltf-binary"}).status_code == 409
    assert list(client.app.state.asset_library.root.iterdir()) == []


def test_config_edit_and_atomic_publish_soft_disable_restore(client):
    headers = login(client)
    table, room = upload(client, headers), upload(client, headers, role="environment", name="Комната")
    response = client.patch(f"/api/assets/models/{table['id']}", json={"config": {"position": [1, 2, 3], "rotation": [0, 90, 0]}}, headers=headers)
    assert response.status_code == 200
    version = response.json()["version"]
    response = client.patch(f"/api/assets/models/{table['id']}", json={"config": {"material": {"color": "#abcdef", "roughness": 0.4}}, "expectedVersion": version}, headers=headers)
    assert response.status_code == 200
    config = response.json()["asset"]["config"]
    assert config["position"] == [1, 2, 3] and config["rotation"] == [0, 90, 0]
    assert config["material"]["color"] == "#abcdef"
    version = response.json()["version"]
    stale = client.patch(f"/api/assets/models/{table['id']}", json={"name": "Stale", "expectedVersion": 0}, headers=headers)
    assert stale.status_code == 409
    body = {"tableId": table["id"], "environmentId": room["id"], "expectedVersion": version,
            "configs": {table["id"]: config, room["id"]: {"position": [0, -1, 0], "replaceProcedural": False}}}
    response = client.put("/api/assets/library/profile", json=body, headers=headers)
    assert response.status_code == 200, response.text
    snapshot = response.json()
    assert snapshot["profile"] == {"tableId": table["id"], "environmentId": room["id"]}
    failed = {**body, "expectedVersion": snapshot["version"], "environmentId": table["id"]}
    assert client.put("/api/assets/library/profile", json=failed, headers=headers).status_code == 422
    assert client.get("/api/assets/library").json() == snapshot
    assert client.delete(f"/api/assets/models/{table['id']}", headers=headers).status_code == 200
    assert client.get(table["url"]).status_code == 404
    current = client.get("/api/assets/library").json()
    assert current["profile"]["tableId"] is None and len(current["assets"]) == 1
    disabled = client.get("/api/assets/library?includeDisabled=true").json()
    assert len(disabled["assets"]) == 2
    assert (client.app.state.asset_library.root / (table["id"] + ".glb")).is_file()
    restored = client.patch(f"/api/assets/models/{table['id']}", json={"enabled": True}, headers=headers)
    assert restored.status_code == 200 and restored.json()["asset"]["enabled"]
    assert client.get(table["url"]).status_code == 200


def test_profile_names_configs_and_both_selections_publish_atomically(client):
    headers = login(client)
    table = upload(client, headers, name="Original table")
    room = upload(client, headers, role="environment", name="Original room")
    before = client.get("/api/assets/library").json()
    body = {
        "tableId": table["id"], "environmentId": room["id"],
        "expectedVersion": before["version"],
        "names": {table["id"]: "  Prepared table  ", room["id"]: "Prepared room"},
        "configs": {table["id"]: {"position": [0.12, 0, 0]},
                    room["id"]: {"rotation": [0, 90, 0], "replaceProcedural": False}},
    }
    response = client.put("/api/assets/library/profile", json=body, headers=headers)
    assert response.status_code == 200, response.text
    published = response.json()
    assert published["version"] == before["version"] + 1
    assert published["profile"] == {"tableId": table["id"], "environmentId": room["id"]}
    by_id = {asset["id"]: asset for asset in published["assets"]}
    assert by_id[table["id"]]["name"] == "Prepared table"
    assert by_id[table["id"]]["config"]["position"] == [0.12, 0, 0]
    assert by_id[room["id"]]["name"] == "Prepared room"
    assert by_id[room["id"]]["config"]["rotation"] == [0, 90, 0]
    assert by_id[room["id"]]["config"]["replaceProcedural"] is False
    assert client.get("/api/assets/library").json() == published

    # A stale rename cannot partly change either asset before the conflict.
    body["names"][table["id"]] = "Stale table"
    assert client.put("/api/assets/library/profile", json=body, headers=headers).status_code == 409
    assert client.get("/api/assets/library").json() == published


@pytest.mark.parametrize("invalid_name", ["", "   ", "x" * 161, "bad\nname", "bad\x7fname"])
def test_invalid_profile_name_changes_nothing(client, invalid_name):
    headers = login(client)
    table = upload(client, headers)
    before = client.get("/api/assets/library").json()
    response = client.put("/api/assets/library/profile", headers=headers, json={
        "tableId": table["id"], "environmentId": None, "expectedVersion": before["version"],
        "configs": {table["id"]: {"position": [1, 0, 0]}},
        "names": {table["id"]: invalid_name},
    })
    assert response.status_code == 422
    assert client.get("/api/assets/library").json() == before


def test_profile_names_must_belong_to_selected_role_correct_assets(client):
    headers = login(client)
    table, room = upload(client, headers), upload(client, headers, role="environment")
    before = client.get("/api/assets/library").json()
    for selection, names in (
        ({"tableId": table["id"], "environmentId": None}, {room["id"]: "Not selected"}),
        ({"tableId": table["id"], "environmentId": None}, {"f" * 32: "Missing"}),
        ({"tableId": table["id"], "environmentId": table["id"]}, {table["id"]: "Wrong role"}),
    ):
        response = client.put("/api/assets/library/profile", headers=headers, json={
            **selection, "expectedVersion": before["version"], "names": names,
            "configs": {table["id"]: {"position": [1, 0, 0]}},
        })
        assert response.status_code == 422
        assert client.get("/api/assets/library").json() == before


def test_upload_and_delete_reject_stale_expected_version_without_changes(client):
    headers = login(client)
    table = upload(client, headers)
    before = client.get("/api/assets/library").json()
    paths = set(client.app.state.asset_library.root.iterdir())
    response = client.post("/api/assets/models", params={"expectedVersion": 0}, content=glb(),
                           headers={**headers, "Content-Type": "model/gltf-binary"})
    assert response.status_code == 409
    assert client.delete(f"/api/assets/models/{table['id']}", params={"expectedVersion": 0}, headers=headers).status_code == 409
    assert client.get("/api/assets/library").json() == before
    assert set(client.app.state.asset_library.root.iterdir()) == paths
    for endpoint, method in (("/api/assets/models", "post"), (f"/api/assets/models/{table['id']}", "delete")):
        arguments = {"params": {"expectedVersion": -1}, "headers": headers}
        if method == "post":
            arguments.update(content=glb(), headers={**headers, "Content-Type": "model/gltf-binary"})
        assert getattr(client, method)(endpoint, **arguments).status_code == 422
    assert client.get("/api/assets/library").json() == before


@pytest.mark.parametrize("phase", ["validation", "move"])
def test_concurrent_edit_during_upload_rejects_and_removes_all_upload_files(client, monkeypatch, phase):
    headers = login(client)
    table = upload(client, headers)
    before = client.get("/api/assets/library").json()
    root = client.app.state.asset_library.root
    paths = set(root.iterdir())
    reached, resume = threading.Event(), threading.Event()
    original = assets.validate_glb_file if phase == "validation" else assets.os.replace

    def pause_after_operation(*args):
        result = original(*args)
        reached.set()
        assert resume.wait(5), "Concurrent edit did not release the upload"
        return result

    if phase == "validation":
        monkeypatch.setattr(assets, "validate_glb_file", pause_after_operation)
    else:
        monkeypatch.setattr(assets.os, "replace", pause_after_operation)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(client.post, "/api/assets/models",
                                  params={"name": "Concurrent environment", "role": "environment", "expectedVersion": before["version"]},
                                  content=glb(), headers={**headers, "Content-Type": "model/gltf-binary"})
        try:
            assert reached.wait(5), "Upload did not reach its asynchronous operation"
            changed = client.patch(f"/api/assets/models/{table['id']}", headers=headers,
                                   json={"name": "Newer administrator edit", "expectedVersion": before["version"]})
            assert changed.status_code == 200, changed.text
            after_edit = client.get("/api/assets/library").json()
        finally:
            resume.set()
        response = pending.result(timeout=5)
    assert response.status_code == 409, response.text
    assert client.get("/api/assets/library").json() == after_edit
    assert set(root.iterdir()) == paths, "Conflicting uploads must not leave .part or final GLB files"


def test_sequential_guarded_uploads_publish_names_and_guarded_delete(client):
    headers = login(client)
    version = client.get("/api/assets/library").json()["version"]
    created = []
    for role in ("table", "environment"):
        response = client.post("/api/assets/models", params={"role": role, "expectedVersion": version},
                               content=glb(), headers={**headers, "Content-Type": "model/gltf-binary"})
        assert response.status_code == 200, response.text
        assert response.json()["version"] == version + 1
        version, asset = response.json()["version"], response.json()["asset"]
        created.append(asset)
    table, room = created
    response = client.put("/api/assets/library/profile", headers=headers, json={
        "tableId": table["id"], "environmentId": room["id"], "expectedVersion": version,
        "names": {table["id"]: "Published table", room["id"]: "Published room"},
    })
    assert response.status_code == 200, response.text
    version = response.json()["version"]
    removed = client.delete(f"/api/assets/models/{table['id']}", params={"expectedVersion": version}, headers=headers)
    assert removed.status_code == 200
    assert removed.json()["version"] == version + 1
    assert removed.json()["asset"]["enabled"] is False
    assert client.get("/api/assets/library").json()["profile"] == {"tableId": None, "environmentId": room["id"]}


@pytest.mark.parametrize("config", [
    {"position": [101, 0, 0]}, {"rotation": [0, 4000, 0]}, {"scale": [1, 0, 1]},
    {"material": {"metalness": 1.1}}, {"material": {"color": "red"}},
    {"material": {"emissiveIntensity": 11}}, {"replaceProcedural": "false"},
    {"unknown": True}, {"materials": {"__proto__": {"color": "#ffffff"}}},
])
def test_config_validation_rejects_invalid_values(client, config):
    headers = login(client)
    asset = upload(client, headers)
    before = client.get("/api/assets/library").json()
    response = client.patch(f"/api/assets/models/{asset['id']}", json={"config": config}, headers=headers)
    assert response.status_code == 422
    assert client.get("/api/assets/library").json() == before


def test_library_and_hashed_admin_session_survive_restart(factory, monkeypatch):
    with factory() as client:
        headers = login(client)
        token = client.cookies.get(assets.ADMIN_COOKIE)
        asset = upload(client, headers)
        body = {"tableId": asset["id"], "environmentId": None}
        assert client.put("/api/assets/library/profile", json=body, headers=headers).status_code == 200
        expected = client.get("/api/assets/library").json()
        rows = client.app.state.asset_library.store.db.execute("SELECT * FROM asset_admin_sessions").fetchall()
        assert len(rows) == 1 and rows[0]["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
        assert token not in repr(tuple(rows[0])) and PASSWORD not in repr(tuple(rows[0]))
    with factory() as client:
        client.cookies.set(assets.ADMIN_COOKIE, token, path=assets.ADMIN_COOKIE_PATH)
        assert client.get("/api/assets/library").json() == expected
        assert client.get(asset["url"]).content == glb()
        session = client.get("/api/assets/admin/session").json()
        assert session["authenticated"] and session["csrfToken"] == headers[assets.CSRF_HEADER]
        client.clock[0] += assets.ADMIN_SESSION_SECONDS + 1
        assert not client.get("/api/assets/admin/session").json()["authenticated"]
    monkeypatch.setenv("ASSET_ADMIN_PASSWORD_HASH", assets.hash_admin_password("another-unique-password"))
    with factory() as client:
        client.cookies.set(assets.ADMIN_COOKIE, token, path=assets.ADMIN_COOKIE_PATH)
        assert not client.get("/api/assets/admin/session").json()["authenticated"]
