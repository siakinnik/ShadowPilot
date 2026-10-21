// ------------------------------
// memory.js - chat history stored in SQLite (AI context)
// ------------------------------

const db = require('../db/sqlite');

const insertStmt = db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)');
const historyStmt = db.prepare(`
    SELECT role, content FROM (
        SELECT id, role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
`);
// Rotation: keep only the newest `limit` rows of a chat
const rotateStmt = db.prepare(`
    DELETE FROM messages
    WHERE chat_id = ?
      AND id NOT IN (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)
`);
const clearChatStmt = db.prepare('DELETE FROM messages WHERE chat_id = ?');
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?');
const clearAllStmt = db.prepare('DELETE FROM messages');

const addAndRotate = db.transaction((chatId, role, content, limit) => {
    insertStmt.run(chatId, role, content);
    rotateStmt.run(chatId, chatId, limit);
});

/**
 * Saves a message and drops everything beyond the history depth.
 * @param {string} chatId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {number} limit history depth for this chat
 */
function addMessage(chatId, role, content, limit) {
    if (!content || !content.trim()) return;
    addAndRotate(String(chatId), role, content, limit);
}

// Last `limit` messages in chronological order, ready for the OpenAI API
function getHistory(chatId, limit) {
    return historyStmt.all(String(chatId), limit);
}

function clearHistory(chatId) {
    clearChatStmt.run(String(chatId));
}

function countHistory(chatId) {
    return countStmt.get(String(chatId)).n;
}

function clearAllHistory() {
    clearAllStmt.run();
}

module.exports = { addMessage, getHistory, countHistory, clearHistory, clearAllHistory };
