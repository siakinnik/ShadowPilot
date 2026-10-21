// ------------------------------
// sqlite.js - database bootstrap (better-sqlite3)
// ------------------------------

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../../config/config');

const dbPath = path.resolve(config.dbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
    -- Chat history used as AI context
    CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content     TEXT NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id, id);

    -- Runtime settings changed from the admin panel (key -> JSON value)
    CREATE TABLE IF NOT EXISTS settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Known Telegram Business connections
    CREATE TABLE IF NOT EXISTS business_connections (
        id            TEXT PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        user_chat_id  INTEGER,
        user_name     TEXT,
        can_reply     INTEGER NOT NULL DEFAULT 0,
        can_read      INTEGER NOT NULL DEFAULT 0,
        is_enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

module.exports = db;
