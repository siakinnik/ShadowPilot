// ------------------------------
// openai.js - OpenAI API client (streaming replies + turn judge)
// ------------------------------

const OpenAI = require('openai');
const config = require('../../config/config');
const { fill } = require('../utils/text');

// The SDK refuses to start without a key, so keyless providers (Ollama...) get a placeholder
const client = new OpenAI({
    apiKey: config.apiKey || 'not-needed',
    baseURL: config.baseUrl
});

// Builds the system prompt with the current reason, time and optional per-chat notes.
// `instruction` = custom prompt of the namespace (panel) or null for the default from config.js
function buildSystemPrompt({ reason, time, chatContext, aiMemory, instruction, ownerName }) {
    let prompt = fill(instruction || config.aiInstruction, {
        ownerName,
        reason,
        time
    }).trim();
    if (aiMemory) {
        prompt += '\n' + fill(config.aiAutoMemory, { memory: aiMemory }).trimEnd();
    }
    if (chatContext) {
        prompt += '\n' + fill(config.aiChatContext, { ownerName, context: chatContext }).trimEnd();
    }
    return prompt;
}

// Extra request params for the provider (only sent when configured,
// strict APIs like OpenAI reject unknown fields)
function extraParams() {
    return config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {};
}

// Some local "thinking" models (Qwen, DeepSeek-R1...) stream their reasoning inline
// as <think>...</think>. This filter removes it from a stream of chunks,
// even when a tag is split between two chunks.
function createThinkFilter() {
    let inside = false;
    let carry = '';
    return function push(chunk, flush = false) {
        let text = carry + chunk;
        carry = '';
        let out = '';
        while (text) {
            const tag = inside ? '</think>' : '<think>';
            const index = text.indexOf(tag);
            if (index !== -1) {
                if (!inside) out += text.slice(0, index);
                text = text.slice(index + tag.length);
                inside = !inside;
                continue;
            }
            // Keep a possible partial tag ("<thi") for the next chunk
            const keep = flush ? 0 : partialTagLength(text, tag);
            if (!inside) out += text.slice(0, text.length - keep);
            carry = keep ? text.slice(-keep) : '';
            break;
        }
        return out;
    };
}

function partialTagLength(text, tag) {
    for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
        if (tag.startsWith(text.slice(-len))) return len;
    }
    return 0;
}

const stripThink = text => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/**
 * Streams a chat completion. Yields text chunks as they arrive (SSE under the hood).
 * @param {{ system: string, history: {role: string, content: string}[], signal?: AbortSignal }} params
 */
async function* streamReply({ system, history, signal }) {
    const stream = await client.chat.completions.create({
        model: config.model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...history],
        ...extraParams()
    }, { signal });

    const filter = createThinkFilter();
    for await (const chunk of stream) {
        // Separate reasoning fields (delta.reasoning / reasoning_content) are ignored on purpose
        const delta = chunk.choices?.[0]?.delta?.content;
        if (!delta) continue;
        const visible = filter(delta);
        if (visible) yield visible;
    }
    const rest = filter('', true);
    if (rest) yield rest;
}

const JUDGE_PROMPT = `
You watch a Telegram chat. The person below sent one or more messages in a row.
Decide whether they have most likely FINISHED their thought, or are probably still going
to send more messages (e.g. only a greeting, an unfinished sentence, "one sec", "so...", a list being typed).

Answer with exactly one word:
REPLY - the thought looks complete, an answer makes sense now
WAIT  - they are probably still typing the rest of it
`.trim();

/**
 * Asks the model whether the pending messages form a complete thought.
 * Fails open: any error -> 'reply'.
 * @returns {Promise<'reply'|'wait'>}
 */
async function judgeTurn({ context, pending }) {
    const latest = pending.map(text => `> ${text}`).join('\n');

    try {
        const response = await client.chat.completions.create({
            model: config.model,
            messages: [
                { role: 'system', content: JUDGE_PROMPT },
                { role: 'user', content: `Earlier context:\n${context || '(none)'}\n\nNew messages:\n${latest}` }
            ],
            ...extraParams()
        }, { timeout: config.judgeTimeoutMs, maxRetries: 0 });

        const answer = stripThink(response.choices?.[0]?.message?.content || '');
        return /\bWAIT\b/i.test(answer) ? 'wait' : 'reply';
    } catch {
        return 'reply';
    }
}

module.exports = { client, extraParams, stripThink, buildSystemPrompt, streamReply, judgeTurn, createThinkFilter };
