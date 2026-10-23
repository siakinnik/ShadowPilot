// ------------------------------
// panel.js - control panel inside the bot's private chat.
// Works per namespace (= business account): admins can switch to any approved
// account, members only see their own. Admins also manage access requests.
// Inline keyboard UI: AI on/off, schedule slots with custom reasons,
// default reason, read/unread mode, smart wait, pause, memory cleanup,
// per-chat management (find by @username / id, clear history, custom AI context).
// Any other text from the owner = test chat with the AI (preview of replies).
// ------------------------------

const { AsyncLocalStorage } = require('async_hooks');
const config = require('../../config/config');
const texts = require('../../config/texts.json');
const memory = require('../ai/memory');
const { getSettings, updateSettings, resetSettings } = require('../db/settings');
const { countActiveConnections, hasPremiumConnection, connectionsOf } = require('../db/connections');
const members = require('../db/members');
const access = require('../handlers/access');
const { parsePairs } = require('../utils/premiumEmoji');
const chats = require('../db/chats');
const archive = require('../db/archive');
const topics = require('../db/topics');
const { runDigestNow } = require('../handlers/digestWorker');
const { formatRange, formatDateTime } = require('../utils/time');
const { DAYS, checkSchedule, getLocalTime, parseRange, resolveRuleText } = require('../utils/scheduleChecker');
const { daysLabel, ruleLine, exceptionBlock, diffSchedules } = require('../utils/scheduleFormat');
const { proposeSchedule } = require('../ai/scheduleEditor');
const { escapeHtml, fill } = require('../utils/text');
const { generateReply } = require('../handlers/business');
const { capabilityStatus } = require('../handlers/streamRenderer');
const logger = require('../utils/logger');

const T = texts.panel;
const MAX_REASON_LENGTH = 200;
const MAX_CONTEXT_LENGTH = 2000;
const MODES = ['always', 'schedule', 'strict'];
const DEBOUNCE_STEPS = [3000, 5000, 8000, 10000];
const PAUSE_STEPS = [0, 2, 5, 15, 30, 60];
const HISTORY_STEPS = [10, 20, 40, 80, 150];
const TOPIC_HOURS_STEPS = [6, 12, 24, 72, 168];
const PRESETS = Object.keys(texts.reasons);

// ownerId -> { action: 'add_rule'|'rule_time'|'rule_text'|'default_reason'|'pick_preset'|'find_chat'|'set_context'|'append_context', index?, draft?, chatId? }
const pendingInput = new Map();

const btn = (text, data) => ({ text, callback_data: `sp:${data}` });
const nextOf = (list, value) => list[(list.indexOf(value) + 1) % list.length];
const modeLabel = mode => T[`mode_${mode}`] || mode;
const onOff = value => (value ? T.on : T.off);
// Namespace (business account user id) the current panel action works on.
// Set per update with AsyncLocalStorage, so concurrent users never mix.
const nsStore = new AsyncLocalStorage();
const NS = () => nsStore.getStore().ns;
// Telegram user who is using the panel right now
const USER = () => nsStore.getStore().userId;
const isAdminUser = () => members.isAdmin(USER());
// adminId -> namespace the admin switched to (default: own account)
const activeNs = new Map();
const resolveNs = userId => (members.isAdmin(userId) && activeNs.get(userId)) || userId;
// Test chat history per user and namespace
const testKey = userId => `owner:${userId}:${NS()}`;
// Chat row only if it belongs to the current namespace
function ownChat(id) {
    const chat = chats.getChat(id);
    return chat && chat.owner_user_id === NS() ? chat : undefined;
}

// ---------- Views ----------

function mainView() {
    const s = getSettings(NS());
    const status = checkSchedule(s.schedule, config.timezone);
    const replying = s.aiEnabled && status.active;
    const connections = countActiveConnections(NS());

    const smartValue = s.smartWait.enabled
        ? `${T.on} · <b>${fill(T.seconds, { value: s.smartWait.debounceMs / 1000 })}</b>`
        : T.off;
    const pauseValue = s.ownerPauseMin > 0 ? fill(T.minutes, { value: s.ownerPauseMin }) : T.disabled;

    const foreign = NS() !== USER();
    const lines = [T.title];
    // Admin working in somebody else's account
    if (foreign) lines.push(fill(T.ns_other, { name: escapeHtml(members.memberTitle(members.getMember(NS()), NS())) }));
    lines.push(
        T.divider,
        fill(T.owner_name, { value: escapeHtml(s.ownerName) }),
        fill(T.ai, { value: onOff(s.aiEnabled) }),
        fill(T.mode, { value: s.schedule.enabled ? modeLabel(s.schedule.mode) : T.off }),
        fill(T.now, {
            timezone: escapeHtml(config.timezone),
            time: status.time,
            state: replying ? T.state_active : T.state_idle
        }),
        fill(T.reason, { value: escapeHtml(status.reason) }),
        fill(T.read, { value: s.markAsRead ? T.read_mark : T.read_leave }),
        fill(T.smart_wait, { value: smartValue }),
        fill(T.owner_pause, { value: pauseValue }),
        fill(T.connections, { value: connections }),
        T.divider,
        T.mode_help
    );
    if (connections === 0) lines.push(T.hint_no_connection);
    lines.push(T.hint_test);

    const keyboard = [];
    if (foreign) keyboard.push([btn(T.btn_ns_back, 'mnsme')]);
    if (isAdminUser()) {
        const pending = members.listMembers().filter(m => m.status === 'pending').length;
        keyboard.push([btn(pending ? fill(T.btn_members_pending, { count: pending }) : T.btn_members, 'mlist')]);
    }
    keyboard.push(
        [btn(fill(T.btn_owner_name, { value: s.ownerName }), 'oname')],
        [btn(fill(T.btn_ai, { value: onOff(s.aiEnabled) }), 'ai'), btn(fill(T.btn_mode, { value: modeLabel(s.schedule.mode) }), 'mode')],
        [btn(T.btn_rules, 'rules'), btn(T.btn_default_reason, 'def')],
        [btn(T.btn_chats, 'chats'), btn(T.btn_dialogs, 'dlg')],
        [btn(T.btn_memory, 'mem'), btn(T.btn_premium, 'pe')],
        [btn(T.btn_prompt, 'sys')],
        [btn(fill(T.btn_read, { value: s.markAsRead ? T.read_mark : T.read_leave }), 'read')],
        [
            btn(fill(T.btn_smart, { value: onOff(s.smartWait.enabled) }), 'smart'),
            btn(fill(T.btn_debounce, { value: fill(T.seconds, { value: s.smartWait.debounceMs / 1000 }) }), 'deb')
        ],
        [btn(fill(T.btn_pause, { value: pauseValue }), 'pause')],
        [btn(T.btn_clear, 'clear'), btn(T.btn_refresh, 'home')]
    );
    return { text: lines.join('\n'), keyboard };
}

// ---------- Accounts (admins only) ----------

const STATUS_ICON = { pending: '⏳', approved: '✅', rejected: '⛔️' };

function membersView() {
    const list = members.listMembers();
    const lines = [T.members_title, ''];
    if (list.length === 0) lines.push(T.members_empty);
    const keyboard = [];
    for (const member of list) {
        const icon = members.isAdmin(member.user_id) ? '👑' : STATUS_ICON[member.status];
        const active = activeNs.get(USER()) === member.user_id ? ' 🔀' : '';
        keyboard.push([btn(`${icon} ${members.memberTitle(member)}${active}`, `mbr:${member.user_id}`)]);
    }
    lines.push(T.members_help);
    keyboard.push([btn(T.btn_back, 'home')]);
    return { text: lines.join('\n'), keyboard };
}

function memberView(userId) {
    const member = members.getMember(userId);
    if (!member) return membersView();
    const admin = members.isAdmin(userId);
    const connections = connectionsOf(userId);
    const connLines = connections.map(c => fill(T.member_connection, {
        state: c.is_enabled ? '🟢' : '⚪️',
        canReply: c.can_reply ? '✅' : '❌',
        canRead: c.can_read ? '✅' : '❌',
        premium: c.is_premium ? '✅' : '❌'
    }));
    const text = fill(T.member_title, {
        name: escapeHtml(members.memberTitle(member)),
        id: member.user_id,
        status: admin ? T.member_status_admin : T[`member_status_${member.status}`],
        chats: chats.countChats(userId),
        since: member.created_at,
        connections: connLines.join('\n') || T.member_no_connections
    });

    const keyboard = [];
    if (!admin) {
        if (member.status !== 'approved') keyboard.push([btn(T.btn_approve, `mapp:${userId}`)]);
        if (member.status === 'approved') keyboard.push([btn(T.btn_revoke, `mrej:${userId}`)]);
        if (member.status === 'pending') keyboard.push([btn(T.btn_reject, `mrej:${userId}`)]);
    }
    if (admin || member.status === 'approved') {
        const isCurrent = (activeNs.get(USER()) || USER()) === Number(userId);
        if (!isCurrent) keyboard.push([btn(T.btn_ns_switch, `mns:${userId}`)]);
    }
    if (!admin) keyboard.push([btn(T.btn_member_delete, `mdel:${userId}`)]);
    keyboard.push([btn(T.btn_back, 'mlist')]);
    return { text, keyboard };
}

function rulesView() {
    const s = getSettings(NS());
    const status = checkSchedule(s.schedule, config.timezone);
    const { rules, exceptions = [] } = s.schedule;
    const today = getLocalTime(config.timezone).date;

    const lines = [fill(T.rules_title, { timezone: escapeHtml(config.timezone) }), ''];
    if (rules.length === 0) lines.push(T.rules_empty);
    rules.forEach((rule, i) => {
        const active = status.ruleIndex === i ? ` ${T.rule_active_mark}` : '';
        lines.push(`${i + 1}. ${ruleLine(rule, s.schedule.defaultReasonText)}${active}`);
    });

    if (exceptions.length > 0) {
        lines.push('', T.exceptions_title);
        exceptions.forEach(exc => {
            let mark = '';
            if (exc.to < today) mark = ` ${T.exception_past}`;
            else if (exc.from <= today) mark = ` ${T.rule_active_mark}`;
            lines.push(exceptionBlock(exc, s.schedule.defaultReasonText) + mark);
        });
    }
    lines.push('', T.ai_schedule_hint);

    const keyboard = [];
    // Two slot buttons per row
    for (let i = 0; i < rules.length; i += 2) {
        keyboard.push(rules.slice(i, i + 2).map((rule, j) =>
            btn(`${i + j + 1}. ${rule.start}–${rule.end}`, `rule:${i + j}`)
        ));
    }
    exceptions.forEach((exc, i) => keyboard.push([btn(fill(T.btn_exception, { label: exc.label }), `exc:${i}`)]));
    keyboard.push([btn(T.btn_add_rule, 'add')]);
    keyboard.push([btn(T.btn_back, 'home')]);
    return { text: lines.join('\n'), keyboard };
}

function ruleView(index) {
    const s = getSettings(NS());
    const rule = s.schedule.rules[index];
    if (!rule) return rulesView();
    return {
        text: fill(T.rule_title, {
            index: index + 1,
            start: rule.start,
            end: rule.end,
            days: daysLabel(rule.days),
            text: escapeHtml(resolveRuleText(rule, s.schedule.defaultReasonText))
        }),
        keyboard: [
            [btn(T.btn_edit_time, `rtime:${index}`), btn(T.btn_edit_days, `rdays:${index}`)],
            [btn(T.btn_edit_text, `rtext:${index}`), btn(T.btn_delete, `rdel:${index}`)],
            [btn(T.btn_back, 'rules')]
        ]
    };
}

// Weekday toggles for one slot
function daysView(index) {
    const rule = getSettings(NS()).schedule.rules[index];
    if (!rule) return rulesView();
    const selected = rule.days || [];
    const every = selected.length === 0;
    const dayBtn = (day, i) => btn(`${!every && selected.includes(day) ? '✅' : '▫️'} ${T.day_names[i]}`, `rday:${index}:${i}`);
    return {
        text: fill(T.days_title, { index: index + 1, start: rule.start, end: rule.end, days: daysLabel(rule.days) }),
        keyboard: [
            DAYS.slice(0, 4).map((day, i) => dayBtn(day, i)),
            DAYS.slice(4).map((day, i) => dayBtn(day, i + 4)),
            [btn(`${every ? '✅' : '▫️'} ${T.days_every}`, `rdayall:${index}`)],
            [btn(T.btn_back, `rule:${index}`)]
        ]
    };
}

function exceptionView(index) {
    const s = getSettings(NS());
    const exc = (s.schedule.exceptions || [])[index];
    if (!exc) return rulesView();
    return {
        text: `${T.exception_title}\n\n${exceptionBlock(exc, s.schedule.defaultReasonText)}\n\n${T.ai_schedule_hint}`,
        keyboard: [
            [btn(T.btn_delete, `excdel:${index}`)],
            [btn(T.btn_back, 'rules')]
        ]
    };
}

// AI proposal: what will change + accept / reject
function proposalView(proposal) {
    const current = getSettings(NS()).schedule;
    const diff = diffSchedules(current, proposal.schedule);
    const lines = [T.proposal_title, ''];
    lines.push(...(diff.changed ? diff.lines : [T.proposal_no_changes]));
    if (proposal.note) lines.push('', fill(T.proposal_note, { note: escapeHtml(proposal.note) }));
    lines.push('', diff.changed ? T.proposal_question : '', T.proposal_refine);
    const keyboard = diff.changed
        ? [[btn(T.btn_accept, 'aiok'), btn(T.btn_reject, 'aino')]]
        : [[btn(T.btn_back, 'rules')]];
    return { text: lines.join('\n').slice(0, 4096), keyboard };
}

function chatsView() {
    const recent = chats.recentChats(NS(), 8);
    const lines = [T.chats_title];
    if (recent.length === 0) lines.push('', T.chats_empty);
    const keyboard = recent.map(chat => {
        const mode = chats.aiModeOf(chat);
        const icon = mode ? `${AI_MODE_ICON[mode]} ` : '';
        return [btn(icon + chats.chatTitle(chat), `chat:${chat.id}`)];
    });
    keyboard.push([btn(T.btn_back, 'home')]);
    return { text: lines.join('\n'), keyboard };
}

const AI_MODE_ICON = { replies_off: '🔇', ai_off: '🚫' };
const AI_MODE_HOURS = [1, 3, 8, 24, 0]; // 0 = until turned back on

// "🤖 AI in this chat: …" line for the chat card
function aiModeLine(chat) {
    const mode = chats.aiModeOf(chat);
    if (!mode) return T.ai_mode_status_on;
    const until = chat.ai_mode_until ? fill(T.ai_mode_until, { time: formatDateTime(chat.ai_mode_until) }) : T.ai_mode_forever;
    return fill(T[`ai_mode_status_${mode}`], { until });
}

// Pick a mode and a duration for one chat
function aiModeView(id) {
    const chat = ownChat(id);
    if (!chat) return chatsView();
    const duration = hours => (hours ? fill(T.hours, { value: hours }) : '∞');
    const row = mode => AI_MODE_HOURS.map(hours => btn(duration(hours), `caiset:${id}:${mode}:${hours}`));
    const keyboard = [
        [btn(T.btn_ai_mode_replies, `cai:${id}`)],
        row('r'),
        [btn(T.btn_ai_mode_ai, `cai:${id}`)],
        row('a')
    ];
    if (chats.aiModeOf(chat)) keyboard.push([btn(T.btn_ai_mode_resume, `caioff:${id}`)]);
    keyboard.push([btn(T.btn_back, `chat:${id}`)]);
    return {
        text: fill(T.ai_mode_title, { title: escapeHtml(chats.chatTitle(chat)), status: aiModeLine(chat) }),
        keyboard
    };
}

function chatView(id) {
    const chat = ownChat(id);
    if (!chat) return chatsView();
    const s = getSettings(NS());
    const quote = text => `<blockquote expandable>${escapeHtml(text)}</blockquote>`;
    let aiMemory = chat.ai_memory ? quote(chat.ai_memory) : T.chat_no_ai_memory;
    if (chat.reanalyze_by) aiMemory = T.chat_reanalyzing;
    else if (!s.autoMemory && !chat.ai_memory) aiMemory = T.chat_ai_memory_off;
    return {
        text: (fill(T.chat_title, {
            title: escapeHtml(chats.chatTitle(chat)),
            chatId: chat.chat_id,
            count: archive.countArchived(chat.chat_key),
            limit: s.historyLimit,
            context: chat.context ? quote(chat.context) : T.chat_no_context,
            aiMemory
        }) + '\n\n' + aiModeLine(chat)).slice(0, 4096),
        keyboard: [
            [btn(chats.aiModeOf(chat) ? T.btn_ai_mode_change : T.btn_ai_mode, `cai:${id}`)],
            [btn(T.btn_set_context, `cset:${id}`), btn(T.btn_append_context, `cadd:${id}`)],
            ...(chat.context ? [[btn(T.btn_delete_context, `cdel:${id}`)]] : []),
            [btn(T.btn_chat_topics, `ctop:${id}`), btn(T.btn_reanalyze, `crean:${id}`)],
            [btn(T.btn_clear_chat, `cclr:${id}`)],
            [btn(T.btn_back, 'chats')]
        ]
    };
}

// Premium (custom) emoji pairs. `rich` renders the custom emoji themselves,
// which only works when the account is allowed to use them.
function premiumView(rich) {
    const { premiumEmoji, rich: richSettings } = getSettings(NS());
    const premium = hasPremiumConnection(NS());
    const pairs = Object.entries(premiumEmoji.map);
    const lines = [
        T.premium_title,
        '',
        premium ? T.premium_status_yes : T.premium_status_no,
        '',
        pairs.length ? T.premium_pairs : T.premium_empty
    ];
    for (const [key, entry] of pairs) {
        const shown = rich ? `<tg-emoji emoji-id="${entry.id}">${entry.alt}</tg-emoji>` : `<code>${entry.id}</code>`;
        lines.push(`${escapeHtml(key)} → ${shown}`);
    }
    lines.push('', T.premium_help, '', T.rich_help);

    // Features Telegram refused recently (with the reason)
    for (const status of capabilityStatus(['bot', `ns:${NS()}`])) {
        lines.push(fill(T.capability_blocked, {
            name: `${T.capability_names[status.name] || status.name} (${status.scope === 'bot' ? T.scope_bot : T.scope_business})`,
            error: escapeHtml(String(status.error).slice(0, 200))
        }));
    }
    return {
        text: lines.join('\n').slice(0, 4096),
        keyboard: [
            [btn(fill(T.btn_premium_toggle, { value: onOff(premiumEmoji.enabled) }), 'petog')],
            ...(pairs.length ? [[btn(T.btn_premium_reset, 'pereset')]] : []),
            [btn(fill(T.btn_rich, { value: onOff(richSettings.enabled) }), 'prich')],
            [btn(fill(T.btn_rich_ui, { value: onOff(richSettings.ui) }), 'pui')],
            [btn(fill(T.btn_drafts, { value: onOff(richSettings.drafts) }), 'pdraft')],
            [btn(T.btn_back, 'home')]
        ]
    };
}

// Tries the rich version first and falls back to ids if Telegram rejects custom emoji
async function showPremium(ctx, options) {
    if (hasPremiumConnection(NS())) {
        try {
            const view = premiumView(true);
            const extra = { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } };
            if (options?.edit !== false && ctx.callbackQuery) await ctx.editMessageText(view.text, extra);
            else await ctx.reply(view.text, extra);
            return;
        } catch (err) {
            if (/not modified/i.test(err.description || err.message)) return;
        }
    }
    await show(ctx, premiumView(false), options);
}

// System instruction for the AI: custom (from the panel) or the default from config.js
function systemPromptView() {
    const custom = getSettings(NS()).aiInstruction;
    const current = (custom || config.aiInstruction).trim();
    const budget = 3300;
    const shown = current.length > budget ? `${escapeHtml(current.slice(0, budget))}\n${T.prompt_truncated}` : escapeHtml(current);
    return {
        text: [
            fill(T.prompt_title, { state: custom ? T.prompt_state_custom : T.prompt_state_default }),
            `<pre>${shown}</pre>`,
            T.prompt_help
        ].join('\n\n'),
        keyboard: [
            [btn(T.btn_prompt_edit, 'sysedit'), ...(custom ? [btn(T.btn_prompt_reset, 'sysreset')] : [])],
            [btn(T.btn_back, 'home')]
        ]
    };
}

// Message tracking + AI memory + topics settings
function memoryView() {
    const s = getSettings(NS());
    const hours = fill(T.hours, { value: s.topicsHours });
    return {
        text: [T.memory_title, '', T.memory_help].join('\n'),
        keyboard: [
            [btn(fill(T.btn_notify_deleted, { value: onOff(s.notifyDeleted) }), 'tdel')],
            [btn(fill(T.btn_notify_edited, { value: onOff(s.notifyEdited) }), 'tedit')],
            [btn(fill(T.btn_history, { value: s.historyLimit }), 'thist')],
            [btn(fill(T.btn_auto_memory, { value: onOff(s.autoMemory) }), 'tmem')],
            [
                btn(fill(T.btn_topics, { value: onOff(s.topicsEnabled) }), 'ttop'),
                btn(fill(T.btn_topics_hours, { value: hours }), 'ttoph')
            ],
            [btn(T.btn_back, 'home')]
        ]
    };
}

// One topic as an HTML block
function topicBlock(topic, withChat) {
    const who = withChat ? escapeHtml(chats.chatTitle(topic)) : '';
    return fill(T.topic_line, {
        title: escapeHtml(topic.title),
        who: who ? ` · ${who}` : '',
        summary: topic.summary ? `\n<i>${escapeHtml(topic.summary)}</i>` : '',
        count: topic.message_count,
        range: formatRange(topic.first_at, topic.last_at)
    });
}

// Joins blocks until Telegram's length limit
function fitBlocks(head, blocks) {
    let text = head;
    for (const block of blocks) {
        if (text.length + block.length + 2 > 4000) break;
        text += `\n\n${block}`;
    }
    return text;
}

// "Recent dialogs" across all chats
function dialogsView() {
    const s = getSettings(NS());
    const list = topics.recentTopics(NS(), s.topicsHours, 15);
    let head = fill(T.dialogs_title, { hours: s.topicsHours });
    if (!s.topicsEnabled) head += `\n\n${T.dialogs_disabled}`;
    else if (list.length === 0) head += `\n\n${T.dialogs_empty}`;

    // Buttons to jump into the chats that appear in the list
    const seen = new Set();
    const keyboard = [];
    for (const topic of list) {
        if (!topic.chat_row_id || seen.has(topic.chat_row_id)) continue;
        seen.add(topic.chat_row_id);
        keyboard.push([btn(`👤 ${chats.chatTitle(topic)}`, `chat:${topic.chat_row_id}`)]);
    }
    keyboard.push([btn(T.btn_refresh, 'dlg'), btn(T.btn_back, 'home')]);
    return { text: fitBlocks(head, list.map(topic => topicBlock(topic, true))), keyboard };
}

function chatTopicsView(id) {
    const chat = ownChat(id);
    if (!chat) return chatsView();
    const s = getSettings(NS());
    const list = topics.chatTopics(chat.chat_key, s.topicsHours, 20);
    let head = fill(T.chat_topics_title, { title: escapeHtml(chats.chatTitle(chat)), hours: s.topicsHours });
    if (list.length === 0) head += `\n\n${s.topicsEnabled ? T.dialogs_empty : T.dialogs_disabled}`;
    return {
        text: fitBlocks(head, list.map(topic => topicBlock(topic, false))),
        keyboard: [[btn(T.btn_refresh, `ctop:${id}`), btn(T.btn_back, `chat:${id}`)]]
    };
}

// Preset reason buttons; `target` is 'def', 'new' or a rule index
function presetRows(target) {
    return PRESETS.map(key => [btn(texts.reasons[key], `preset:${target}:${key}`)]);
}

function promptView(text, target, backTo) {
    const keyboard = target !== undefined ? presetRows(target) : [];
    keyboard.push([btn(T.btn_cancel, `cancel:${backTo}`)]);
    return { text, keyboard };
}

// ---------- Rendering helpers ----------

async function show(ctx, view, { edit = true } = {}) {
    const extra = {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: view.keyboard }
    };
    if (edit && ctx.callbackQuery) {
        try {
            await ctx.editMessageText(view.text, extra);
            return;
        } catch (err) {
            if (/not modified/i.test(err.description || err.message)) return;
        }
    }
    await ctx.reply(view.text, extra);
}

// ---------- Settings mutations ----------

function addRule(start, end, reasonText) {
    updateSettings(NS(), s => { s.schedule.rules.push({ start, end, reasonText }); });
}

function setRuleText(index, reasonText) {
    updateSettings(NS(), s => {
        if (s.schedule.rules[index]) s.schedule.rules[index] = { ...s.schedule.rules[index], reasonText, reason: undefined };
    });
}

// ---------- Handlers ----------

// Tells people without access why the bot does not work for them
async function denyAccess(ctx) {
    const member = members.getMember(ctx.from?.id);
    const text = member?.status === 'pending' ? texts.access.pending : texts.access_denied;
    if (ctx.callbackQuery) return ctx.answerCbQuery(text.replace(/<[^>]+>/g, '').slice(0, 190), { show_alert: true }).catch(() => {});
    return ctx.reply(text, { parse_mode: 'HTML' });
}

// Runs a handler inside the namespace of the user (admins: the one they switched to)
const scoped = handler => async ctx => {
    if (!members.canUse(ctx.from?.id)) return denyAccess(ctx);
    return nsStore.run({ ns: resolveNs(ctx.from.id), userId: ctx.from.id }, () => handler(ctx));
};

function createAdminPanel(bot) {
    const openPanel = async ctx => {
        pendingInput.delete(ctx.from.id);
        return show(ctx, mainView(), { edit: false });
    };

    bot.start(scoped(openPanel));
    bot.command(['panel', 'menu', 'settings'], scoped(openPanel));

    bot.command('reset', scoped(async ctx => {
        memory.clearHistory(testKey(ctx.from.id));
        return ctx.reply(T.test_reset, { parse_mode: 'HTML' });
    }));

    bot.command('cancel', scoped(async ctx => {
        pendingInput.delete(ctx.from.id);
        return show(ctx, mainView(), { edit: false });
    }));

    bot.on('callback_query', async (ctx, next) => {
        if (!(ctx.callbackQuery.data || '').startsWith('sp:')) return next();
        return scoped(onCallback)(ctx);
    });

    async function onCallback(ctx) {
        const data = ctx.callbackQuery.data || '';

        const [action, arg, arg2] = data.slice(3).split(':');
        const index = Number(arg);
        const userId = ctx.from.id;
        let toast = '';

        switch (action) {
            case 'home':
                pendingInput.delete(userId);
                await show(ctx, mainView());
                break;

            case 'oname':
                pendingInput.set(userId, { action: 'owner_name' });
                await show(ctx, promptView(fill(T.ask_owner_name, { value: escapeHtml(getSettings(NS()).ownerName) }), undefined, 'home'));
                break;

            // ----- Accounts & access (admins only) -----

            case 'mlist':
            case 'mbr':
            case 'mapp':
            case 'mrej':
            case 'mns':
            case 'mdel':
            case 'mdelyes': {
                if (!isAdminUser()) {
                    toast = '⛔️';
                    break;
                }
                if (action === 'mlist') {
                    await show(ctx, membersView());
                } else if (action === 'mbr') {
                    await show(ctx, memberView(index));
                } else if (action === 'mapp' || action === 'mrej') {
                    if (members.isAdmin(index)) break;
                    const status = action === 'mapp' ? 'approved' : 'rejected';
                    await access.decide(ctx.telegram, index, status, userId);
                    // A revoked account must not stay selected by any admin
                    if (status === 'rejected') {
                        for (const [admin, ns] of activeNs) if (ns === index) activeNs.delete(admin);
                    }
                    toast = status === 'approved' ? T.member_approved : T.member_rejected;
                    await show(ctx, memberView(index));
                } else if (action === 'mns') {
                    if (!members.canUse(index)) break;
                    if (index === userId) activeNs.delete(userId);
                    else activeNs.set(userId, index);
                    pendingInput.delete(userId);
                    toast = T.ns_switched;
                    // Re-render inside the new namespace
                    await nsStore.run({ ns: index, userId }, () => show(ctx, mainView()));
                } else if (action === 'mdel') {
                    const member = members.getMember(index);
                    if (!member || members.isAdmin(index)) break;
                    await show(ctx, {
                        text: fill(T.confirm_member_delete, { name: escapeHtml(members.memberTitle(member)) }),
                        keyboard: [[btn(T.btn_member_delete_yes, `mdelyes:${index}`), btn(T.btn_no, `mbr:${index}`)]]
                    });
                } else if (action === 'mdelyes') {
                    if (members.isAdmin(index)) break;
                    // Remove the account and everything stored for it
                    archive.clearAllArchive(index);
                    topics.deleteAllTopics(index);
                    chats.deleteChats(index);
                    resetSettings(index);
                    members.removeMember(index);
                    for (const [admin, ns] of activeNs) if (ns === index) activeNs.delete(admin);
                    toast = T.deleted;
                    await show(ctx, membersView());
                }
                break;
            }

            case 'mnsme':
                activeNs.delete(userId);
                pendingInput.delete(userId);
                toast = T.ns_switched;
                await nsStore.run({ ns: userId, userId }, () => show(ctx, mainView()));
                break;

            case 'ai':
                updateSettings(NS(), s => { s.aiEnabled = !s.aiEnabled; });
                await show(ctx, mainView());
                break;

            case 'mode':
                updateSettings(NS(), s => {
                    s.schedule.enabled = true;
                    s.schedule.mode = nextOf(MODES, s.schedule.mode);
                });
                await show(ctx, mainView());
                break;

            case 'read':
                updateSettings(NS(), s => { s.markAsRead = !s.markAsRead; });
                await show(ctx, mainView());
                break;

            case 'smart':
                updateSettings(NS(), s => { s.smartWait.enabled = !s.smartWait.enabled; });
                await show(ctx, mainView());
                break;

            case 'deb':
                updateSettings(NS(), s => {
                    s.smartWait.enabled = true;
                    s.smartWait.debounceMs = nextOf(DEBOUNCE_STEPS, s.smartWait.debounceMs);
                });
                await show(ctx, mainView());
                break;

            case 'pause':
                updateSettings(NS(), s => { s.ownerPauseMin = nextOf(PAUSE_STEPS, s.ownerPauseMin); });
                await show(ctx, mainView());
                break;

            case 'clear':
                await show(ctx, {
                    text: T.confirm_clear,
                    keyboard: [[btn(T.btn_yes, 'clearyes'), btn(T.btn_no, 'home')]]
                });
                break;

            case 'clearyes':
                archive.clearAllArchive(NS());
                topics.deleteAllTopics(NS());
                chats.clearAllAiMemory(NS());
                memory.clearAllHistory();
                toast = T.cleared;
                await show(ctx, mainView());
                break;

            case 'sys':
                pendingInput.delete(userId);
                await show(ctx, systemPromptView());
                break;

            case 'sysedit':
                pendingInput.set(userId, { action: 'system_prompt' });
                await show(ctx, promptView(T.ask_prompt, undefined, 'sys'));
                break;

            case 'sysreset':
                await show(ctx, {
                    text: T.confirm_prompt_reset,
                    keyboard: [[btn(T.btn_yes_reset, 'sysresetyes'), btn(T.btn_no, 'sys')]]
                });
                break;

            case 'sysresetyes':
                updateSettings(NS(), s => { s.aiInstruction = null; });
                toast = T.prompt_reset_done;
                await show(ctx, systemPromptView());
                break;

            case 'mem':
                await show(ctx, memoryView());
                break;

            case 'pe':
                // While this view is open, any message = emoji pairs
                pendingInput.set(userId, { action: 'premium_emoji' });
                await showPremium(ctx);
                break;

            case 'petog':
                updateSettings(NS(), s => { s.premiumEmoji.enabled = !s.premiumEmoji.enabled; });
                await showPremium(ctx);
                break;

            case 'prich':
            case 'pdraft':
            case 'pui': {
                const key = { prich: 'enabled', pdraft: 'drafts', pui: 'ui' }[action];
                updateSettings(NS(), s => { s.rich[key] = !s.rich[key]; });
                await showPremium(ctx);
                break;
            }

            case 'pereset':
                updateSettings(NS(), s => { s.premiumEmoji.map = {}; });
                toast = T.deleted;
                await showPremium(ctx);
                break;

            case 'tdel':
                updateSettings(NS(), s => { s.notifyDeleted = !s.notifyDeleted; });
                await show(ctx, memoryView());
                break;

            case 'tedit':
                updateSettings(NS(), s => { s.notifyEdited = !s.notifyEdited; });
                await show(ctx, memoryView());
                break;

            case 'thist':
                updateSettings(NS(), s => { s.historyLimit = nextOf(HISTORY_STEPS, s.historyLimit); });
                await show(ctx, memoryView());
                break;

            case 'tmem':
            case 'ttop': {
                const key = action === 'tmem' ? 'autoMemory' : 'topicsEnabled';
                const enabled = updateSettings(NS(), s => { s[key] = !s[key]; })[key];
                // First enable: existing chats are analyzed from the database in the background
                if (enabled) {
                    toast = T.analysis_started;
                    runDigestNow(ctx.telegram).catch(err => logger.error('digest', err));
                }
                await show(ctx, memoryView());
                break;
            }

            case 'ttoph':
                updateSettings(NS(), s => { s.topicsHours = nextOf(TOPIC_HOURS_STEPS, s.topicsHours); });
                await show(ctx, memoryView());
                break;

            case 'dlg':
                await show(ctx, dialogsView());
                break;

            case 'ctop':
                await show(ctx, chatTopicsView(index));
                break;

            case 'crean': {
                const chat = ownChat(index);
                if (!chat) break;
                await show(ctx, {
                    text: fill(T.confirm_reanalyze, {
                        title: escapeHtml(chats.chatTitle(chat)),
                        count: archive.countArchived(chat.chat_key)
                    }),
                    keyboard: [[btn(T.btn_reanalyze_yes, `creanyes:${index}`), btn(T.btn_no, `chat:${index}`)]]
                });
                break;
            }

            case 'creanyes': {
                const chat = ownChat(index);
                if (!chat) break;
                chats.requestReanalysis(chat.id, ctx.chat.id);
                topics.deleteChatTopics(chat.chat_key);
                toast = T.reanalyze_started;
                runDigestNow(ctx.telegram).catch(err => logger.error('digest', err));
                await show(ctx, chatView(index));
                break;
            }

            case 'rules':
                // While the schedule is open, any text = request for the AI schedule editor
                pendingInput.set(userId, { action: 'ai_schedule' });
                await show(ctx, rulesView());
                break;

            case 'rdays':
                await show(ctx, daysView(index));
                break;

            case 'rday':
            case 'rdayall':
                updateSettings(NS(), s => {
                    const rule = s.schedule.rules[index];
                    if (!rule) return;
                    if (action === 'rdayall') {
                        delete rule.days;
                        return;
                    }
                    const day = DAYS[Number(arg2)];
                    const days = new Set(rule.days || []);
                    if (days.has(day)) days.delete(day);
                    else days.add(day);
                    const sorted = DAYS.filter(d => days.has(d));
                    if (sorted.length === 0 || sorted.length === 7) delete rule.days;
                    else rule.days = sorted;
                });
                await show(ctx, daysView(index));
                break;

            case 'exc':
                await show(ctx, exceptionView(index));
                break;

            case 'excdel':
                updateSettings(NS(), s => { (s.schedule.exceptions || []).splice(index, 1); });
                toast = T.deleted;
                await show(ctx, rulesView());
                break;

            case 'aiok': {
                const proposal = pendingInput.get(userId)?.proposal;
                if (!proposal) {
                    toast = T.proposal_expired;
                    await show(ctx, rulesView());
                    break;
                }
                updateSettings(NS(), s => {
                    Object.assign(s.schedule, {
                        rules: proposal.schedule.rules,
                        exceptions: proposal.schedule.exceptions,
                        mode: proposal.schedule.mode,
                        defaultReasonText: proposal.schedule.defaultReasonText
                    });
                });
                pendingInput.set(userId, { action: 'ai_schedule' });
                toast = T.saved;
                await show(ctx, rulesView());
                break;
            }

            case 'aino':
                pendingInput.set(userId, { action: 'ai_schedule' });
                toast = T.cancelled;
                await show(ctx, rulesView());
                break;

            case 'rule':
                await show(ctx, ruleView(index));
                break;

            case 'add':
                pendingInput.set(userId, { action: 'add_rule' });
                await show(ctx, promptView(T.ask_add_rule, undefined, 'rules'));
                break;

            case 'rtime':
                pendingInput.set(userId, { action: 'rule_time', index });
                await show(ctx, promptView(T.ask_rule_time, undefined, `rule-${index}`));
                break;

            case 'rtext':
                pendingInput.set(userId, { action: 'rule_text', index });
                await show(ctx, promptView(T.ask_rule_text, index, `rule-${index}`));
                break;

            case 'rdel':
                updateSettings(NS(), s => { s.schedule.rules.splice(index, 1); });
                toast = T.deleted;
                await show(ctx, rulesView());
                break;

            case 'def': {
                const current = getSettings(NS()).schedule.defaultReasonText;
                pendingInput.set(userId, { action: 'default_reason' });
                await show(ctx, promptView(fill(T.ask_default_reason, { value: escapeHtml(current) }), 'def', 'home'));
                break;
            }

            case 'preset': {
                // arg = 'def' | 'new' | rule index, arg2 = preset key
                const reasonText = texts.reasons[arg2];
                if (!reasonText) break;
                const pending = pendingInput.get(userId);
                if (arg === 'def') {
                    updateSettings(NS(), s => { s.schedule.defaultReasonText = reasonText; });
                    await show(ctx, mainView());
                } else if (arg === 'new' && pending?.draft) {
                    addRule(pending.draft.start, pending.draft.end, reasonText);
                    await show(ctx, rulesView());
                } else if (Number.isInteger(index)) {
                    setRuleText(index, reasonText);
                    await show(ctx, ruleView(index));
                }
                if (arg === 'def') pendingInput.delete(userId);
                else pendingInput.set(userId, { action: 'ai_schedule' });
                toast = T.saved;
                break;
            }

            case 'chats':
                // While this view is open, any text = chat search
                pendingInput.set(userId, { action: 'find_chat' });
                await show(ctx, chatsView());
                break;

            case 'chat':
                pendingInput.delete(userId);
                await show(ctx, chatView(index));
                break;

            case 'cset':
            case 'cadd': {
                const chat = ownChat(index);
                if (!chat) break;
                const append = action === 'cadd';
                pendingInput.set(userId, { action: append ? 'append_context' : 'set_context', chatId: index });
                const prompt = append ? T.ask_append_context : T.ask_set_context;
                await show(ctx, promptView(fill(prompt, { title: escapeHtml(chats.chatTitle(chat)) }), undefined, `chat-${index}`));
                break;
            }

            case 'cdel':
                chats.setContext(index, null);
                toast = T.context_deleted;
                await show(ctx, chatView(index));
                break;

            case 'cclr': {
                const chat = ownChat(index);
                if (!chat) break;
                await show(ctx, {
                    text: fill(T.confirm_clear_chat, { title: escapeHtml(chats.chatTitle(chat)) }),
                    keyboard: [[btn(T.btn_yes, `cclryes:${index}`), btn(T.btn_no, `chat:${index}`)]]
                });
                break;
            }

            case 'cai':
                await show(ctx, aiModeView(index));
                break;

            case 'caiset': {
                // arg = chat id, arg2 = 'r' (auto-replies off) | 'a' (AI off), 4th part = hours (0 = forever)
                const chat = ownChat(index);
                if (!chat) break;
                const hours = Number(data.split(':')[4]) || 0;
                const mode = arg2 === 'a' ? 'ai_off' : 'replies_off';
                chats.setAiMode(chat.id, mode, hours ? Math.floor(Date.now() / 1000) + hours * 3600 : null);
                toast = T.saved;
                await show(ctx, chatView(index));
                break;
            }

            case 'caioff': {
                const chat = ownChat(index);
                if (chat) chats.setAiMode(chat.id, null);
                toast = T.ai_mode_resumed;
                await show(ctx, chatView(index));
                break;
            }

            case 'cclryes': {
                const chat = ownChat(index);
                if (chat) {
                    archive.clearChatArchive(chat.chat_key);
                    topics.deleteChatTopics(chat.chat_key);
                    chats.setAiMemory(chat.id, null);
                    memory.clearHistory(chat.chat_key); // legacy rows from before the archive
                }
                toast = T.chat_cleared;
                await show(ctx, chatView(index));
                break;
            }

            case 'cancel': {
                if (arg === 'rules' || arg?.startsWith('rule-')) pendingInput.set(userId, { action: 'ai_schedule' });
                else pendingInput.delete(userId);
                toast = T.cancelled;
                // arg = 'home' | 'rules' | 'rule-<index>' | 'chat-<id>'
                if (arg?.startsWith('rule-')) await show(ctx, ruleView(Number(arg.slice(5))));
                else if (arg?.startsWith('chat-')) await show(ctx, chatView(Number(arg.slice(5))));
                else if (arg === 'sys') await show(ctx, systemPromptView());
                else if (arg === 'rules') await show(ctx, rulesView());
                else await show(ctx, mainView());
                break;
            }
        }

        await ctx.answerCbQuery(toast).catch(() => {});
    }

    // Private text messages: panel input, test chat with the AI, or access denied
    bot.on('message', async (ctx, next) => {
        if (ctx.chat.type !== 'private') return next();
        return scoped(onMessage)(ctx);
    });

    async function onMessage(ctx) {

        const text = ctx.message.text?.trim();
        if (!text || text.startsWith('/')) return;
        const userId = ctx.from.id;
        const pending = pendingInput.get(userId);

        if (pending) return handleInput(ctx, pending, text);

        // No pending input -> preview how the AI would answer a client
        const settings = getSettings(NS());
        if (!config.aiEnabled) return;
        const status = checkSchedule(settings.schedule, config.timezone);
        const key = testKey(userId);
        memory.addMessage(key, 'user', text, config.ownerAiLimit);
        try {
            const reply = await generateReply({
                telegram: ctx.telegram,
                ns: NS(),
                chatId: ctx.chat.id,
                history: memory.getHistory(key, config.ownerAiLimit),
                premium: hasPremiumConnection(NS()),
                reason: status.reason,
                time: status.time
            });
            if (reply.text) memory.addMessage(key, 'assistant', reply.text, config.ownerAiLimit);
        } catch (err) {
            logger.error('owner test chat', err);
        }
    }
}

// Applies text the owner typed after pressing a panel button
async function handleInput(ctx, pending, text) {
    const userId = ctx.from.id;
    const fail = message => ctx.reply(message, { parse_mode: 'HTML' });

    switch (pending.action) {
        case 'add_rule': {
            const range = parseRange(text);
            if (!range) return fail(T.bad_time);
            if (range.rest.length > MAX_REASON_LENGTH) return fail(fill(T.too_long, { max: MAX_REASON_LENGTH }));
            if (!range.rest) {
                // Only time given -> ask for a preset or custom text
                pendingInput.set(userId, { action: 'pick_preset', draft: { start: range.start, end: range.end } });
                return show(ctx, promptView(fill(T.pick_preset, range) + '\n\n' + T.ask_rule_text, 'new', 'rules'), { edit: false });
            }
            addRule(range.start, range.end, range.rest);
            break;
        }

        case 'pick_preset': {
            if (text.length > MAX_REASON_LENGTH) return fail(fill(T.too_long, { max: MAX_REASON_LENGTH }));
            addRule(pending.draft.start, pending.draft.end, text);
            break;
        }

        case 'rule_time': {
            const range = parseRange(text);
            if (!range) return fail(T.bad_time);
            updateSettings(NS(), s => {
                const rule = s.schedule.rules[pending.index];
                if (rule) Object.assign(rule, { start: range.start, end: range.end });
            });
            pendingInput.set(userId, { action: 'ai_schedule' });
            await ctx.reply(T.saved);
            return show(ctx, ruleView(pending.index), { edit: false });
        }

        case 'rule_text': {
            if (text.length > MAX_REASON_LENGTH) return fail(fill(T.too_long, { max: MAX_REASON_LENGTH }));
            setRuleText(pending.index, text);
            pendingInput.set(userId, { action: 'ai_schedule' });
            await ctx.reply(T.saved);
            return show(ctx, ruleView(pending.index), { edit: false });
        }

        case 'ai_schedule': {
            if (!config.aiEnabled) return fail(T.ai_schedule_disabled);
            if (text.length > 1000) return fail(fill(T.too_long, { max: 1000 }));

            const saved = getSettings(NS()).schedule;
            // Refinements build on top of the previous (not yet accepted) proposal
            const base = pending.proposal?.schedule || saved;
            const current = {
                mode: base.mode,
                defaultReasonText: base.defaultReasonText,
                rules: base.rules || [],
                exceptions: base.exceptions || []
            };

            const thinking = await ctx.reply(T.ai_thinking, { parse_mode: 'HTML' });
            let proposal;
            try {
                const result = await proposeSchedule({ current, request: text, local: getLocalTime(config.timezone) });
                proposal = { schedule: { ...current, ...result.schedule }, note: result.note };
            } catch (err) {
                logger.error('AI schedule editor', err);
                await ctx.deleteMessage(thinking.message_id).catch(() => {});
                return fail(fill(T.ai_schedule_failed, { error: escapeHtml(err.message || String(err)) }));
            }
            await ctx.deleteMessage(thinking.message_id).catch(() => {});

            pendingInput.set(userId, { action: 'ai_schedule', proposal });
            return show(ctx, proposalView(proposal), { edit: false });
        }

        case 'owner_name': {
            if (text.length > 64) return fail(fill(T.too_long, { max: 64 }));
            updateSettings(NS(), s => { s.ownerName = text; });
            pendingInput.delete(userId);
            await ctx.reply(T.saved);
            return show(ctx, mainView(), { edit: false });
        }

        case 'system_prompt': {
            if (text.length < 20) return fail(T.prompt_too_short);
            updateSettings(NS(), s => { s.aiInstruction = text; });
            pendingInput.delete(userId);
            await ctx.reply(T.saved);
            return show(ctx, systemPromptView(), { edit: false });
        }

        case 'premium_emoji': {
            const pairs = parsePairs(ctx.message.text, ctx.message.entities);
            const changed = Object.keys(pairs.set).length + pairs.remove.length;
            if (changed === 0) return fail(T.premium_bad_input);
            updateSettings(NS(), s => {
                Object.assign(s.premiumEmoji.map, pairs.set);
                for (const key of pairs.remove) delete s.premiumEmoji.map[key];
            });
            await ctx.reply(T.saved);
            return showPremium(ctx, { edit: false });
        }

        case 'find_chat': {
            const found = chats.findChats(text, NS());
            if (found.length === 0) return fail(fill(T.chat_not_found, { query: escapeHtml(text.slice(0, 64)) }));
            pendingInput.delete(userId);
            if (found.length === 1) return show(ctx, chatView(found[0].id), { edit: false });
            return show(ctx, {
                text: T.chat_many,
                keyboard: [...found.map(chat => [btn(chats.chatTitle(chat), `chat:${chat.id}`)]), [btn(T.btn_back, 'chats')]]
            }, { edit: false });
        }

        case 'set_context':
        case 'append_context': {
            const chat = ownChat(pending.chatId);
            if (!chat) break;
            const next = pending.action === 'append_context' && chat.context ? `${chat.context}\n${text}` : text;
            if (next.length > MAX_CONTEXT_LENGTH) return fail(fill(T.too_long, { max: MAX_CONTEXT_LENGTH }));
            chats.setContext(chat.id, next);
            pendingInput.delete(userId);
            await ctx.reply(T.saved);
            return show(ctx, chatView(chat.id), { edit: false });
        }

        case 'default_reason': {
            if (text.length > MAX_REASON_LENGTH) return fail(fill(T.too_long, { max: MAX_REASON_LENGTH }));
            updateSettings(NS(), s => { s.schedule.defaultReasonText = text; });
            pendingInput.delete(userId);
            await ctx.reply(T.saved);
            return show(ctx, mainView(), { edit: false });
        }
    }

    // add_rule / pick_preset finished -> back to the schedule (text = AI editor again)
    pendingInput.set(userId, { action: 'ai_schedule' });
    await ctx.reply(T.saved);
    return show(ctx, rulesView(), { edit: false });
}

module.exports = { createAdminPanel };
