// ------------------------------
// transcript.js - turns archived chat rows into one transcript with explicit authors.
// Small models confuse roles when the owner's own messages and the bot's replies
// are both sent as "assistant", so every line is labeled instead.
// ------------------------------

const config = require('../../config/config');
const { fill } = require('../utils/text');
const { formatDateTime } = require('../utils/time');

function label(role, contact, ownerName) {
    if (role === 'them') return contact;
    if (role === 'owner') return `${ownerName} - personally`;
    return 'You - AI assistant';
}

// "[09.10 14:03] [Dima]: text" lines
function transcriptLines(rows, contact, ownerName) {
    return rows
        .map(row => `[${formatDateTime(row.sent_at)}] [${label(row.role, contact, ownerName)}]: ${row.summary}`)
        .join('\n');
}

/**
 * Chat history as OpenAI messages: a single user message with the labeled transcript.
 * @param {object[]} rows    archive rows, oldest first
 * @param {string}   contact name of the other person
 * @param {string}   ownerName name of the account owner
 * @param {string}   [chatContext] owner's context for this chat, repeated before the reply
 */
function transcriptMessages(rows, contact, ownerName, chatContext) {
    const reminder = chatContext
        ? fill(config.aiChatContextReminder, { ownerName, context: chatContext }).trim() + '\n'
        : '';
    const content = fill(config.aiTranscript, {
        contact,
        ownerName,
        reminder,
        lines: transcriptLines(rows, contact, ownerName) || '(no messages)'
    }).replace(/\n{3,}/g, '\n\n').trim();
    return [{ role: 'user', content }];
}

module.exports = { transcriptLines, transcriptMessages };
