// ------------------------------
// topics.js - "recent dialogs": conversation topics detected by the AI.
// A topic can be continued later (project -> small talk -> project again),
// its counters and time range then grow.
// ------------------------------

const db = require('./sqlite');

db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key       TEXT NOT NULL,
        title          TEXT NOT NULL,
        summary        TEXT,
        message_count  INTEGER NOT NULL DEFAULT 0,
        first_at       INTEGER NOT NULL,        -- unix seconds
        last_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topics_chat ON topics (chat_key, last_at);
    CREATE INDEX IF NOT EXISTS idx_topics_last ON topics (last_at);
`);

const insertStmt = db.prepare(`
    INSERT INTO topics (chat_key, title, summary, message_count, first_at, last_at)
    VALUES (@chat_key, @title, @summary, @message_count, @first_at, @last_at)
`);
const extendStmt = db.prepare(`
    UPDATE topics SET
        title = @title,
        summary = @summary,
        message_count = message_count + @message_count,
        first_at = MIN(first_at, @first_at),
        last_at = MAX(last_at, @last_at)
    WHERE id = @id AND chat_key = @chat_key
`);
const chatTopicsStmt = db.prepare('SELECT * FROM topics WHERE chat_key = ? AND last_at >= ? ORDER BY last_at DESC LIMIT ?');
const recentStmt = db.prepare(`
    SELECT topics.*, chats.id AS chat_row_id, chats.first_name, chats.last_name, chats.username, chats.chat_id
    FROM topics LEFT JOIN chats ON chats.chat_key = topics.chat_key
    WHERE topics.last_at >= ? AND topics.chat_key LIKE ? ORDER BY topics.last_at DESC LIMIT ?
`);
const deleteChatStmt = db.prepare('DELETE FROM topics WHERE chat_key = ?');
const purgeStmt = db.prepare('DELETE FROM topics WHERE last_at < ? AND chat_key LIKE ?');
const deleteAllStmt = db.prepare('DELETE FROM topics WHERE chat_key LIKE ?');

const sinceHours = hours => Math.floor(Date.now() / 1000) - hours * 3600;

// Topics of one chat updated within the last `hours`
const chatTopics = (chatKey, hours, limit = 20) => chatTopicsStmt.all(chatKey, sinceHours(hours), limit);

// Topics across all chats of a namespace updated within the last `hours`
const recentTopics = (ns, hours, limit = 10) => recentStmt.all(sinceHours(hours), 'b:' + Number(ns) + ':%', limit);

/**
 * Creates a topic or extends an existing one of the same chat.
 * @returns {number} topic id
 */
function upsertTopic({ id, chatKey, title, summary, messageCount, firstAt, lastAt }) {
    const row = {
        chat_key: chatKey,
        title,
        summary,
        message_count: messageCount,
        first_at: firstAt,
        last_at: lastAt
    };
    if (id && extendStmt.run({ ...row, id }).changes > 0) return id;
    return Number(insertStmt.run(row).lastInsertRowid);
}

const deleteChatTopics = chatKey => deleteChatStmt.run(chatKey);
// Removes topics of a namespace older than `hours`
const purgeTopics = (ns, hours) => purgeStmt.run(sinceHours(hours), 'b:' + Number(ns) + ':%').changes;
const deleteAllTopics = ns => deleteAllStmt.run('b:' + Number(ns) + ':%');

module.exports = { chatTopics, recentTopics, upsertTopic, deleteChatTopics, deleteAllTopics, purgeTopics };
