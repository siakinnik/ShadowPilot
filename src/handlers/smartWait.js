// ------------------------------
// smartWait.js - per-chat debounce queue.
//
// People often split one thought into several messages ("hi" ... "are you free tomorrow?").
// Instead of answering each message, the bot:
//   1. waits `debounceMs` after the LAST message (every new message restarts the timer);
//   2. looks at the collected batch and decides: REPLY now or WAIT a bit more
//      (cheap heuristics first, the AI judge only for ambiguous cases);
//   3. after at most `maxExtraWaits` extra waits it answers anyway.
// ------------------------------

const logger = require('../utils/logger');

// Only a greeting -> the real question is usually coming next
const GREETING_RE = /^(hi|hello|hey|yo|hallo|servus|moin|salut|hola|ciao|привет(ик)?|прив|здравствуй(те)?|здарова|здорово|хай|ку|добрый\s+(день|вечер|утро)|доброе\s+утро|доброй\s+ночи|салам|алло|слушай|смотри)[\s!.,)👋🙂😊]*$/i;
// Message ends like an unfinished sentence
const UNFINISHED_RE = /([,:\-–—(]|\.\.\.|…)\s*$/;

/**
 * Fast local decision, no API call.
 * @returns {'reply'|'wait'|'unsure'}
 */
function heuristicDecision(texts, extraWaits) {
    const last = (texts[texts.length - 1] || '').trim();
    const joined = texts.join(' ').trim();

    if (!last) return 'reply'; // media-only messages
    if (texts.length === 1 && GREETING_RE.test(last)) {
        // First time: give them a chance to write the actual question
        return extraWaits === 0 ? 'wait' : 'reply';
    }
    if (UNFINISHED_RE.test(last)) return 'wait';
    if (/[?？]\s*$/.test(last)) return 'reply';
    if (joined.length >= 120) return 'reply';
    return 'unsure';
}

class SmartWaitQueue {
    /**
     * @param {object}   options
     * @param {(key: string, batch: any[]) => Promise<void>} options.onFlush  called with the collected batch
     * @param {(key: string, batch: any[]) => Promise<'reply'|'wait'>} options.judge  AI judge for ambiguous cases
     * @param {(key: string) => object} options.getSettings  returns smartWait settings of a chat
     */
    constructor({ onFlush, judge, getSettings }) {
        this.onFlush = onFlush;
        this.judge = judge;
        this.getSettings = getSettings;
        this.chats = new Map(); // key -> { items, timer, extraWaits, busy }
    }

    // Adds a message to the chat batch and (re)starts the debounce timer
    push(key, item) {
        const settings = this.getSettings(key);
        let state = this.chats.get(key);
        if (!state) {
            state = { items: [], timer: null, extraWaits: 0, busy: false };
            this.chats.set(key, state);
        }
        state.items.push(item);

        // A reply is being generated right now -> the new message is handled right after it
        if (state.busy) return;

        clearTimeout(state.timer);
        const delay = settings.enabled ? settings.debounceMs : 0;
        state.timer = setTimeout(() => this.fire(key), delay);
    }

    // Drops pending messages of a chat (e.g. the owner answered personally)
    cancel(key) {
        const state = this.chats.get(key);
        if (!state) return;
        clearTimeout(state.timer);
        state.items = [];
        state.extraWaits = 0;
        if (!state.busy) this.chats.delete(key);
    }

    async fire(key) {
        const state = this.chats.get(key);
        if (!state || state.busy || state.items.length === 0) return;
        state.timer = null;

        const settings = this.getSettings(key);
        if (settings.enabled && state.extraWaits < settings.maxExtraWaits) {
            const texts = state.items.map(item => item.text || '');
            let decision = heuristicDecision(texts, state.extraWaits);
            if (decision === 'unsure') {
                decision = await this.judge(key, state.items).catch(() => 'reply');
                // New messages arrived while the judge was thinking -> their timer decides
                if (state.timer || state.items.length !== texts.length) return;
            }
            if (decision === 'wait') {
                state.extraWaits++;
                state.timer = setTimeout(() => this.fire(key), settings.extraWaitMs);
                return;
            }
        }

        const batch = state.items;
        state.items = [];
        state.extraWaits = 0;
        state.busy = true;
        try {
            await this.onFlush(key, batch);
        } catch (err) {
            logger.error('smartWait flush', err);
        } finally {
            state.busy = false;
            if (state.items.length > 0) {
                // Messages that came in during generation -> start a fresh debounce cycle
                const delay = settings.enabled ? settings.debounceMs : 0;
                state.timer = setTimeout(() => this.fire(key), delay);
            } else {
                this.chats.delete(key);
            }
        }
    }
}

module.exports = { SmartWaitQueue, heuristicDecision };
