// ------------------------------
// messageText.js - converts any Telegram message into one line of text
// for the AI context ("[photo] caption", "[voice message]"...)
// ------------------------------

const texts = require('../../config/texts.json');
const { fill } = require('./text');

// Keys that never hold user-visible text in rich blocks
const RICH_SKIP = new Set(['type', 'url', 'id', 'name', 'file_id', 'file_unique_id', 'custom_emoji_id', 'language', 'mime_type', 'user', 'size']);

// Collects the visible text of a rich message (Bot API 10.3): RichText is a string,
// an array of RichText or an object with a nested `text`; blocks are separated by lines
function richToText(node, out = []) {
    if (typeof node === 'string') {
        out.push(node);
    } else if (Array.isArray(node)) {
        for (const item of node) richToText(item, out);
    } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            if (RICH_SKIP.has(key)) continue;
            richToText(value, out);
            if (key === 'blocks' || key === 'items' || key === 'cells') out.push('\n');
        }
        if (node.type && /^(paragraph|heading|preformatted|footer|block_quotation|list_item)/.test(node.type)) out.push('\n');
    }
    return out;
}

function messageToText(message) {
    if (message.text) return message.text;
    if (message.rich_message) {
        return richToText(message.rich_message.blocks).join('').replace(/\n{2,}/g, '\n').trim() || texts.media.other;
    }
    const caption = message.caption ? ` ${message.caption}` : '';
    const media = texts.media;
    if (message.photo) return media.photo + caption;
    if (message.video) return media.video + caption;
    if (message.voice) return media.voice + caption;
    if (message.video_note) return media.video_note;
    if (message.audio) return media.audio + caption;
    if (message.animation) return media.animation + caption;
    if (message.document) return media.document + caption;
    if (message.sticker) return fill(media.sticker, { emoji: message.sticker.emoji || '' });
    if (message.location) return media.location;
    if (message.contact) return media.contact;
    if (message.poll) return `${media.poll} ${message.poll.question}`;
    return media.other;
}

module.exports = { messageToText };
