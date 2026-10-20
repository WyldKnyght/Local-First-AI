from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import storage

router = APIRouter()


class MemoryWrite(BaseModel):
    value: str = Field(min_length=1, max_length=1000)


def initialize():
    with storage.connection() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS memory_revisions (
                id INTEGER PRIMARY KEY,
                memory_key TEXT NOT NULL,
                value TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT 'explicit_user_request',
                confirmation_status TEXT NOT NULL DEFAULT 'user_confirmed',
                created_at TEXT NOT NULL DEFAULT (
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                )
            );

            CREATE INDEX IF NOT EXISTS memory_key_revisions
                ON memory_revisions(memory_key, id);
        """)


def get_record(key):
    with storage.connection() as db:
        row = db.execute(
            """
            SELECT id, memory_key, value, origin,
                   confirmation_status, created_at
            FROM memory_revisions
            WHERE memory_key = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (key,),
        ).fetchone()

    return dict(row) if row is not None else None


def validate_key(key):
    allowed = "abcdefghijklmnopqrstuvwxyz0123456789_-"

    if (
        not key
        or len(key) > 64
        or any(character not in allowed for character in key)
    ):
        raise HTTPException(
            status_code=422,
            detail="Memory key must use 1–64 lowercase letters, digits, _ or -.",
        )


@router.put("/memory/{key}")
async def save_memory(key: str, request: MemoryWrite):
    validate_key(key)
    value = request.value.strip()

    if not value:
        raise HTTPException(
            status_code=422,
            detail="Memory value cannot be blank.",
        )

    with storage.connection() as db:
        cursor = db.execute(
            """
            INSERT INTO memory_revisions (memory_key, value)
            VALUES (?, ?)
            """,
            (key, value),
        )

        revision_id = cursor.lastrowid

    return {
        "saved": True,
        "memory_key": key,
        "value": value,
        "revision_id": revision_id,
        "origin": "explicit_user_request",
        "confirmation_status": "user_confirmed",
    }


@router.get("/memory/{key}")
async def read_memory(key: str):
    validate_key(key)
    record = get_record(key)

    if record is None:
        raise HTTPException(
            status_code=404,
            detail="Memory not found.",
        )

    return record