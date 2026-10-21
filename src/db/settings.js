// ------------------------------
// settings.js - runtime settings editable from the admin panel, one set per
// namespace (= Telegram user id of the business account).
// Defaults come from config.js, overrides are persisted in SQLite
// under keys like "123456789:schedule".
// ------------------------------

const db = require('./sqlite');
const config = require('../../config/config');
const { getMember } = require('./members');

// Name the AI uses for the account owner when none was set in the panel:
// admins -> OWNER_NAME, members -> their Telegram first name.
// Resolved on every read, so it follows the member's profile.
function defaultOwnerName(ns) {
    if (config.owner.includes(Number(ns))) return config.ownerName;
    return getMember(ns)?.first_name || config.ownerName;
}

// Keys the panel is allowed to change, with their defaults from config.js
function defaults() {
    return {
        // null = defaultOwnerName()
        ownerName: null,
        aiEnabled: config.aiEnabled,
        markAsRead: config.markAsRead,
        ownerPauseMin: config.ownerPauseMin,
        historyLimit: config.userAiLimit,
        notifyDeleted: config.notifyDeleted,
        notifyEdited: config.notifyEdited,
        autoMemory: config.autoMemory,
        topicsEnabled: config.topicsEnabled,
        topicsHours: config.topicsHours,
        // Regular emoji -> custom emoji pairs, used when the account has Telegram Premium
        premiumEmoji: { enabled: true, map: {} },
        // Rich messages for AI replies (and the panel/notifications when `ui` is on);
        // drafts animate the reply while it is generated (test chat only)
        rich: { enabled: true, ui: true, drafts: true },
        // Custom system instruction from the panel; null = default from config.js
        aiInstruction: null,
        smartWait: { ...config.smartWait },
        schedule: {
            ...config.autoReplySchedule,
            rules: config.autoReplySchedule.rules.map(rule => ({ ...rule }))
        }
    };
}

const selectStmt = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?');
const upsertStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
`);
const deleteNsStmt = db.prepare('DELETE FROM settings WHERE key LIKE ?');

// One-time upgrade: settings saved before namespaces existed belong to the first admin
(function migrateLegacy() {
    const legacy = db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE '%:%'").all();
    if (legacy.length === 0 || config.owner.length === 0) return;
    const ns = config.owner[0];
    db.transaction(() => {
        for (const row of legacy) {
            db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(`${ns}:${row.key}`, row.value);
            db.prepare('DELETE FROM settings WHERE key = ?').run(row.key);
        }
    })();
})();

const cache = new Map(); // ns -> settings

function load(ns) {
    const result = defaults();
    for (const row of selectStmt.all(`${ns}:%`)) {
        const key = row.key.slice(String(ns).length + 1);
        if (!(key in result)) continue;
        try {
            const value = JSON.parse(row.value);
            // Objects are shallow-merged so new config keys still get defaults
            result[key] = (value && typeof value === 'object' && !Array.isArray(value))
                ? { ...result[key], ...value }
                : value;
        } catch {
            // Broken row -> keep default
        }
    }
    return result;
}

function checkNs(ns) {
    const id = Number(ns);
    if (!Number.isFinite(id) || id === 0) throw new Error(`Invalid settings namespace: ${ns}`);
    return id;
}

// Returns a fresh copy of the settings of a namespace
function getSettings(ns) {
    const id = checkNs(ns);
    if (!cache.has(id)) cache.set(id, load(id));
    const settings = structuredClone(cache.get(id));
    settings.ownerName = settings.ownerName || defaultOwnerName(id);
    return settings;
}

// Read-modify-write helper: updateSettings(ns, s => { s.schedule.mode = 'always'; })
function updateSettings(ns, mutator) {
    const id = checkNs(ns);
    const before = getSettings(id);
    const after = getSettings(id);
    mutator(after);
    // An unchanged resolved name stays "default" (not stored)
    if (after.ownerName === before.ownerName && !cache.get(id).ownerName) {
        before.ownerName = after.ownerName = null;
    }
    db.transaction(() => {
        for (const key of Object.keys(after)) {
            if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
                upsertStmt.run(`${id}:${key}`, JSON.stringify(after[key]));
            }
        }
    })();
    cache.delete(id);
    return getSettings(id);
}

// Removes every saved setting of a namespace (back to defaults)
function resetSettings(ns) {
    const id = checkNs(ns);
    deleteNsStmt.run(`${id}:%`);
    cache.delete(id);
}

module.exports = { getSettings, updateSettings, resetSettings };
