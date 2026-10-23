// ------------------------------
// business.js - Telegram Business updates:
//   business_connection -> remember the connection & rights, ask admins for approval
//   business_message    -> archive, smart wait, stream an AI reply
//
// Every business account is a namespace (its Telegram user id): own settings,
// chats, memory. Messages of accounts that are not approved are ignored.
// ------------------------------

const config = require('../../config/config');
const texts = require('../../config/texts.json');
const archive = require('../db/archive');
const { buildSystemPrompt, streamReply, judgeTurn } = require('../ai/openai');
const { getSettings } = require('../db/settings');
const { saveConnection, getConnection } = require('../db/connections');
const { touchChat, getChatByKey, aiModeOf } = require('../db/chats');
const { canUse, getMember, upsertMember, namespaceOfKey } = require('../db/members');
const { transcriptLines, transcriptMessages } = require('../ai/transcript');
const { checkSchedule } = require('../utils/scheduleChecker');
const { messageToText } = require('../utils/messageText');
const { escapeHtml, fill } = require('../utils/text');
const { premiumize } = require('../utils/premiumEmoji');
const { renderStream } = require('./streamRenderer');
const { SmartWaitQueue } = require('./smartWait');
const access = require('./access');
const logger = require('../utils/logger');

// chatKey -> timestamp of the owner's last personal message in that chat
const ownerActivity = new Map();

// Archive key: one history per (business account, client chat)
function chatKey(connection, chatId) {
    return `b:${connection.user_id}:${chatId}`;
}

// Display name of the other person for prompts
function contactOf(key) {
    const chat = getChatByKey(key);
    return chat?.first_name || (chat?.username ? `@${chat.username}` : 'Contact');
}

// Builds the HTML header shown ABOVE every AI reply (classic or rich format)
function buildPrefix(reason, ownerName, template = texts.ai_prefix) {
    return fill(template, {
        ownerName: escapeHtml(ownerName),
        reason: escapeHtml(reason)
    });
}

/**
 * Generates and streams one reply. Shared with the test chat in the admin panel.
 * @param {number} params.ns  namespace (business account user id) whose settings are used
 * @returns {Promise<{ text: string, messageId: number }>}
 */
async function generateReply({ telegram, ns, chatId, businessConnectionId, history, reason, time, replyTo, chatContext, aiMemory, premium }) {
    const { premiumEmoji, rich, ownerName, aiInstruction } = getSettings(ns);
    const usePremium = premium && premiumEmoji.enabled && Object.keys(premiumEmoji.map).length > 0;
    return renderStream({
        telegram,
        chatId,
        businessConnectionId,
        replyTo,
        ownerName,
        richPrefix: buildPrefix(reason, ownerName, texts.ai_prefix_rich),
        // Always tried; if Telegram refuses (e.g. an account without Premium) the reply
        // falls back to classic HTML and rich pauses for that account only
        rich: rich.enabled,
        scope: businessConnectionId ? `ns:${ns}` : 'bot',
        // Drafts only work in the bot's own chat: in business chats Telegram shows
        // them from the bot in a separate chat, so they are never used there
        draft: !businessConnectionId && rich.drafts,
        // Custom emoji only when the account owner has Telegram Premium
        decorate: usePremium ? html => premiumize(html, premiumEmoji.map) : undefined,
        prefix: buildPrefix(reason, ownerName),
        chunks: streamReply({
            system: buildSystemPrompt({ reason, time, chatContext, aiMemory, instruction: aiInstruction, ownerName }),
            history
        })
    });
}

// Makes sure the account is known; asks admins for approval the first time
async function ensureMember(telegram, connection, user) {
    const known = getMember(connection.user_id);
    if (known && !user) return known;
    const { member, isNew } = upsertMember(user || { id: connection.user_id, first_name: connection.user_name });
    await access.onConnection(telegram, member, isNew, connection);
    return member;
}

function createBusinessHandlers(bot) {
    const queue = new SmartWaitQueue({
        getSettings: key => getSettings(namespaceOfKey(key)).smartWait,

        judge: async (key, batch) => {
            const settings = getSettings(namespaceOfKey(key));
            if (!settings.aiEnabled) return 'reply';
            const rows = archive.contextRows(key, 6 + batch.length).slice(0, -batch.length);
            return judgeTurn({
                context: transcriptLines(rows, contactOf(key), settings.ownerName),
                pending: batch.map(item => item.text)
            });
        },

        // Called once the batch looks complete
        onFlush: async (key, batch) => {
            const ns = namespaceOfKey(key);
            if (!canUse(ns)) return; // access revoked while waiting
            // AI was switched off for this chat while the messages were waiting
            if (aiModeOf(getChatByKey(key))) return;
            const settings = getSettings(ns);
            const last = batch[batch.length - 1];
            const status = checkSchedule(settings.schedule, config.timezone);

            if (!settings.aiEnabled || !status.active) return;

            // The owner answered personally a moment ago -> stay silent
            const lastOwner = ownerActivity.get(key) || 0;
            if (settings.ownerPauseMin > 0 && Date.now() - lastOwner < settings.ownerPauseMin * 60_000) return;

            const connection = await getConnection(bot.telegram, last.connectionId);
            if (!connection.is_enabled || !connection.can_reply) return;

            if (settings.markAsRead && connection.can_read) {
                await bot.telegram.callApi('readBusinessMessage', {
                    business_connection_id: last.connectionId,
                    chat_id: last.chatId,
                    message_id: last.messageId
                }).catch(err => logger.error('readBusinessMessage', err));
            }

            const chat = getChatByKey(key);
            const reply = await generateReply({
                telegram: bot.telegram,
                ns,
                chatId: last.chatId,
                businessConnectionId: last.connectionId,
                // The whole chat is archived; only the last N messages go to the AI,
                // as a transcript with explicit authors (them / owner personally / AI)
                history: transcriptMessages(archive.contextRows(key, settings.historyLimit), contactOf(key), settings.ownerName, chat?.context),
                reason: status.reason,
                time: status.time,
                chatContext: chat?.context,
                aiMemory: settings.autoMemory ? chat?.ai_memory : null,
                premium: Boolean(connection.is_premium),
                // Quote the message only when the batch is a single message
                replyTo: batch.length === 1 ? last.messageId : undefined
            });
            if (reply.text) {
                archive.archiveMessage(key, 'ai', { message_id: reply.messageId, text: reply.text }, reply.text);
            }
        }
    });

    // Bot connected / disconnected / rights changed in Telegram Business settings
    bot.on('business_connection', async ctx => {
        const connection = ctx.update.business_connection;
        const row = saveConnection(connection);
        const member = await ensureMember(ctx.telegram, row, connection.user);
        logger.info(
            `business connection ${row.id} ${row.is_enabled ? 'enabled' : 'disabled'} for ${row.user_id} (${member.status})`,
            fill(texts.log.connection, {
                state: row.is_enabled ? texts.log.connection_enabled : texts.log.connection_disabled,
                name: escapeHtml(row.user_name || row.user_id),
                canReply: row.can_reply ? '✅' : '❌',
                canRead: row.can_read ? '✅' : '❌'
            })
        );
    });

    bot.on('business_message', async ctx => {
        const message = ctx.update.business_message;
        if (message.chat.type !== 'private') return;
        // Our own replies sent on behalf of the account come back as updates too
        if (message.sender_business_bot) return;
        if (message.from?.is_bot) return;

        let connection;
        try {
            connection = await getConnection(ctx.telegram, message.business_connection_id);
        } catch (err) {
            logger.error('getBusinessConnection', err);
            return;
        }

        // Accounts that connected before approvals existed get a request now
        await ensureMember(ctx.telegram, connection);
        // Not approved: neither answer nor store anything
        if (!canUse(connection.user_id)) return;

        const key = chatKey(connection, message.chat.id);
        const text = messageToText(message);
        touchChat(key, connection.user_id, message.chat);
        // Per-chat switch from the panel: no auto-replies, or the AI does not see the chat at all
        const aiMode = aiModeOf(getChatByKey(key));
        const hidden = aiMode === 'ai_off';

        // Message written by the account owner personally
        if (message.from?.id === connection.user_id) {
            archive.archiveMessage(key, 'owner', message, text, { hidden });
            ownerActivity.set(key, Date.now());
            queue.cancel(key);
            return;
        }

        archive.archiveMessage(key, 'them', message, text, { hidden });
        if (aiMode) return;
        queue.push(key, {
            text: message.text || message.caption || '',
            chatId: message.chat.id,
            messageId: message.message_id,
            connectionId: message.business_connection_id
        });
    });
}

module.exports = { createBusinessHandlers, generateReply, buildPrefix };
