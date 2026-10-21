// ------------------------------
// streamRenderer.js - renders a streamed AI reply in Telegram.
//
// Two delivery modes:
//   edit  - send a placeholder message, then edit it every `streamIntervalMs`;
//   draft - stream with sendMessageDraft / sendRichMessageDraft (animated typing),
//           then send the final message.
// Two formats:
//   classic HTML (text + parse_mode) or rich messages (rich_message.html, Bot API 10.3).
//
// Everything optional degrades step by step when Telegram rejects it:
// premium emoji -> rich format -> drafts, down to plain edit-mode HTML.
// ------------------------------

const config = require('../../config/config');
const texts = require('../../config/texts.json');
const { fitMessage, fill, escapeHtml } = require('../utils/text');
const { markdownToRich } = require('../utils/markdownToRich');
const logger = require('../utils/logger');
const { callApiRetry } = require('../utils/telegramRetry');
const { markRaw } = require('../utils/ownerChatApi');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = html => html;
const MAX_RICH_SOURCE = 3500; // raw characters of the AI text in one rich message

// Features Telegram rejected recently, per scope ("bot" = the bot's own chats,
// "ns:<id>" = replies on behalf of one business account); skipped until `until`.
// Scoped so that one account without Premium never disables rich for the others.
const REJECT_MS = { rich: 60 * 60 * 1000, draft: 60 * 60 * 1000 };
const capability = new Map(); // `${name}|${scope}` -> { until, error }

const usable = (name, scope) => Date.now() >= (capability.get(`${name}|${scope}`)?.until || 0);

function reject(name, scope, err) {
    const error = err?.response?.description || err?.description || err?.message || String(err);
    capability.set(`${name}|${scope}`, { until: Date.now() + REJECT_MS[name], error });
    logger.info(`[renderer] ${name} disabled for ${scope} for now: ${error}`);
}

// Telegram returns 429 with `parameters.retry_after` (seconds)
function retryAfterMs(err) {
    const seconds = err?.response?.parameters?.retry_after ?? err?.parameters?.retry_after;
    return seconds ? seconds * 1000 : 0;
}

const isNotModified = err => /message is not modified/i.test(err?.response?.description || err?.description || err?.message || '');
// Errors that mean "this request/feature is not accepted" (not network problems)
const isRejection = err => [400, 403, 404].includes(err?.response?.error_code) && !isNotModified(err);

/**
 * @param {object}   params
 * @param {object}   params.telegram              telegraf Telegram instance
 * @param {number}   params.chatId
 * @param {string}   [params.businessConnectionId] send on behalf of the business account
 * @param {string}   params.prefix                 classic HTML header shown ABOVE the reply
 * @param {string}   [params.richPrefix]           rich HTML header (used with `rich`)
 * @param {AsyncIterable<string>} params.chunks    text chunks from the model
 * @param {number}   [params.replyTo]              message id to reply to
 * @param {(html: string) => string} [params.decorate] optional HTML transform (premium emoji)
 * @param {boolean}  [params.rich]                 try rich messages
 * @param {boolean}  [params.draft]                try streaming with message drafts
 * @param {string}   [params.ownerName]            name used in the error / empty notices
 * @param {string}   [params.scope]                key for remembering rejected features ("bot" / "ns:<id>")
 * @returns {Promise<{ text: string, failed: boolean, messageId: number }>} final plain text of the reply
 */
async function renderStream({ telegram, chatId, businessConnectionId, prefix, richPrefix, chunks, replyTo, decorate, rich, draft, ownerName = config.ownerName, scope = 'bot' }) {
    const state = {
        style: decorate || identity,
        rich: Boolean(rich && richPrefix && usable('rich', scope)),
        // Drafts are for the bot's own private chat only, never for business chats
        draft: Boolean(draft && !businessConnectionId && usable('draft', scope))
    };
    const target = {
        chat_id: chatId,
        ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {})
    };
    const replyParameters = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};

    // ---------- Content ----------

    // body: AI text so far; mode: 'placeholder' | 'stream' | 'final'
    function content(body, mode, notice = '', asRich = state.rich) {
        if (asRich) {
            let html;
            if (mode === 'placeholder') {
                html = richPrefix + (state.draft ? texts.ai_thinking_rich : texts.ai_typing_placeholder_rich);
            } else {
                const source = body.length > MAX_RICH_SOURCE ? `${body.slice(0, MAX_RICH_SOURCE)}…` : body;
                html = richPrefix + markdownToRich(mode === 'stream' ? source + texts.ai_stream_cursor : source);
                if (notice) html += `<p>${notice}</p>`;
            }
            return { rich_message: { html: state.style(html) } };
        }
        let html;
        if (mode === 'placeholder') html = prefix + texts.ai_typing_placeholder;
        else if (!body) html = prefix + notice;
        else {
            html = fitMessage(prefix, body, mode === 'stream' ? texts.ai_stream_cursor : '');
            if (notice && html.length + notice.length + 2 <= 4096) html += `\n\n${notice}`;
        }
        return { text: state.style(html), parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    }

    // Runs a request; on rejection drops premium emoji first, then the rich format, and retries
    async function degrade(request) {
        for (;;) {
            try {
                return await request();
            } catch (err) {
                if (!isRejection(err)) throw err;
                if (state.style !== identity) {
                    state.style = identity;
                    continue;
                }
                if (state.rich) {
                    reject('rich', scope, err);
                    state.rich = false;
                    continue;
                }
                throw err;
            }
        }
    }

    // ---------- Requests ----------

    const sendMessage = (body, mode, notice) => degrade(() => {
        const payload = content(body, mode, notice);
        const method = payload.rich_message ? 'sendRichMessage' : 'sendMessage';
        return callApiRetry(telegram, method, markRaw({ ...target, ...payload, ...replyParameters }));
    });

    const draftId = 1 + Math.floor(Math.random() * 2_000_000_000);
    // A rejected draft says nothing about rich messages in general, so draft
    // failures never disable the rich format: they fall back to a plain draft
    // once and then turn drafts off (handled by the caller).
    let richDraft = state.rich;
    async function sendDraft(body, mode) {
        const call = asRich => {
            const payload = content(body, mode, '', asRich);
            const method = asRich ? 'sendRichMessageDraft' : 'sendMessageDraft';
            return callApiRetry(telegram, method, markRaw({ ...target, draft_id: draftId, ...payload }));
        };
        if (!richDraft) return call(false);
        try {
            return await call(true);
        } catch (err) {
            if (!isRejection(err)) throw err;
            richDraft = false;
            return call(false);
        }
    }

    let sent = null;
    let lastRendered = '';
    let pausedUntil = 0;

    async function update(body, mode, notice = '') {
        const key = JSON.stringify([state.rich, state.draft, body, mode, notice]);
        if (key === lastRendered) return;
        try {
            if (state.draft) await sendDraft(body, mode);
            else await degrade(() => callApiRetry(telegram, 'editMessageText', markRaw({
                ...target, message_id: sent.message_id, ...content(body, mode, notice)
            })));
            lastRendered = key;
        } catch (err) {
            if (isNotModified(err)) {
                lastRendered = key;
                return;
            }
            const wait = retryAfterMs(err);
            if (wait) {
                pausedUntil = Date.now() + wait;
                return;
            }
            if (state.draft && isRejection(err)) {
                // Drafts don't work here: continue with a normal message that gets edited
                reject('draft', scope, err);
                state.draft = false;
                sent = await sendMessage(body, mode, notice);
                return;
            }
            throw err;
        }
    }

    // ---------- Start ----------

    if (state.draft) {
        try {
            await sendDraft('', 'placeholder');
        } catch (err) {
            if (!isRejection(err)) throw err;
            reject('draft', scope, err);
            state.draft = false;
        }
    }
    if (!state.draft) sent = await sendMessage('', 'placeholder');

    let buffer = '';
    let inFlight = null;

    // Periodic updates while tokens are coming in. Skips a tick if the previous
    // update is still running or Telegram asked us to slow down.
    const ticker = setInterval(() => {
        if (inFlight || !buffer.trim() || Date.now() < pausedUntil) return;
        inFlight = update(buffer.trim(), 'stream')
            .catch(() => {})
            .finally(() => { inFlight = null; });
    }, config.streamIntervalMs);

    let failed = false;
    try {
        for await (const chunk of chunks) buffer += chunk;
    } catch (err) {
        failed = true;
        logger.error('openai stream', err);
    } finally {
        clearInterval(ticker);
        if (inFlight) await inFlight;
    }

    // ---------- Final ----------

    const text = buffer.trim();
    const notice = failed || !text ? fill(failed ? texts.ai_error : texts.ai_empty, { ownerName: escapeHtml(ownerName) }) : '';

    // Draft mode: the real message is sent now (Telegram replaces the draft with it)
    if (state.draft || !sent) {
        sent = await sendMessage(text, 'final', notice);
        return { text, failed, messageId: sent.message_id };
    }

    // Edit mode: retry on rate limits / transient errors until the final text is shown
    const finalKey = () => JSON.stringify([state.rich, state.draft, text, 'final', notice]);
    for (let attempt = 0; attempt < 5 && lastRendered !== finalKey(); attempt++) {
        const wait = pausedUntil - Date.now();
        if (wait > 0) await sleep(wait);
        try {
            await update(text, 'final', notice);
        } catch (err) {
            if (attempt === 4) throw err;
            await sleep(1000);
        }
    }

    return { text, failed, messageId: sent.message_id };
}

// For the panel: features Telegram rejected recently in the given scopes
function capabilityStatus(scopes) {
    const now = Date.now();
    const result = [];
    for (const [key, value] of capability) {
        const [name, scope] = key.split('|');
        if (scopes.includes(scope) && now < value.until) result.push({ name, scope, error: value.error });
    }
    return result;
}

module.exports = { renderStream, capabilityStatus };
