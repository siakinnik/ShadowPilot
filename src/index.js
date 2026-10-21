// ------------------------------
// index.js - entry point
// ------------------------------

const config = require('../config/config');
const texts = require('../config/texts.json');
const { Telegraf } = require('telegraf-hardened');
const logger = require('./utils/logger');
const { fill, escapeHtml } = require('./utils/text');
const { createBusinessHandlers } = require('./handlers/business');
const { createTrackingHandlers } = require('./handlers/tracking');
const { startDigestWorker } = require('./handlers/digestWorker');
const archive = require('./db/archive');
const { installOwnerChatStyling } = require('./utils/ownerChatApi');
const { createAdminPanel } = require('./admin/panel');
const db = require('./db/sqlite');

// Rich messages + premium emoji in everything sent to the owner's private chat (panel, notifications)
installOwnerChatStyling();

const bot = new Telegraf(config.token);
logger.attachTelegram(bot.telegram);

// One-time upgrade: old AI history becomes the start of the archive
const seeded = archive.seedFromHistory();
if (seeded > 0) logger.info(`archive seeded with ${seeded} messages from the old history`);

// Order matters: business updates first, then the private-chat panel
createBusinessHandlers(bot);
createTrackingHandlers(bot);
createAdminPanel(bot);

bot.catch((err, ctx) => {
    logger.error(`update ${ctx?.updateType || 'unknown'}`, err);
});

async function main() {
    await bot.telegram.setMyCommands([
        { command: 'panel', description: 'Open the control panel' },
        { command: 'reset', description: 'Clear the AI test chat history' },
        { command: 'cancel', description: 'Cancel current input' }
    ], { scope: { type: 'all_private_chats' } }).catch(() => {});

    await bot.launch({
        allowedUpdates: [
            'message',
            'callback_query',
            'business_connection',
            'business_message',
            'edited_business_message',
            'deleted_business_messages'
        ]
    }, () => {
        startDigestWorker(bot.telegram);
        logger.info(
            `ShadowPilot started as @${bot.botInfo.username}`,
            fill(texts.log.started, { username: escapeHtml(bot.botInfo.username) })
        );
    });
}

main().catch(err => {
    logger.error('startup', err);
    process.exit(1);
});

function shutdown(signal) {
    bot.stop(signal);
    db.close();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
