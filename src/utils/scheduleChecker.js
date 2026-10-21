// ------------------------------
// scheduleChecker.js - resolves whether auto-replies are active right now
// and which reason text should be shown in the prefix.
//
// Schedule format:
// {
//   enabled, mode: "always" | "schedule" | "strict", defaultReasonText,
//   rules: [ { start: "21:30", end: "07:00", days: ["mon", ...], reasonText } ],   // weekly slots
//   exceptions: [                                                                   // one-off periods
//     { from: "2026-12-22", to: "2027-01-06", label: "Winter holidays",
//       reasonText: "On holidays 🎄", rules: [ ...slots used INSTEAD of weekly rules ] }
//   ]
// }
// - `days` empty/missing = every day.
// - A slot crossing midnight belongs to the day it starts on
//   (Mon 21:30-07:00 also covers Tuesday 00:00-07:00).
// - "24:00" is allowed as an end time ("00:00-24:00" = the whole day).
// ------------------------------

const texts = require('../../config/texts.json');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]?\d|2[0-4]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "7:05" -> 425. "24:00" is valid only as an end time.
function toMinutes(value, { isEnd = false } = {}) {
    const match = TIME_RE.exec(String(value ?? '').trim());
    if (!match) return null;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    if (minutes > 1440 || (minutes === 1440 && !isEnd)) return null;
    return minutes;
}

// Normalizes "7:05" -> "07:05"
function normalizeTime(value, options) {
    const minutes = toMinutes(value, options);
    if (minutes === null) return null;
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return `${h}:${m}`;
}

// Parses "23:00-07:00" (also accepts – — and spaces) -> { start, end, rest } or null
function parseRange(value) {
    const match = /^\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s*/.exec(String(value ?? ''));
    if (!match) return null;
    const start = normalizeTime(match[1]);
    const end = normalizeTime(match[2], { isEnd: true });
    if (!start || !end || start === end) return null;
    return { start, end, rest: String(value).slice(match[0].length).trim() };
}

// Normalizes a days list: ["Monday", "tue", 3] -> ["mon", "tue", "thu"]; all 7 -> []
function normalizeDays(days) {
    if (!Array.isArray(days)) return [];
    const result = new Set();
    for (const day of days) {
        if (typeof day === 'number' && day >= 0 && day <= 6) result.add(DAYS[day]);
        const key = String(day).trim().toLowerCase().slice(0, 3);
        if (DAYS.includes(key)) result.add(key);
    }
    const sorted = DAYS.filter(day => result.has(day));
    return sorted.length === 7 ? [] : sorted;
}

// Current local time/date in the given IANA timezone
function getLocalTime(timezone, now = new Date()) {
    const options = {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit'
    };
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone }).formatToParts(now);
    } catch {
        // Unknown timezone -> fall back to server time
        parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(now);
    }
    const get = type => parts.find(p => p.type === type).value;
    const [year, month, day] = [Number(get('year')), Number(get('month')), Number(get('day'))];
    const hour = get('hour');
    const minute = get('minute');

    // Calendar math in UTC so DST never shifts the date
    const today = new Date(Date.UTC(year, month - 1, day));
    const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
    const iso = date => date.toISOString().slice(0, 10);
    const weekday = date => DAYS[(date.getUTCDay() + 6) % 7];

    return {
        label: `${hour}:${minute}`,
        minutes: Number(hour) * 60 + Number(minute),
        date: iso(today),
        weekday: weekday(today),
        yesterday: iso(yesterday),
        yesterdayWeekday: weekday(yesterday)
    };
}

const dayMatches = (rule, weekday) => !rule.days || rule.days.length === 0 || rule.days.includes(weekday);

// Exception covering a date, if any (the first one wins)
function findException(schedule, date) {
    const list = Array.isArray(schedule.exceptions) ? schedule.exceptions : [];
    return list.find(exc => exc.from <= date && date <= exc.to) || null;
}

// Rules that apply on a date: the exception's own slots or the weekly ones
function rulesForDate(schedule, date) {
    const exception = findException(schedule, date);
    if (exception) return { rules: exception.rules || [], exception };
    return { rules: Array.isArray(schedule.rules) ? schedule.rules : [], exception: null };
}

// Kept for compatibility: true if `minutes` is inside the slot (ignores days)
function isInSlot(minutes, rule) {
    const start = toMinutes(rule.start);
    const end = toMinutes(rule.end, { isEnd: true });
    if (start === null || end === null || start === end) return false;
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
}

// Finds the slot active right now, looking at today's slots and at
// overnight slots that started yesterday.
function findActiveSlot(schedule, local) {
    const today = rulesForDate(schedule, local.date);
    for (let i = 0; i < today.rules.length; i++) {
        const rule = today.rules[i];
        const start = toMinutes(rule.start);
        const end = toMinutes(rule.end, { isEnd: true });
        if (start === null || end === null || start === end || !dayMatches(rule, local.weekday)) continue;
        const inside = start < end ? local.minutes >= start && local.minutes < end : local.minutes >= start;
        if (inside) return { rule, index: i, exception: today.exception };
    }

    const yesterday = rulesForDate(schedule, local.yesterday);
    for (let i = 0; i < yesterday.rules.length; i++) {
        const rule = yesterday.rules[i];
        const start = toMinutes(rule.start);
        const end = toMinutes(rule.end, { isEnd: true });
        if (start === null || end === null || start <= end || !dayMatches(rule, local.yesterdayWeekday)) continue;
        if (local.minutes < end) return { rule, index: i, exception: yesterday.exception };
    }
    return null;
}

// Rule text priority: custom reasonText -> preset key from texts.reasons -> fallback
function resolveRuleText(rule, fallback) {
    if (rule.reasonText) return rule.reasonText;
    if (rule.reason && texts.reasons[rule.reason]) return texts.reasons[rule.reason];
    return fallback;
}

/**
 * @param {object} schedule  { enabled, mode, defaultReasonText, rules, exceptions }
 * @param {string} timezone  IANA timezone
 * @param {Date}   now
 * @returns {{ active: boolean, reason: string, ruleIndex: number, exception: object|null, time: string }}
 *          ruleIndex points into schedule.rules (weekly) and is -1 otherwise
 */
function checkSchedule(schedule, timezone, now = new Date()) {
    const local = getLocalTime(timezone, now);
    const todayException = findException(schedule, local.date);
    const defaultText = todayException?.reasonText || schedule.defaultReasonText || texts.reasons.busy;
    const base = { time: local.label, exception: todayException, ruleIndex: -1 };

    if (!schedule.enabled) return { ...base, active: false, reason: defaultText };
    if (schedule.mode === 'always') return { ...base, active: true, reason: defaultText };

    const slot = findActiveSlot(schedule, local);
    if (slot) {
        const fallback = slot.exception?.reasonText || schedule.defaultReasonText || texts.reasons.busy;
        return {
            ...base,
            active: true,
            reason: resolveRuleText(slot.rule, fallback),
            ruleIndex: slot.exception ? -1 : slot.index,
            exception: slot.exception
        };
    }

    // "schedule" -> still active with the default text, "strict" -> silent outside slots
    return { ...base, active: schedule.mode !== 'strict', reason: defaultText };
}

// ---------- Validation (used for AI-generated schedules) ----------

function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('slot is not an object');
    const start = normalizeTime(raw.start);
    const end = normalizeTime(raw.end, { isEnd: true });
    if (!start || !end || start === end) throw new Error(`bad slot time "${raw.start}-${raw.end}"`);
    const rule = { start, end };
    const days = normalizeDays(raw.days);
    if (days.length) rule.days = days;
    const text = String(raw.reasonText ?? '').trim().slice(0, 200);
    if (text) rule.reasonText = text;
    return rule;
}

function normalizeException(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('exception is not an object');
    const from = String(raw.from ?? '').trim();
    const to = String(raw.to ?? raw.from ?? '').trim();
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        throw new Error(`bad exception dates "${raw.from}".."${raw.to}"`);
    }
    if (from > to) throw new Error(`exception ends before it starts (${from} > ${to})`);
    const exception = {
        from,
        to,
        label: String(raw.label ?? '').trim().slice(0, 60) || `${from} – ${to}`,
        rules: (Array.isArray(raw.rules) ? raw.rules : []).map(normalizeRule)
    };
    const text = String(raw.reasonText ?? '').trim().slice(0, 200);
    if (text) exception.reasonText = text;
    return exception;
}

/**
 * Validates and cleans a schedule (rules + exceptions + optional mode/default text).
 * Throws an Error with a readable message if something is invalid.
 */
function normalizeSchedule(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('schedule is not an object');
    const result = {
        rules: (Array.isArray(raw.rules) ? raw.rules : []).map(normalizeRule),
        exceptions: (Array.isArray(raw.exceptions) ? raw.exceptions : []).map(normalizeException)
            .sort((a, b) => a.from.localeCompare(b.from))
    };
    if (['always', 'schedule', 'strict'].includes(raw.mode)) result.mode = raw.mode;
    const defaultText = String(raw.defaultReasonText ?? '').trim().slice(0, 200);
    if (defaultText) result.defaultReasonText = defaultText;
    return result;
}

module.exports = {
    DAYS,
    checkSchedule,
    getLocalTime,
    isInSlot,
    parseRange,
    normalizeTime,
    normalizeDays,
    normalizeSchedule,
    resolveRuleText
};
