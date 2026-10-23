// ------------------------------
// archive.js - full message archive of every business chat (kept forever).
// The last N messages are the AI context; the archive is also used to forward
// deleted/edited messages to the owner, to build topics and the AI's own memory.
// ------------------------------

const db = require('./sqlite');

db.exec(`
    CREATE TABLE IF NOT EXISTS archive (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key    TEXT NOT NULL,
        message_id  INTEGER,                    -- Telegram message id (NULL for seeded rows)
        role        TEXT NOT NULL CHECK (role IN ('them', 'owner', 'ai')),
        text        TEXT,                       -- text or caption
        media_type  TEXT,                       -- photo / voice / sticker ... or NULL
        file_id     TEXT,                       -- to re-send media after deletion
        summary     TEXT NOT NULL,              -- one-line text for the AI ("[photo] caption")
        sent_at     INTEGER NOT NULL,           -- unix seconds
        edited_at   INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (chat_key, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_chat ON archive (chat_key, id);
    CREATE INDEX IF NOT EXISTS idx_archive_sent ON archive (sent_at);

    -- Small key/value store for one-time migrations
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Column added later: messages received while the AI was switched off for the chat.
// They stay in the archive (deleted/edited tracking) but the AI never sees them.
const archiveColumns = new Set(db.prepare('PRAGMA table_info(archive)').all().map(col => col.name));
if (!archiveColumns.has('ai_hidden')) db.exec('ALTER TABLE archive ADD COLUMN ai_hidden INTEGER NOT NULL DEFAULT 0');

const insertStmt = db.prepare(`
    INSERT INTO archive (chat_key, message_id, role, text, media_type, file_id, summary, sent_at, ai_hidden)
    VALUES (@chat_key, @message_id, @role, @text, @media_type, @file_id, @summary, @sent_at, @ai_hidden)
    ON CONFLICT (chat_key, message_id) DO NOTHING
`);
const getStmt = db.prepare('SELECT * FROM archive WHERE chat_key = ? AND message_id = ?');
const editStmt = db.prepare('UPDATE archive SET text = ?, summary = ?, media_type = ?, file_id = ?, edited_at = ? WHERE id = ?');
const deleteStmt = db.prepare('UPDATE archive SET deleted = 1 WHERE id = ?');
const afterStmt = db.prepare('SELECT * FROM archive WHERE chat_key = ? AND id > ? AND ai_hidden = 0 ORDER BY id ASC LIMIT ?');
const pendingStmt = db.prepare(`
    SELECT chat_key, COUNT(*) AS n, MAX(sent_at) AS last_at, MAX(id) AS max_id
    FROM archive WHERE chat_key = ? AND id > ? AND ai_hidden = 0
`);
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM archive WHERE chat_key = ?');
const contextStmt = db.prepare(`
    SELECT role, summary, sent_at FROM (
        SELECT id, role, summary, sent_at FROM archive WHERE chat_key = ? AND deleted = 0 AND ai_hidden = 0 ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
`);
const clearChatStmt = db.prepare('DELETE FROM archive WHERE chat_key = ?');
const clearNsStmt = db.prepare('DELETE FROM archive WHERE chat_key LIKE ?');

// Extracts media type + file_id of the main attachment
function mediaOf(message) {
    if (message.photo) return { media_type: 'photo', file_id: message.photo[message.photo.length - 1].file_id };
    for (const type of ['video', 'voice', 'video_note', 'audio', 'animation', 'document', 'sticker']) {
        if (message[type]) return { media_type: type, file_id: message[type].file_id };
    }
    for (const type of ['location', 'contact', 'poll']) {
        if (message[type]) return { media_type: type, file_id: null };
    }
    return { media_type: null, file_id: null };
}

/**
 * Stores a Telegram message.
 * @param {string} chatKey
 * @param {'them'|'owner'|'ai'} role
 * @param {object} message  Bot API Message (or { message_id, text, date } for AI replies)
 * @param {string} summary  one-line representation for the AI
 * @param {{ hidden?: boolean }} [options] hidden = never shown to the AI (AI was off for the chat)
 */
function archiveMessage(chatKey, role, message, summary, { hidden = false } = {}) {
    const { media_type, file_id } = mediaOf(message);
    insertStmt.run({
        chat_key: chatKey,
        message_id: message.message_id ?? null,
        role,
        text: message.text ?? message.caption ?? null,
        media_type,
        file_id,
        summary,
        sent_at: message.date || Math.floor(Date.now() / 1000),
        ai_hidden: hidden ? 1 : 0
    });
}

const getArchived = (chatKey, messageId) => getStmt.get(chatKey, messageId);

// Applies an edit and returns the row as it was BEFORE the edit (or undefined)
function applyEdit(chatKey, message, summary) {
    const before = getStmt.get(chatKey, message.message_id);
    if (!before) return undefined;
    const { media_type, file_id } = mediaOf(message);
    editStmt.run(
        message.text ?? message.caption ?? null,
        summary,
        media_type || before.media_type,
        file_id || before.file_id,
        message.edit_date || Math.floor(Date.now() / 1000),
        before.id
    );
    return before;
}

function markDeleted(id) {
    deleteStmt.run(id);
}

// Messages of a chat after a given archive id (for incremental processing)
const messagesAfter = (chatKey, afterId, limit) => afterStmt.all(chatKey, afterId, limit);
const pendingInfo = (chatKey, afterId) => pendingStmt.get(chatKey, afterId);
const countArchived = chatKey => countStmt.get(chatKey).n;

// Last `limit` messages of a chat, oldest first (deleted ones are skipped)
function contextRows(chatKey, limit) {
    return contextStmt.all(chatKey, limit);
}

const clearChatArchive = chatKey => clearChatStmt.run(chatKey);
// Deletes the archive of every chat of a namespace (business account)
const clearAllArchive = ns => clearNsStmt.run('b:' + Number(ns) + ':%');

// One-time: copy the existing AI history into the archive after an upgrade,
// so the context and the first analysis are not empty.
function seedFromHistory() {
    const done = db.prepare("SELECT value FROM meta WHERE key = 'archive_seeded'").get();
    if (done) return 0;
    const rows = db.prepare('SELECT chat_id, role, content, created_at FROM messages ORDER BY id ASC').all();
    const seed = db.transaction(() => {
        for (const row of rows) {
            if (row.chat_id.startsWith('owner:')) continue; // owner's test chat
            insertStmt.run({
                chat_key: row.chat_id,
                message_id: null,
                role: row.role === 'user' ? 'them' : 'ai',
                text: row.content,
                media_type: null,
                file_id: null,
                summary: row.content,
                sent_at: Math.floor(Date.parse(`${row.created_at}Z`) / 1000) || Math.floor(Date.now() / 1000),
                ai_hidden: 0
            });
        }
        db.prepare("INSERT INTO meta (key, value) VALUES ('archive_seeded', '1')").run();
    });
    seed();
    return rows.length;
}

module.exports = {
    archiveMessage,
    getArchived,
    applyEdit,
    markDeleted,
    messagesAfter,
    pendingInfo,
    countArchived,
    contextRows,
    clearChatArchive,
    clearAllArchive,
    seedFromHistory
};
