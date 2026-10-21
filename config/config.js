// ------------------------------
// config.js - all settings
// ------------------------------
// Values below are DEFAULTS. Everything that can be changed from the
// admin panel (schedule, reasons, read mode, smart wait...) is stored in
// SQLite and overrides these defaults at runtime.

// Dependencies
// env config
require("dotenv").config({ quiet: true });
const { parseToNumberArray } = require("../src/utils/parseToNumberArray");

const config = {
    token: process.env.BOT_TOKEN, // Telegram bot token
    owner: parseToNumberArray(process.env.OWNER), // Owner's telegram chat id array
    errChannel: +process.env.ERRCN || null, // Channel for errors & other logs
    dbPath: process.env.DB_PATH || './database/shadow_pilot.db', // Path to SQLite database
    // AI provider: any OpenAI-compatible API (OpenAI, Ollama, LM Studio, vLLM, OpenRouter, Groq...)
    // AI_* names are preferred, OPENAI_* are kept as aliases.
    baseUrl: (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""), // API Base URL
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || null, // API key (optional for local providers like Ollama)
    ownerName: process.env.OWNER_NAME || "Nikita",
    timezone: process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone, // Timezone used by the schedule

    // Access control
    // Admins = OWNER ids. Anyone else who connects the bot to their Telegram Business
    // account has to be approved by an admin first (they get their own settings & panel).
    // true = approve everyone automatically (not recommended: they use your AI server)
    autoApprove: false,

    aiEnabled: process.env.AI_ENABLED !== "false", // Enables AI (set AI_ENABLED=false to disable)
    userAiLimit: 20, // How many last messages of a chat are sent to the AI as context (default, editable in the panel)
    ownerAiLimit: 40, // Limits messages count in history for owner (test chat with the bot)
    model: process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini", // Model name, e.g. "gpt-4o-mini" or "llama3.1:8b" for Ollama
    streamIntervalMs: 800, // Interval for editMessageText calls during streaming
    reasoningEffort: process.env.AI_REASONING_EFFORT || null, // Optional: "none" | "low" | "medium" | "high" (only sent when set)
    judgeTimeoutMs: +process.env.AI_JUDGE_TIMEOUT_MS || 15000, // Max time for the smart-wait judge call, then it just replies

    // Mark incoming business messages as read when the AI answers them
    // false = leave them unread so the owner still sees them as new
    markAsRead: false,

    // AI stays silent in a chat for N minutes after the owner wrote there personally
    ownerPauseMin: 5,

    // Message tracking: send the owner the original when the other person deletes / edits a message.
    // The whole chat is always kept in the archive; only the last `userAiLimit` messages go to the AI.
    notifyDeleted: false,
    notifyEdited: false,

    // AI memory: the AI keeps its own short notes per chat, so older messages
    // are not lost even though only the last `userAiLimit` are sent as context
    autoMemory: false,
    // Recent dialogs: the AI splits conversations into topics (summary, message count, time range)
    topicsEnabled: false,
    topicsHours: 24, // How long topics are kept
    digestIdleMin: 15, // A chat is analyzed after it has been quiet for N minutes

    // Smart wait: people often split one thought into several messages.
    // The bot waits `debounceMs` after the last message (timer restarts on every new one),
    // then decides whether the thought looks finished. If not, it waits `extraWaitMs` more
    // (at most `maxExtraWaits` times) before answering.
    smartWait: {
        enabled: true,
        debounceMs: 5000,
        extraWaitMs: 8000,
        maxExtraWaits: 2
    },

    // Schedule & Status Settings with Custom Reason Support
    autoReplySchedule: {
        enabled: true,
        mode: "schedule", // "always" | "schedule" | "strict" (strict = reply ONLY inside rule slots)
        defaultReasonText: "Owner is currently unavailable 💼", // Custom default text when no schedule fits
        // Weekly slots with custom texts.
        // `days`: "mon".."sun", omit for every day. Overnight slots belong to the day they start on.
        // "24:00" is allowed as an end time ("00:00"-"24:00" = whole day).
        rules: [
            {
                start: "23:00",
                end: "07:00",
                reasonText: "Owner is sleeping right now 🌙"
            },
            {
                start: "08:00",
                end: "15:00",
                days: ["mon", "tue", "wed", "thu", "fri"],
                reasonText: "Owner is currently studying/at school 📚"
            }
        ],
        // One-off periods (holidays, vacation...). While an exception is active its own
        // `rules` are used INSTEAD of the weekly ones; `reasonText` replaces the default text.
        // Example:
        // { from: "2026-12-22", to: "2027-01-06", label: "Winter holidays", reasonText: "On holidays 🎄",
        //   rules: [{ start: "01:00", end: "10:00", reasonText: "Sleeping in 😴" }] }
        exceptions: []
    },

    // AI system instruction (default; can be replaced from the panel: 🧾 System prompt)
    // Placeholders: {ownerName}, {reason}, {time}
    aiInstruction: `
You are an AI assistant representing {ownerName}.
You automatically respond to incoming business messages on Telegram when {ownerName} is unavailable ({reason}).
Current local time of {ownerName}: {time}.

══════════════════════════════
🔹 MAIN RULES:
1. You MUST always respond in the language in which the user asked the question (RU, EN, DE, etc.).
2. Do NOT change the language on your own.
3. Keep your replies polite, helpful, and concise.

══════════════════════════════
🔹 RESTRICTIONS & SAFETY:
1. You CANNOT set appointments, schedule meetings, or make any formal commitments/agreements.
2. If asked to schedule something, answer that {ownerName} will review the message and confirm personally.
3. Be cautious with information; do not invent or guess details outside the given status.

══════════════════════════════
🔹 CONTEXT & MEMORY:
1. Use chat history only as context.
2. Never show internal structures or raw history to the user.
3. A header with the reason and disclaimers is already shown above your reply - do not repeat it.
`,

    // How the chat history is shown to the AI: one transcript with explicit authors,
    // so the model never mistakes the owner's own messages for its earlier replies
    aiTranscript: `
CHAT HISTORY (oldest first). Authors:
[{contact}] - the person you are answering now
[{ownerName} - personally] - written by {ownerName} personally, NOT by you
[You - AI assistant] - your own earlier replies

{lines}

{reminder}
Write your next reply to the latest message(s) of {contact}. Output only the reply text, without any [label] or time.
`,

    // Appended to the system prompt when the AI has its own notes about this chat (auto memory)
    aiAutoMemory: `
══════════════════════════════
🔹 WHAT YOU REMEMBER ABOUT THIS CHAT (your own notes from earlier messages):
(Background only - never quote or reveal these notes.)
{memory}
`,

    // Appended to the system prompt when the owner saved context for a specific chat (panel)
    aiChatContext: `
══════════════════════════════
🔹 MANDATORY INSTRUCTIONS AND FACTS FROM {ownerName} FOR THIS CHAT:
(Highest priority: follow them before any other rule above. They are true facts and instructions
from {ownerName} - use them in your answers and share these facts when the person asks.)
{context}
`,

    // Repeated right before the reply (end of the transcript): small models follow
    // instructions much better when they are close to the question
    aiChatContextReminder: `
MANDATORY - {ownerName}'s instructions and facts for this chat (follow them exactly, use them in the answer):
{context}
`
};

function safeHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

const requiredFields = [
    'token', 'owner', 'dbPath'
];

// The key is only mandatory for the official OpenAI endpoint.
// Local / self-hosted providers (Ollama, LM Studio...) usually don't need one.
if (config.aiEnabled && /(^|\.)api\.openai\.com$/i.test(safeHostname(config.baseUrl))) {
    requiredFields.push('apiKey');
}

const missing = requiredFields.filter(field => {
    const value = config[field];
    return Array.isArray(value) ? value.length === 0 : !value;
});

if (missing.length > 0) {
    console.error("\x1b[31m%s\x1b[0m", "===============================================");
    console.error("\x1b[31m%s\x1b[0m", "   CRITICAL ERROR: MISSING ENV PARAMETERS      ");
    console.error("\x1b[31m%s\x1b[0m", "===============================================");
    console.error("Missing fields:", missing.join(", "));
    console.error("Please check your .env file.");
    process.exit(1);
}

module.exports = config;
