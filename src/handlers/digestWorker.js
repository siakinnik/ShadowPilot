// ------------------------------
// digestWorker.js - background job that keeps topics and AI memory up to date.
//
// Every minute it looks for chats with archived messages that were not processed yet.
// A chat is processed when it has been quiet for `digestIdleMin` minutes (so a live
// conversation is not cut in the middle) or when a big backlog piled up.
// Turning a feature on for the first time simply means "everything is backlog",
// so existing chats get analyzed from the database automatically.
// "Re-analyze" resets the pointers of a chat and processes its whole history again.
// ------------------------------

const config = require('../../config/config');
const texts = require('../../config/texts.json');
const archive = require('../db/archive');
const chats = require('../db/chats');
const topics = require('../db/topics');
const { getSettings } = require('../db/settings');
const { canUse } = require('../db/members');
const { segmentTopics, updateMemory } = require('../ai/digest');
const { escapeHtml, fill } = require('../utils/text');
const logger = require('../utils/logger');

const TICK_MS = 60_000;
const TOPIC_CHUNK = 40;   // messages per topic-segmentation call
const MEMORY_CHUNK = 60;  // messages per memory-update call
const MAX_FAILURES = 3;   // after that a broken chunk is skipped instead of retried forever

const failures = new Map(); // `${chatId}:${kind}` -> count
let running = false;

const now = () => Math.floor(Date.now() / 1000);
const contactName = chat => chat.first_name || (chat.username ? `@${chat.username}` : String(chat.chat_id));

// Should the backlog be processed now? Returns how many messages to take (0 = wait)
function takeCount(info, { force, idleMin, chunk }) {
    if (!info || info.n === 0) return 0;
    const idle = now() - info.last_at >= idleMin * 60;
    if (force || idle) return Math.min(info.n, chunk);
    // Still talking: only cut full chunks out of a large backlog
    return info.n >= chunk ? chunk : 0;
}

async function withFailureGuard(chat, kind, rows, setPointer, work) {
    const key = `${chat.id}:${kind}`;
    try {
        await work();
        failures.delete(key);
        return true;
    } catch (err) {
        const count = (failures.get(key) || 0) + 1;
        failures.set(key, count);
        logger.error(`digest ${kind} for chat ${chat.id} (attempt ${count})`, err);
        if (count >= MAX_FAILURES) {
            setPointer(rows[rows.length - 1].id);
            failures.delete(key);
        }
        return false;
    }
}

async function processTopics(chat, settings, force) {
    let until = chat.topics_until;
    const cutoff = now() - settings.topicsHours * 3600;
    let processed = 0;

    for (;;) {
        const n = takeCount(archive.pendingInfo(chat.chat_key, until), { force, idleMin: config.digestIdleMin, chunk: TOPIC_CHUNK });
        if (n === 0) break;
        const rows = archive.messagesAfter(chat.chat_key, until, n);
        const setPointer = id => { until = id; chats.setTopicsUntil(chat.id, id); };

        // Topics older than the retention window would be purged right away - skip the AI call
        const fresh = rows.filter(row => row.sent_at >= cutoff);
        if (fresh.length === 0) {
            setPointer(rows[rows.length - 1].id);
            continue;
        }

        const ok = await withFailureGuard(chat, 'topics', rows, setPointer, async () => {
            const existing = topics.chatTopics(chat.chat_key, settings.topicsHours, 10);
            const segments = await segmentTopics({ existing, rows: fresh, contact: contactName(chat), ownerName: settings.ownerName });
            for (const segment of segments) {
                topics.upsertTopic({
                    id: segment.id,
                    chatKey: chat.chat_key,
                    title: segment.title,
                    summary: segment.summary,
                    messageCount: segment.rows.length,
                    firstAt: Math.min(...segment.rows.map(r => r.sent_at)),
                    lastAt: Math.max(...segment.rows.map(r => r.sent_at))
                });
            }
            setPointer(rows[rows.length - 1].id);
            processed += rows.length;
        });
        if (!ok) break;
    }
    return processed;
}

async function processMemory(chat, settings, force) {
    let until = chat.memory_until;
    let memory = chat.ai_memory;
    let processed = 0;

    for (;;) {
        const n = takeCount(archive.pendingInfo(chat.chat_key, until), { force, idleMin: config.digestIdleMin, chunk: MEMORY_CHUNK });
        if (n === 0) break;
        const rows = archive.messagesAfter(chat.chat_key, until, n);
        const setPointer = id => { until = id; chats.setMemoryUntil(chat.id, id); };

        const ok = await withFailureGuard(chat, 'memory', rows, setPointer, async () => {
            memory = await updateMemory({ memory, rows, contact: contactName(chat), ownerName: settings.ownerName });
            chats.setAiMemory(chat.id, memory);
            setPointer(rows[rows.length - 1].id);
            processed += rows.length;
        });
        if (!ok) break;
    }
    return processed;
}

async function tick(telegram) {
    if (running) return;
    running = true;
    try {
        const all = chats.allChats();
        // Every namespace keeps topics as long as its own setting says
        for (const ns of new Set(all.map(chat => chat.owner_user_id))) {
            topics.purgeTopics(ns, getSettings(ns).topicsHours);
        }

        for (const chat of all) {
            const ns = chat.owner_user_id;
            if (!canUse(ns)) continue;
            const settings = getSettings(ns);
            if (!settings.aiEnabled) continue;
            const force = Boolean(chat.reanalyze_by);
            const doTopics = settings.topicsEnabled || force;
            const doMemory = settings.autoMemory || force;
            if (!doTopics && !doMemory) continue;

            const memoryCount = doMemory ? await processMemory(chat, settings, force) : 0;
            if (doTopics) await processTopics(chat, settings, force);

            if (force) {
                const fresh = chats.getChat(chat.id);
                const left = archive.pendingInfo(chat.chat_key, Math.min(fresh.memory_until, fresh.topics_until));
                if (left.n > 0) continue; // a chunk failed - try again next tick
                chats.finishReanalysis(chat.id);
                await telegram.callApi('sendMessage', {
                    chat_id: chat.reanalyze_by,
                    parse_mode: 'HTML',
                    text: fill(texts.panel.reanalyze_done, {
                        title: escapeHtml(chats.chatTitle(chat)),
                        count: memoryCount,
                        topics: topics.chatTopics(chat.chat_key, settings.topicsHours, 100).length
                    })
                }).catch(err => logger.error('reanalysis report', err));
            }
        }
    } catch (err) {
        logger.error('digest worker', err);
    } finally {
        running = false;
    }
}

function startDigestWorker(telegram) {
    const loop = () => tick(telegram).finally(() => setTimeout(loop, TICK_MS));
    setTimeout(loop, 20_000);
}

// Lets the panel trigger a run right away (e.g. after "Re-analyze")
const runDigestNow = telegram => tick(telegram);

module.exports = { startDigestWorker, runDigestNow };
