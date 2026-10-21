// ------------------------------
// connections.js - cache of Telegram Business connections
// ------------------------------

const db = require('./sqlite');

// Column added later - migrate existing databases in place
const columns = new Set(db.prepare('PRAGMA table_info(business_connections)').all().map(col => col.name));
if (!columns.has('is_premium')) db.exec('ALTER TABLE business_connections ADD COLUMN is_premium INTEGER');

// Premium status and rights can change without a business_connection update
const REFRESH_MS = 24 * 60 * 60 * 1000;

const upsertStmt = db.prepare(`
    INSERT INTO business_connections (id, user_id, user_chat_id, user_name, can_reply, can_read, is_enabled, is_premium, updated_at)
    VALUES (@id, @user_id, @user_chat_id, @user_name, @can_reply, @can_read, @is_enabled, @is_premium, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        user_chat_id = excluded.user_chat_id,
        user_name = excluded.user_name,
        can_reply = excluded.can_reply,
        can_read = excluded.can_read,
        is_enabled = excluded.is_enabled,
        is_premium = excluded.is_premium,
        updated_at = CURRENT_TIMESTAMP
`);
const getStmt = db.prepare('SELECT * FROM business_connections WHERE id = ?');
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM business_connections WHERE is_enabled = 1 AND user_id = ?');
const premiumStmt = db.prepare('SELECT COUNT(*) AS n FROM business_connections WHERE is_enabled = 1 AND is_premium = 1 AND user_id = ?');
const byUserStmt = db.prepare('SELECT * FROM business_connections WHERE user_id = ? ORDER BY updated_at DESC');

// Converts a Bot API BusinessConnection into a DB row.
// Bot API 9.0+ uses `rights`, older versions only had `can_reply`.
function toRow(connection) {
    const rights = connection.rights || {};
    return {
        id: connection.id,
        user_id: connection.user.id,
        user_chat_id: connection.user_chat_id ?? null,
        user_name: [connection.user.first_name, connection.user.last_name].filter(Boolean).join(' ') || null,
        can_reply: (rights.can_reply ?? connection.can_reply) ? 1 : 0,
        can_read: rights.can_read_messages ? 1 : 0,
        is_enabled: connection.is_enabled ? 1 : 0,
        is_premium: connection.user.is_premium ? 1 : 0
    };
}

function saveConnection(connection) {
    const row = toRow(connection);
    upsertStmt.run(row);
    return row;
}

// A connection without rights is re-checked often: rights can be granted later and
// Telegram does not always send a business_connection update for that
const REFRESH_LIMITED_MS = 60 * 1000;

// Returns the cached connection; fetches it from Telegram when unknown or stale
async function getConnection(telegram, id) {
    const cached = getStmt.get(id);
    const age = cached ? Date.now() - Date.parse(`${cached.updated_at}Z`) : Infinity;
    const limited = cached && (!cached.is_enabled || !cached.can_reply);
    const maxAge = limited ? REFRESH_LIMITED_MS : REFRESH_MS;
    if (cached && cached.is_premium !== null && age < maxAge) return cached;
    try {
        const fresh = await telegram.callApi('getBusinessConnection', { business_connection_id: id });
        return saveConnection(fresh);
    } catch (err) {
        // A stale row is better than no reply
        if (cached) return cached;
        throw err;
    }
}

// Active connections of one business account (namespace)
function countActiveConnections(userId) {
    return countStmt.get(Number(userId)).n;
}

// True if the business account (namespace) has Telegram Premium
function hasPremiumConnection(userId) {
    return premiumStmt.get(Number(userId)).n > 0;
}

const connectionsOf = userId => byUserStmt.all(Number(userId));

module.exports = { saveConnection, getConnection, countActiveConnections, hasPremiumConnection, connectionsOf };
