// ------------------------------
// digest.js - AI calls that turn raw chat messages into
//   1) topics ("recent dialogs") and
//   2) the AI's own long-term notes about a chat (auto memory).
// ------------------------------

const config = require('../../config/config');
const { client, extraParams, stripThink } = require('./openai');
const { formatDateTime } = require('../utils/time');

const MAX_MEMORY_LENGTH = 2000;

const TOPICS_PROMPT = `
You organize a Telegram chat into conversation topics.
A topic is one subject: a project, a plan, a question, a problem, small talk...
People switch topics and come back later - a message that continues an EXISTING topic
must reuse that topic's id, even if other topics were discussed in between.

Return JSON only:
{"topics":[{"id": <existing topic id or null for a new topic>,
            "title": "2-5 words",
            "summary": "1-2 sentences about the WHOLE topic (merge with its previous summary)",
            "messages": [message numbers]}]}

Rules:
- Every message number belongs to exactly one topic.
- Greetings and chit-chat go to a topic like "Small talk".
- Write titles and summaries in the language of the chat.
`.trim();

const MEMORY_PROMPT = `
You keep compact long-term notes about one Telegram chat between {ownerName} and {contact}.
These notes help an assistant answer later without reading the whole chat.

Update the CURRENT NOTES with the NEW MESSAGES:
- who {contact} is, relationship to {ownerName}, how they talk (language, tone);
- ongoing projects, plans, agreements, promises, important dates, open questions;
- preferences, inside jokes, things to avoid.
Remove what is outdated or resolved, skip trivia. Keep it under 150 words, short bullet points,
in the language of the chat. Return ONLY the updated notes, no introduction.
`.trim();

// "[3] 09.10 14:03 Dima: text"
function formatMessages(rows, contact, ownerName) {
    // The bot's replies must never be attributed to the owner
    const names = { them: contact, owner: `${ownerName} (personally)`, ai: 'AI assistant (bot)' };
    return rows
        .map((row, i) => `[${i + 1}] ${formatDateTime(row.sent_at)} ${names[row.role]}: ${row.summary.replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n');
}

async function complete(messages, { json = false } = {}) {
    const request = jsonMode => client.chat.completions.create({
        model: config.model,
        messages,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...extraParams()
    }, { timeout: 180_000, maxRetries: 1 });

    let response;
    try {
        response = await request(json);
    } catch (err) {
        // Some OpenAI-compatible servers don't support response_format
        if (!json || err?.status !== 400) throw err;
        response = await request(false);
    }
    return stripThink(response.choices?.[0]?.message?.content || '');
}

function parseJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('the model did not return JSON');
    return JSON.parse(text.slice(start, end + 1));
}

/**
 * Splits new messages into topics.
 * @param {object[]} existing  [{ id, title, summary }] recent topics of this chat
 * @param {object[]} rows      archive rows (chronological)
 * @param {string}   contact   name of the other person
 * @returns {Promise<{ id: number|null, title: string, summary: string, rows: object[] }[]>}
 */
async function segmentTopics({ existing, rows, contact, ownerName }) {
    const known = existing.length
        ? existing.map(t => `id ${t.id}: ${t.title} — ${t.summary || ''}`).join('\n')
        : '(none)';
    const answer = await complete([
        { role: 'system', content: TOPICS_PROMPT },
        { role: 'user', content: `EXISTING TOPICS:\n${known}\n\nNEW MESSAGES:\n${formatMessages(rows, contact, ownerName)}` }
    ], { json: true });

    let parsed;
    try {
        parsed = parseJson(answer);
    } catch {
        parsed = { topics: [] };
    }

    const knownIds = new Set(existing.map(t => t.id));
    const owner = new Array(rows.length).fill(-1); // message index -> topic index
    const topics = [];
    for (const raw of Array.isArray(parsed.topics) ? parsed.topics : []) {
        const numbers = (Array.isArray(raw.messages) ? raw.messages : [])
            .map(Number)
            .filter(n => Number.isInteger(n) && n >= 1 && n <= rows.length && owner[n - 1] === -1);
        if (numbers.length === 0) continue;
        const index = topics.length;
        numbers.forEach(n => { owner[n - 1] = index; });
        topics.push({
            id: knownIds.has(Number(raw.id)) ? Number(raw.id) : null,
            title: String(raw.title || '').trim().slice(0, 60) || 'Conversation',
            summary: String(raw.summary || '').trim().slice(0, 400),
            rows: []
        });
    }

    // Messages the model forgot -> same topic as the previous message (or a catch-all)
    let last = -1;
    owner.forEach((topicIndex, i) => {
        let target = topicIndex !== -1 ? topicIndex : last;
        if (target === -1) {
            target = topics.length;
            topics.push({ id: null, title: 'Conversation', summary: '', rows: [] });
        }
        topics[target].rows.push(rows[i]);
        last = target;
    });

    return topics.filter(topic => topic.rows.length > 0);
}

/**
 * Folds new messages into the AI's notes about the chat.
 * @returns {Promise<string>} updated notes
 */
async function updateMemory({ memory, rows, contact, ownerName }) {
    const system = MEMORY_PROMPT
        .replace(/\{ownerName\}/g, ownerName)
        .replace(/\{contact\}/g, contact);
    const answer = await complete([
        { role: 'system', content: system },
        { role: 'user', content: `CURRENT NOTES:\n${memory || '(empty)'}\n\nNEW MESSAGES:\n${formatMessages(rows, contact, ownerName)}` }
    ]);
    const notes = answer.replace(/^```\w*\n?|```$/g, '').trim();
    // An empty answer must not wipe existing notes
    return (notes || memory || '').slice(0, MAX_MEMORY_LENGTH);
}

module.exports = { segmentTopics, updateMemory };
