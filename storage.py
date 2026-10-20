import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

DATA_DIR = Path(__file__).resolve().parent / "data"
DATABASE = DATA_DIR / "local-first-ai.sqlite3"


@contextmanager
def connection():
    db = sqlite3.connect(DATABASE, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")

    try:
        with db:
            yield db
    finally:
        db.close()


def initialize():
    DATA_DIR.mkdir(exist_ok=True)

    with connection() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT (
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                )
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                conversation_id TEXT NOT NULL
                    REFERENCES conversations(id),
                role TEXT NOT NULL
                    CHECK (role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                )
            );

            CREATE INDEX IF NOT EXISTS messages_conversation
                ON messages(conversation_id, id);
        """)


def create_conversation():
    conversation_id = str(uuid4())

    with connection() as db:
        db.execute(
            "INSERT INTO conversations (id) VALUES (?)",
            (conversation_id,),
        )

    return conversation_id


def conversation_exists(conversation_id):
    with connection() as db:
        row = db.execute(
            "SELECT id FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()

    return row is not None


def get_messages(conversation_id):
    with connection() as db:
        rows = db.execute(
            """
            SELECT id, role, content, created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id
            """,
            (conversation_id,),
        ).fetchall()

    return [dict(row) for row in rows]


def save_exchange(conversation_id, user_message, assistant_reply):
    with connection() as db:
        db.executemany(
            """
            INSERT INTO messages (conversation_id, role, content)
            VALUES (?, ?, ?)
            """,
            [
                (conversation_id, "user", user_message),
                (conversation_id, "assistant", assistant_reply),
            ],
        )