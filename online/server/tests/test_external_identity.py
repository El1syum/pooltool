"""Verified-provider identity persistence; never exercise a live platform here."""

import asyncio
import sqlite3

import pytest

from online.server.auth import token_hash
from online.server.service import GameService
from online.server.storage import Store, encode


def service(path=":memory:"):
    return GameService(Store(str(path)), engine=None, process_pool=False,
                       now=lambda: 1_800_000_000.0)


def login(current, **overrides):
    return current.authenticate_external(**{
        "provider": "vkplay", "app_id": "123", "external_id": "456",
        "display_name": "Игрок VK Play 456", "client_version": "vkplay-test",
        **overrides,
    })


def test_repeat_login_reuses_profile_without_overwriting_progress_or_name(tmp_path):
    current = service(tmp_path / "identity.sqlite3")
    first = asyncio.run(login(current))
    user_id = first["user"]["id"]
    settings = {"volume": .42, "quality": "low"}
    with current.store.transaction() as db:
        db.execute("UPDATE users SET display_name=?,elo=?,games=?,wins=?,losses=?,settings=? WHERE id=?",
                   ("Chosen nickname", 1234, 7, 5, 2, encode(settings), user_id))
    second = asyncio.run(login(current, display_name="New platform nickname"))
    assert second["user"] == {
        "id": user_id, "displayName": "Chosen nickname", "elo": 1234,
        "games": 7, "wins": 5, "losses": 2, "settings": settings, "isVk": False,
    }
    assert second["token"] != first["token"]
    assert current.session(first["token"])["userId"] == user_id
    assert current.session(second["token"])["userId"] == user_id
    assert current.store.db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    rows = current.store.db.execute("SELECT * FROM sessions").fetchall()
    assert len(rows) == 2
    assert {row["token_hash"] for row in rows} == {token_hash(first["token"]), token_hash(second["token"])}
    assert all(row["expires_at"] - row["created_at"] == 30 * 86400 for row in rows)
    assert all(row["client_version"] == "vkplay-test" for row in rows)
    assert first["token"] not in repr([tuple(row) for row in rows])
    current.store.close()


def test_provider_app_and_id_namespaces_never_merge_guest_or_mini_apps():
    current = service()

    async def check():
        identities = [
            await current.authenticate("Same name"),
            await current.authenticate("Same name", vk_id="456"),
            await login(current, display_name="Same name"),
            await login(current, app_id="124", display_name="Same name"),
            await login(current, provider="another_provider", display_name="Same name"),
            await login(current, external_id="457", display_name="Same name"),
        ]
        assert len({identity["user"]["id"] for identity in identities}) == 6
        assert identities[1]["user"]["isVk"] is True
        assert all(identities[index]["user"]["isVk"] is False for index in (0, 2, 3, 4, 5))
        assert (await current.authenticate("Ignored later name", vk_id="456"))["user"]["id"] == identities[1]["user"]["id"]
        assert (await login(current))["user"]["id"] == identities[2]["user"]["id"]
        assert current.store.db.execute("SELECT COUNT(*) FROM external_identities").fetchone()[0] == 4

    asyncio.run(check())
    current.store.close()


def test_identity_and_own_sessions_survive_restart(tmp_path):
    path = tmp_path / "identity.sqlite3"
    first_service = service(path)
    first = asyncio.run(login(first_service))
    identity_before = tuple(first_service.store.db.execute("SELECT * FROM external_identities").fetchone())
    first_service.store.close()
    second_service = service(path)
    assert second_service.session(first["token"])["userId"] == first["user"]["id"]
    second = asyncio.run(login(second_service))
    assert second["user"]["id"] == first["user"]["id"]
    assert tuple(second_service.store.db.execute("SELECT * FROM external_identities").fetchone()) == identity_before
    second_service.store.close()


def test_concurrent_verified_logins_create_one_user_and_distinct_sessions():
    current = service()

    async def check():
        results = await asyncio.gather(*(login(current) for _ in range(20)))
        assert len({result["user"]["id"] for result in results}) == 1
        assert len({result["token"] for result in results}) == 20

    asyncio.run(check())
    assert current.store.db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    assert current.store.db.execute("SELECT COUNT(*) FROM external_identities").fetchone()[0] == 1
    assert current.store.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 20
    current.store.close()


def test_failed_identity_creation_rolls_back_new_user_and_session():
    current = service()
    current.store.db.execute("CREATE TRIGGER reject_identity BEFORE INSERT ON external_identities BEGIN SELECT RAISE(ABORT,'test identity rollback'); END")
    current.store.db.commit()
    with pytest.raises(sqlite3.IntegrityError, match="test identity rollback"):
        asyncio.run(login(current))
    for table in ("users", "external_identities", "sessions"):
        assert current.store.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    current.store.db.execute("DROP TRIGGER reject_identity")
    current.store.db.commit()
    assert asyncio.run(login(current))["user"]["id"]
    current.store.close()


@pytest.mark.parametrize("fields", [
    {"provider": ""}, {"provider": "VKPlay"}, {"provider": "vk play"},
    {"provider": "x" * 33}, {"app_id": ""}, {"app_id": "123 "},
    {"app_id": "x" * 161}, {"app_id": 123}, {"external_id": "456\n"},
    {"external_id": "a\x00b"}, {"external_id": "two words"},
    {"display_name": " "}, {"display_name": "A\nB"},
])
def test_invalid_identity_does_not_write_anything(fields):
    current = service()
    with pytest.raises(ValueError):
        asyncio.run(login(current, **fields))
    assert current.store.db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    assert current.store.db.execute("SELECT COUNT(*) FROM external_identities").fetchone()[0] == 0
    current.store.close()


def test_initial_display_name_is_bounded_but_not_identity():
    current = service()
    result = asyncio.run(login(current, display_name="Игрок " + "1" * 100))
    assert len(result["user"]["displayName"]) == 32
    assert current.store.db.execute("SELECT external_id FROM external_identities").fetchone()[0] == "456"
    current.store.close()


def test_upgrade_is_idempotent_and_preserves_legacy_rows(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    old = service(path)
    guest = asyncio.run(old.authenticate("Legacy guest"))
    mini = asyncio.run(old.authenticate("Legacy VK", vk_id="456"))
    with old.store.transaction() as db:
        db.execute("INSERT INTO rooms VALUES(?,?,?,?)", ("legacy-room", "LEGACY", encode({"status": "finished"}), 1.0))
        db.execute("INSERT INTO matches VALUES(?,?,?,?,?,?)", ("legacy-match", "legacy-room", encode({"status": "finished", "players": [{"id": guest["user"]["id"]}]}), "{}", None, 1.0))
        db.execute("CREATE TABLE preserved_admin_credentials(value TEXT)")
        db.execute("INSERT INTO preserved_admin_credentials VALUES(?)", ("test-only-hash-not-a-password",))
    before = {table: [tuple(row) for row in old.store.db.execute(f"SELECT * FROM {table} ORDER BY rowid")]
              for table in ("users", "sessions", "rooms", "matches", "preserved_admin_credentials")}
    # Simulate a database from before provider identities existed.
    old.store.db.execute("DROP TABLE external_identities")
    old.store.db.commit()
    old.store.close()
    for _ in range(2):
        upgraded = service(path)
        assert upgraded.store.db.execute("PRAGMA foreign_key_check").fetchall() == []
        for table, rows in before.items():
            assert [tuple(row) for row in upgraded.store.db.execute(f"SELECT * FROM {table} ORDER BY rowid")] == rows
        assert upgraded.session(guest["token"])["userId"] == guest["user"]["id"]
        assert upgraded.session(mini["token"])["userId"] == mini["user"]["id"]
        assert upgraded.store.db.execute("SELECT COUNT(*) FROM external_identities").fetchone()[0] == 0
        upgraded.store.close()
