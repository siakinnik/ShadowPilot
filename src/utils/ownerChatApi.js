// ------------------------------
// ownerChatApi.js - styling of everything the bot sends to the owner's private
// chat (control panel, deleted/edited notifications, reports):
//   - premium emoji (only when the account has Telegram Premium);
//   - rich messages (Bot API 10.3) instead of classic HTML.
//
// telegraf creates a new Telegram client for every update, so the hook is
// installed on the Telegram prototype. Messages to other chats are untouched,
// and payloads built by streamRenderer (marked with markRaw) are passed as is.
// If Telegram rejects a styled message, the plain one is sent and the feature
// pauses for an hour.
// ------------------------------

const { Telegram } = require('telegraf-hardened');
const config = require('../../config/config');
const { getSettings } = require('../db/settings');
const { hasPremiumConnection } = require('../db/connections');
const { canUse } = require('../db/members');
const { premiumize } = require('./premiumEmoji');
const { classicToRich } = require('./classicToRich');
const { escapeHtml } = require('./text');

const PAUSE_MS = 60 * 60 * 1000;
const paused = { premium: 0, rich: 0 };

// Payloads that already have their final form (AI replies from streamRenderer)
const raw = new WeakSet();
const markRaw = payload => {
    raw.add(payload);
    return payload;
};

// Methods with HTML text / caption that can be styled
const TEXT_FIELD = {
    sendMessage: 'text',
    editMessageText: 'text',
    sendPhoto: 'caption',
    sendVideo: 'caption',
    sendVoice: 'caption',
    sendAudio: 'caption',
    sendAnimation: 'caption',
    sendDocument: 'caption'
};
const RICH_METHOD = { sendMessage: 'sendRichMessage', editMessageText: 'editMessageText' };

// Private chat of an admin or an approved member (chat id = user id = namespace)
const isOwnerChat = payload => !payload.business_connection_id && canUse(payload.chat_id);
const isRejection = err => [400, 403, 404].includes(err?.response?.error_code)
    && !/not modified/i.test(err?.response?.description || err?.message || '');

/**
 * Variants of a request from the most styled to the original one.
 * @returns {{ method: string, payload: object, feature: string|null }[]}
 */
function variants(method, payload) {
    const original = [{ method, payload, feature: null }];
    const field = TEXT_FIELD[method];
    if (!field || !payload || raw.has(payload) || typeof payload[field] !== 'string') return original;
    if (payload.entities || payload.caption_entities || !isOwnerChat(payload)) return original;
    if (payload.parse_mode && payload.parse_mode !== 'HTML') return original;

    const ns = Number(payload.chat_id);
    const settings = getSettings(ns);
    const now = Date.now();
    // Plain-text messages are treated as HTML so they can be styled too
    const html = payload.parse_mode === 'HTML' ? payload[field] : escapeHtml(payload[field]);

    const usePremium = now >= paused.premium && settings.premiumEmoji.enabled
        && Object.keys(settings.premiumEmoji.map).length > 0 && hasPremiumConnection(ns);
    const styled = usePremium ? premiumize(html, settings.premiumEmoji.map) : html;

    const list = [];
    if (RICH_METHOD[method] && settings.rich.ui && now >= paused.rich) {
        const { text, parse_mode, entities, link_preview_options, ...rest } = payload;
        list.push({ method: RICH_METHOD[method], payload: { ...rest, rich_message: { html: classicToRich(styled) } }, feature: 'rich' });
    }
    if (styled !== html) list.push({ method, payload: { ...payload, [field]: styled, parse_mode: 'HTML' }, feature: 'premium' });
    return list.length ? [...list, ...original] : original;
}

function installOwnerChatStyling() {
    const original = Telegram.prototype.callApi;
    Telegram.prototype.callApi = async function callApi(method, payload, options) {
        const list = variants(method, payload);
        const failed = [];
        for (let i = 0; i < list.length; i++) {
            const attempt = list[i];
            try {
                const result = await original.call(this, attempt.method, attempt.payload, options);
                // A simpler variant worked -> the styled ones were the problem: pause them
                for (const feature of failed) paused[feature] = Date.now() + PAUSE_MS;
                return result;
            } catch (err) {
                // Last variant (the original request) or a non-format error: give up as usual
                if (i === list.length - 1 || !isRejection(err)) throw err;
                if (attempt.feature) failed.push(attempt.feature);
            }
        }
        return undefined;
    };
}

module.exports = { installOwnerChatStyling, markRaw, variants };
