"""The default URL must not keep pointing at an old frontend bundle."""

import pytest
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from online.server.app import create_app


@pytest.fixture
def client(tmp_path):
    static = tmp_path / "client"
    static.mkdir()
    (static / "index.html").write_text('<!doctype html><script src="/assets/current.js"></script>', encoding="utf-8")
    (static / "assets").mkdir()
    (static / "assets" / "current.js").write_text("console.log('current')", encoding="utf-8")
    # No match is created by these transport tests; do not initialize physics.
    application = create_app(database=str(tmp_path / "game.db"), engine=object(), process_pool=False, background=False)
    application.router.routes = [route for route in application.router.routes if route.name != "client"]
    application.mount("/", StaticFiles(directory=static, html=True), name="client")
    with TestClient(application) as client:
        yield client


@pytest.mark.parametrize("path", ["/", "/index.html", "/?v=0.2.0"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_default_document_is_not_stored(client, path, method):
    response = client.request(method, path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("path", ["/", "/index.html", "/?v=0.2.0"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("validator", ["etag", "last-modified"])
def test_not_modified_document_keeps_no_store(client, path, method, validator):
    first = client.get(path)
    conditional_header = "If-None-Match" if validator == "etag" else "If-Modified-Since"
    response = client.request(method, path, headers={conditional_header: first.headers[validator]})
    assert response.status_code == 304
    assert response.headers["cache-control"] == "no-store"


def test_assets_keep_their_own_cache_policy(client):
    response = client.get("/assets/current.js")
    assert response.status_code == 200
    assert "cache-control" not in response.headers


def test_api_still_is_not_stored(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
