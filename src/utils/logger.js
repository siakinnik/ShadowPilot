// ------------------------------
// logger.js - console logging + optional mirror to the error channel
// ------------------------------

const config = require('../../config/config');
const texts = require('../../config/texts.json');
const { escapeHtml, fill } = require('./text');

let telegram = null;

// Called once from index.js after the bot is created
function attachTelegram(instance) {
    telegram = instance;
}

async function toChannel(html) {
    if (!telegram || !config.errChannel) return;
    try {
        await telegram.callApi('sendMessage', {
            chat_id: config.errChannel,
            text: html.slice(0, 4096),
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true }
        });
    } catch (err) {
        console.error('[logger] failed to send to error channel:', err.message);
    }
}

function info(message, html) {
    console.log(`[${new Date().toISOString()}] ${message}`);
    if (html) toChannel(html);
}

function error(where, err) {
    const message = err?.stack || err?.message || String(err);
    console.error(`[${new Date().toISOString()}] [${where}]`, message);
    toChannel(fill(texts.log.error, {
        where: escapeHtml(where),
        message: escapeHtml(message.slice(0, 3000))
    }));
}

module.exports = { attachTelegram, info, error };
