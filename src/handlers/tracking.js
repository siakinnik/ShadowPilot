// ------------------------------
// tracking.js - edited / deleted business messages.
// The archive always gets updated; if enabled in the panel, the owner
// receives the original text (and media) in the bot's private chat.
// ------------------------------

const texts = require('../../config/texts.json');
const archive = require('../db/archive');
const { getConnection } = require('../db/connections');
const { getChatByKey, chatTitle } = require('../db/chats');
const { getSettings } = require('../db/settings');
const { canUse } = require('../db/members');
const { messageToText } = require('../utils/messageText');
const { escapeHtml, fill } = require('../utils/text');
const { formatDateTime } = require('../utils/time');
const logger = require('../utils/logger');

const T = texts.tracking;

// Bot API method + field for re-sending archived media by file_id
const RESEND = {
    photo: ['sendPhoto', 'photo', true],
    video: ['sendVideo', 'video', true],
    voice: ['sendVoice', 'voice', true],
    video_note: ['sendVideoNote', 'video_note', false],
    audio: ['sendAudio', 'audio', true],
    animation: ['sendAnimation', 'animation', true],
    document: ['sendDocument', 'document', true],
    sticker: ['sendSticker', 'sticker', false]
};

const chatKeyOf = (connection, chatId) => `b:${connection.user_id}:${chatId}`;

// Where notifications go: the account owner's private chat with the bot
const ownerChatOf = connection => connection.user_chat_id || connection.user_id;

function displayName(key, chat) {
    const known = getChatByKey(key);
    if (known) return chatTitle(known);
    return [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id);
}

// Blockquote with the message text (or a media placeholder), escaped and length-limited
function quote(row) {
    const body = row.text || row.summary || '';
    return `<blockquote expandable>${escapeHtml(body.slice(0, 1500))}</blockquote>`;
}

async function loadConnection(telegram, id) {
    try {
        const connection = await getConnection(telegram, id);
        // Accounts that are not approved are ignored completely
        if (!canUse(connection.user_id)) return null;
        return connection;
    } catch (err) {
        logger.error('getBusinessConnection', err);
        return null;
    }
}

function createTrackingHandlers(bot) {
    bot.on('edited_business_message', async ctx => {
        const message = ctx.update.edited_business_message;
        if (message.chat.type !== 'private' || message.sender_business_bot) return;
        const connection = await loadConnection(ctx.telegram, message.business_connection_id);
        if (!connection) return;

        const key = chatKeyOf(connection, message.chat.id);
        const before = archive.applyEdit(key, message, messageToText(message));
        const fromOwner = message.from?.id === connection.user_id;
        if (!before || fromOwner || !getSettings(connection.user_id).notifyEdited) return;

        const after = message.text ?? message.caption ?? '';
        if ((before.text || '') === after) return; // e.g. only a link preview changed

        await ctx.telegram.callApi('sendMessage', {
            chat_id: ownerChatOf(connection),
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            text: fill(T.edited, {
                name: escapeHtml(displayName(key, message.chat)),
                sent: formatDateTime(before.sent_at),
                before: quote(before),
                after: quote({ text: after, summary: messageToText(message) })
            })
        }).catch(err => logger.error('notify edited', err));
    });

    bot.on('deleted_business_messages', async ctx => {
        const update = ctx.update.deleted_business_messages;
        const connection = await loadConnection(ctx.telegram, update.business_connection_id);
        if (!connection) return;

        const key = chatKeyOf(connection, update.chat.id);
        const rows = [];
        let unknown = 0;
        for (const messageId of update.message_ids) {
            const row = archive.getArchived(key, messageId);
            if (!row) {
                unknown++;
                continue;
            }
            archive.markDeleted(row.id);
            if (row.role === 'them') rows.push(row);
        }
        // Unknown ids are only mentioned next to known messages of the other person,
        // otherwise every deletion made by the owner would trigger a notification
        if (!getSettings(connection.user_id).notifyDeleted || rows.length === 0) return;

        const chatId = ownerChatOf(connection);
        const name = escapeHtml(displayName(key, update.chat));
        const lines = [fill(T.deleted, { name, count: rows.length })];
        for (const row of rows) {
            lines.push(fill(T.deleted_item, { quote: quote(row), sent: formatDateTime(row.sent_at) }));
        }
        if (unknown > 0) lines.push(fill(T.deleted_unknown, { count: unknown }));

        try {
            await ctx.telegram.callApi('sendMessage', {
                chat_id: chatId,
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                text: lines.join('\n\n').slice(0, 4096)
            });

            // Media can be re-sent by file_id
            for (const row of rows) {
                const resend = RESEND[row.media_type];
                if (!resend || !row.file_id) continue;
                const [method, field, hasCaption] = resend;
                await ctx.telegram.callApi(method, {
                    chat_id: chatId,
                    [field]: row.file_id,
                    ...(hasCaption ? {
                        parse_mode: 'HTML',
                        caption: fill(T.media_caption, { name, sent: formatDateTime(row.sent_at) })
                    } : {})
                }).catch(err => logger.error(`resend deleted ${row.media_type}`, err));
            }
        } catch (err) {
            logger.error('notify deleted', err);
        }
    });
}

module.exports = { createTrackingHandlers };
