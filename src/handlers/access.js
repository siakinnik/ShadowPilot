// ------------------------------
// access.js - approval flow for new business connections.
// A non-admin connects the bot -> every admin gets a request with
// Approve / Reject buttons, the person gets a "waiting" message.
// ------------------------------

const config = require('../../config/config');
const texts = require('../../config/texts.json');
const { getMember, setStatus, memberTitle } = require('../db/members');
const { connectionsOf } = require('../db/connections');
const { escapeHtml, fill } = require('../utils/text');
const logger = require('../utils/logger');

const T = texts.access;

const btn = (text, data) => ({ text, callback_data: `sp:${data}` });

// Private chat of the business account with the bot (to tell them about decisions)
function memberChatId(userId) {
    return connectionsOf(userId)[0]?.user_chat_id || userId;
}

async function send(telegram, chatId, text, keyboard) {
    try {
        await telegram.callApi('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
        });
    } catch (err) {
        // The person may never have opened the bot - that's fine
        logger.info(`[access] could not message ${chatId}: ${err.message}`);
    }
}

// Request card for admins
function requestText(member, connection) {
    return fill(T.request, {
        name: escapeHtml(memberTitle(member)),
        id: member.user_id,
        canReply: connection?.can_reply ? '✅' : '❌',
        canRead: connection?.can_read ? '✅' : '❌',
        premium: connection?.is_premium ? '✅' : '❌'
    });
}

const decisionKeyboard = userId => [[btn(T.btn_approve, `mapp:${userId}`), btn(T.btn_reject, `mrej:${userId}`)]];

/**
 * Called for every business_connection update.
 * @param {object} member   members row
 * @param {boolean} isNew   first time this account connected
 * @param {object} connection business_connections row
 */
async function onConnection(telegram, member, isNew, connection) {
    if (!isNew || member.status !== 'pending') return;
    for (const adminId of config.owner) {
        await send(telegram, adminId, requestText(member, connection), decisionKeyboard(member.user_id));
    }
    await send(telegram, connection.user_chat_id || member.user_id, T.waiting);
}

/**
 * Approves / rejects / revokes a member and tells them.
 * @param {'approved'|'rejected'} status
 */
async function decide(telegram, userId, status, adminId) {
    const before = getMember(userId);
    if (!before) return null;
    const member = setStatus(userId, status, adminId);
    if (before.status !== status) {
        const message = status === 'approved' ? T.approved : (before.status === 'approved' ? T.revoked : T.rejected);
        await send(telegram, memberChatId(userId), message);
    }
    return member;
}

module.exports = { onConnection, decide, requestText, decisionKeyboard };
