// ------------------------------
// members.js - people who connected the bot to their Telegram Business account.
// Admins (OWNER in .env) are always allowed. Everyone else needs an admin's
// approval; until then the bot neither answers in their chats nor stores them.
// Every member has an own namespace (settings, chats, memory) = their user id.
// ------------------------------

const db = require('./sqlite');
const config = require('../../config/config');

db.exec(`
    CREATE TABLE IF NOT EXISTS members (
        user_id       INTEGER PRIMARY KEY,
        first_name    TEXT,
        last_name     TEXT,
        username      TEXT,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        decided_by    INTEGER,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const getStmt = db.prepare('SELECT * FROM members WHERE user_id = ?');
const insertStmt = db.prepare(`
    INSERT INTO members (user_id, first_name, last_name, username, status)
    VALUES (@user_id, @first_name, @last_name, @username, @status)
`);
const profileStmt = db.prepare(`
    UPDATE members SET first_name = @first_name, last_name = @last_name, username = @username,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @user_id
`);
const statusStmt = db.prepare('UPDATE members SET status = ?, decided_by = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?');
const listStmt = db.prepare(`
    SELECT * FROM members
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, updated_at DESC
`);
const deleteStmt = db.prepare('DELETE FROM members WHERE user_id = ?');

const isAdmin = userId => config.owner.includes(Number(userId));
const getMember = userId => getStmt.get(Number(userId));

// Admins always; others only when approved
function canUse(userId) {
    if (isAdmin(userId)) return true;
    return getMember(userId)?.status === 'approved';
}

/**
 * Creates or refreshes a member from a Telegram User.
 * @returns {{ member: object, isNew: boolean }}
 */
function upsertMember(user) {
    const row = {
        user_id: user.id,
        first_name: user.first_name || null,
        last_name: user.last_name || null,
        username: user.username || null
    };
    const existing = getMember(user.id);
    if (existing) {
        profileStmt.run(row);
        return { member: getMember(user.id), isNew: false };
    }
    const status = isAdmin(user.id) || config.autoApprove ? 'approved' : 'pending';
    insertStmt.run({ ...row, status });
    return { member: getMember(user.id), isNew: true };
}

function setStatus(userId, status, decidedBy) {
    statusStmt.run(status, decidedBy ?? null, Number(userId));
    return getMember(userId);
}

const listMembers = () => listStmt.all();
const removeMember = userId => deleteStmt.run(Number(userId));

// "Name (@username)" for UI
function memberTitle(member, fallbackId) {
    if (!member) return String(fallbackId ?? '?');
    const name = [member.first_name, member.last_name].filter(Boolean).join(' ') || String(member.user_id);
    return member.username ? `${name} (@${member.username})` : name;
}

// Namespace of an archive/chat key "b:<userId>:<chatId>"
const namespaceOfKey = key => Number(String(key).split(':')[1]);

module.exports = {
    isAdmin,
    canUse,
    getMember,
    upsertMember,
    setStatus,
    listMembers,
    removeMember,
    memberTitle,
    namespaceOfKey
};
