"""Small durable SQLite repository. All match mutations use one transaction."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def decode(value):
    return json.loads(value)


class Store:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).resolve().parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS users(
            id TEXT PRIMARY KEY, vk_id TEXT UNIQUE, display_name TEXT NOT NULL,
            elo INTEGER NOT NULL DEFAULT 1000, games INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
            settings TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions(
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
            created_at REAL NOT NULL, expires_at REAL NOT NULL,
            client_version TEXT NOT NULL DEFAULT 'unknown'
        );
        CREATE TABLE IF NOT EXISTS rooms(
            id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL,
            payload TEXT NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS matches(
            id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
            payload TEXT NOT NULL, physics TEXT NOT NULL,
            pending TEXT, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS commands(
            match_id TEXT NOT NULL REFERENCES matches(id), command_id TEXT NOT NULL,
            actor_id TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
            response TEXT, created_at REAL NOT NULL,
            PRIMARY KEY(match_id, command_id)
        );
        CREATE TABLE IF NOT EXISTS matchmaking(
            user_id TEXT PRIMARY KEY REFERENCES users(id), mode TEXT NOT NULL,
            entered_at REAL NOT NULL, elo INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telemetry(
            event_id TEXT PRIMARY KEY, type TEXT NOT NULL, player_id TEXT,
            session_id TEXT, match_id TEXT, turn_id INTEGER,
            client_version TEXT, timestamp TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS telemetry_match ON telemetry(match_id,timestamp);
        CREATE INDEX IF NOT EXISTS matches_room ON matches(room_id);
        CREATE INDEX IF NOT EXISTS matches_status ON matches(json_extract(payload,'$.status'));
        CREATE INDEX IF NOT EXISTS rooms_status ON rooms(json_extract(payload,'$.status'));
        CREATE TABLE IF NOT EXISTS match_players(
            match_id TEXT NOT NULL REFERENCES matches(id), user_id TEXT NOT NULL,
            PRIMARY KEY(user_id, match_id)
        );
        INSERT OR IGNORE INTO match_players(match_id, user_id)
            SELECT matches.id, json_extract(player.value, '$.id')
            FROM matches, json_each(matches.payload, '$.players') AS player;
        """)
        self.db.commit()

    @contextmanager
    def transaction(self):
        try:
            self.db.execute("BEGIN IMMEDIATE")
            yield self.db
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def close(self):
        self.db.close()
