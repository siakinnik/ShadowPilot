// Small text helpers shared by handlers and the admin panel.

const TELEGRAM_MAX_LENGTH = 4096;

// Escapes text for Telegram HTML parse mode
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Replaces {placeholders} in a template. Values are inserted as-is,
// so escape them beforehand when the template is HTML.
function fill(template, values = {}) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    );
}

// Returns `head + escaped(body) + tail` cut so it never exceeds Telegram's limit.
// Cuts the raw body (not the escaped one) so we never split an HTML entity.
function fitMessage(head, body, tail = '') {
    const budget = TELEGRAM_MAX_LENGTH - head.length - tail.length;
    let raw = body;
    let escaped = escapeHtml(raw);
    while (escaped.length > budget && raw.length > 0) {
        raw = raw.slice(0, raw.length - Math.max(1, escaped.length - budget) - 1);
        escaped = escapeHtml(raw) + '…';
    }
    return head + escaped + tail;
}

module.exports = { escapeHtml, fill, fitMessage, TELEGRAM_MAX_LENGTH };
