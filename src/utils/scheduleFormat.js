// ------------------------------
// scheduleFormat.js - human-readable schedule lines and the diff
// between the current schedule and an AI proposal (computed locally,
// so the owner sees exactly what will change, not what the AI claims).
// ------------------------------

const texts = require('../../config/texts.json');
const { DAYS, resolveRuleText } = require('./scheduleChecker');
const { escapeHtml, fill } = require('./text');

const T = texts.panel;

// ["mon".."fri"] -> "Mon–Fri", [] -> "Every day"
function daysLabel(days) {
    const list = Array.isArray(days) ? days : [];
    if (list.length === 0 || list.length === 7) return T.days_every;
    const key = list.join(',');
    if (key === 'mon,tue,wed,thu,fri') return T.days_weekdays;
    if (key === 'sat,sun') return T.days_weekends;
    return list.map(day => T.day_names[DAYS.indexOf(day)]).join(', ');
}

// "Every day · 21:30–07:00 · Sleeping 🌙" (HTML-escaped)
function ruleLine(rule, fallbackText) {
    return fill(T.rule_short, {
        days: daysLabel(rule.days),
        start: rule.start,
        end: rule.end,
        text: escapeHtml(resolveRuleText(rule, fallbackText))
    });
}

function exceptionLine(exc) {
    return fill(T.exception_short, {
        label: escapeHtml(exc.label),
        from: exc.from,
        to: exc.to
    });
}

// Exception header + its slots, one per line
function exceptionBlock(exc, fallbackText) {
    const lines = [exceptionLine(exc)];
    if (exc.reasonText) lines.push(`   ${fill(T.exception_reason, { text: escapeHtml(exc.reasonText) })}`);
    if (exc.rules.length === 0) lines.push(`   ${T.exception_no_slots}`);
    for (const rule of exc.rules) lines.push(`   • ${ruleLine(rule, exc.reasonText || fallbackText)}`);
    return lines.join('\n');
}

// Stable key for comparing slots / exceptions
const ruleKey = rule => JSON.stringify([rule.start, rule.end, (rule.days || []).join(','), rule.reasonText || rule.reason || '']);
const excKey = exc => JSON.stringify([exc.from, exc.to, exc.label, exc.reasonText || '', exc.rules.map(ruleKey)]);

/**
 * Builds the list of changes between two schedules.
 * @returns {{ lines: string[], changed: boolean }}
 */
function diffSchedules(current, next) {
    const lines = [];
    const fallback = next.defaultReasonText || current.defaultReasonText;

    const currentRules = current.rules || [];
    const nextRules = next.rules || [];
    const nextKeys = new Set(nextRules.map(ruleKey));
    const currentKeys = new Set(currentRules.map(ruleKey));
    const removed = currentRules.filter(rule => !nextKeys.has(ruleKey(rule)));
    const added = nextRules.filter(rule => !currentKeys.has(ruleKey(rule)));

    if (removed.length > 0 && removed.length === currentRules.length && currentRules.length > 1) {
        lines.push(T.diff_remove_all);
    } else {
        for (const rule of removed) lines.push(`➖ ${ruleLine(rule, fallback)}`);
    }
    for (const rule of added) lines.push(`➕ ${ruleLine(rule, fallback)}`);

    const currentExc = current.exceptions || [];
    const nextExc = next.exceptions || [];
    const nextExcKeys = new Set(nextExc.map(excKey));
    const currentExcKeys = new Set(currentExc.map(excKey));
    for (const exc of currentExc.filter(e => !nextExcKeys.has(excKey(e)))) lines.push(`➖ ${exceptionLine(exc)}`);
    for (const exc of nextExc.filter(e => !currentExcKeys.has(excKey(e)))) lines.push(`➕ ${exceptionBlock(exc, fallback)}`);

    if (next.defaultReasonText && next.defaultReasonText !== current.defaultReasonText) {
        lines.push(fill(T.diff_default, { text: escapeHtml(next.defaultReasonText) }));
    }
    if (next.mode && next.mode !== current.mode) {
        lines.push(fill(T.diff_mode, { mode: T[`mode_${next.mode}`] || next.mode }));
    }

    return { lines, changed: lines.length > 0 };
}

module.exports = { daysLabel, ruleLine, exceptionLine, exceptionBlock, diffSchedules };
