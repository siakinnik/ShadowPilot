// ------------------------------
// chats.js - known business chats (so the owner can find them by @username / id)
// and the owner's custom per-chat context for the AI (notes, inside jokes...)
// ------------------------------

const db = require('./sqlite');

db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key      TEXT NOT NULL UNIQUE,      -- same key as messages.chat_id
        owner_user_id INTEGER NOT NULL,          -- business account the chat belongs to
        chat_id       INTEGER NOT NULL,          -- Telegram id of the other person
        username      TEXT,
        first_name    TEXT,
        last_name     TEXT,
        context       TEXT,                      -- owner's notes injected into the system prompt
        last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chats_username ON chats (username COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_chats_chat_id ON chats (chat_id);
`);

// Columns added later - migrate existing databases in place
const MIGRATIONS = {
    ai_memory: 'TEXT',                        // notes the AI keeps about this chat by itself
    memory_until: 'INTEGER NOT NULL DEFAULT 0', // last archive.id folded into ai_memory
    topics_until: 'INTEGER NOT NULL DEFAULT 0', // last archive.id split into topics
    reanalyze_by: 'INTEGER'                   // owner chat id waiting for a full re-analysis report
};
const existing = new Set(db.prepare('PRAGMA table_info(chats)').all().map(col => col.name));
for (const [column, type] of Object.entries(MIGRATIONS)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE chats ADD COLUMN ${column} ${type}`);
}

const upsertStmt = db.prepare(`
    INSERT INTO chats (chat_key, owner_user_id, chat_id, username, first_name, last_name, last_seen_at)
    VALUES (@chat_key, @owner_user_id, @chat_id, @username, @first_name, @last_name, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_key) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        last_seen_at = CURRENT_TIMESTAMP
`);
const byIdStmt = db.prepare('SELECT * FROM chats WHERE id = ?');
const byKeyStmt = db.prepare('SELECT * FROM chats WHERE chat_key = ?');
const byUsernameStmt = db.prepare('SELECT * FROM chats WHERE owner_user_id = ? AND username = ? COLLATE NOCASE ORDER BY last_seen_at DESC');
const byChatIdStmt = db.prepare('SELECT * FROM chats WHERE owner_user_id = ? AND chat_id = ? ORDER BY last_seen_at DESC');
const recentStmt = db.prepare('SELECT * FROM chats WHERE owner_user_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT ?');
const contextStmt = db.prepare('UPDATE chats SET context = ? WHERE id = ?');

// Saves/refreshes a chat from a business message (`chat` is the other person in a private chat)
function touchChat(chatKey, ownerUserId, chat) {
    upsertStmt.run({
        chat_key: chatKey,
        owner_user_id: ownerUserId,
        chat_id: chat.id,
        username: chat.username || null,
        first_name: chat.first_name || null,
        last_name: chat.last_name || null
    });
}

// Finds chats by "@username", "username", "t.me/username" or numeric Telegram id
// Only chats of the given namespace (business account) are searched
function findChats(query, ns) {
    const value = String(query).trim().replace(/^(https?:\/\/)?(t\.me\/|telegram\.me\/)/i, '').replace(/^@/, '');
    if (/^-?\d+$/.test(value)) return byChatIdStmt.all(Number(ns), Number(value));
    if (/^[a-z0-9_]{3,32}$/i.test(value)) return byUsernameStmt.all(Number(ns), value);
    return [];
}

const getChat = id => byIdStmt.get(id);
const getChatByKey = key => byKeyStmt.get(key);
const recentChats = (ns, limit = 8) => recentStmt.all(Number(ns), limit);

function setContext(id, context) {
    contextStmt.run(context && context.trim() ? context.trim() : null, id);
}

// "Name (@username)" for UI
function chatTitle(chat) {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.chat_id);
    return chat.username ? `${name} (@${chat.username})` : name;
}

// ---------- AI memory & processing pointers ----------

const allChatsStmt = db.prepare('SELECT * FROM chats ORDER BY last_seen_at DESC');
const countNsStmt = db.prepare('SELECT COUNT(*) AS n FROM chats WHERE owner_user_id = ?');
const deleteNsStmt = db.prepare('DELETE FROM chats WHERE owner_user_id = ?');
const aiMemoryStmt = db.prepare('UPDATE chats SET ai_memory = ? WHERE id = ?');
const memoryUntilStmt = db.prepare('UPDATE chats SET memory_until = ? WHERE id = ?');
const topicsUntilStmt = db.prepare('UPDATE chats SET topics_until = ? WHERE id = ?');
const reanalyzeStmt = db.prepare(`
    UPDATE chats SET ai_memory = NULL, memory_until = 0, topics_until = 0, reanalyze_by = ? WHERE id = ?
`);
const reanalyzeDoneStmt = db.prepare('UPDATE chats SET reanalyze_by = NULL WHERE id = ?');
const resetAllStmt = db.prepare('UPDATE chats SET ai_memory = NULL, reanalyze_by = NULL WHERE owner_user_id = ?');

const allChats = () => allChatsStmt.all();
const countChats = ns => countNsStmt.get(Number(ns)).n;
// Forgets all chats of a namespace (used when an account is removed)
const deleteChats = ns => deleteNsStmt.run(Number(ns));

function setAiMemory(id, text) {
    aiMemoryStmt.run(text && text.trim() ? text.trim() : null, id);
}

const setMemoryUntil = (id, archiveId) => memoryUntilStmt.run(archiveId, id);
const setTopicsUntil = (id, archiveId) => topicsUntilStmt.run(archiveId, id);

// Forgets everything the AI derived from this chat; the worker rebuilds it from the archive
const requestReanalysis = (id, ownerChatId) => reanalyzeStmt.run(ownerChatId, id);
const finishReanalysis = id => reanalyzeDoneStmt.run(id);

// Pointers stay as they are: archive ids only grow, so cleared chats start fresh
const clearAllAiMemory = ns => resetAllStmt.run(Number(ns));

module.exports = {
    touchChat,
    findChats,
    getChat,
    getChatByKey,
    recentChats,
    setContext,
    chatTitle,
    allChats,
    countChats,
    deleteChats,
    setAiMemory,
    setMemoryUntil,
    setTopicsUntil,
    requestReanalysis,
    finishReanalysis,
    clearAllAiMemory
};
