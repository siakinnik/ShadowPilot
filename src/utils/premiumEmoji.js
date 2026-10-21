// ------------------------------
// premiumEmoji.js - swaps regular emoji for custom (premium) emoji in HTML messages.
// The owner defines pairs in the panel: "🤖 -> <custom emoji>". When the account
// has Telegram Premium, every "🤖" in outgoing messages becomes
// <tg-emoji emoji-id="...">🤖</tg-emoji>; otherwise the text is left as is.
// ------------------------------

const VS16 = '️'; // emoji variation selector, may or may not be present in text

const stripVs = text => text.replace(/️/g, '');
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parses the owner's message with pairs, one per line:
 *   "<regular emoji> <custom emoji>"  -> add / replace a pair
 *   "<regular emoji>"                 -> remove the pair
 * @param {string} text      message text
 * @param {object[]} entities message entities (custom_emoji ones matter)
 * @returns {{ set: Record<string, {id: string, alt: string}>, remove: string[] }}
 */
function parsePairs(text, entities = []) {
    const custom = entities.filter(entity => entity.type === 'custom_emoji');
    const result = { set: {}, remove: [] };
    let offset = 0;
    for (const line of text.split('\n')) {
        const start = offset;
        const end = offset + line.length;
        offset = end + 1;
        const inLine = custom.filter(entity => entity.offset >= start && entity.offset < end);

        if (inLine.length === 0) {
            const key = stripVs(line.trim());
            if (key && key.length <= 16 && !/[\p{L}\p{N}]/u.test(key)) result.remove.push(key);
            continue;
        }
        // Key = what stands before the first custom emoji; if nothing, the custom emoji's own fallback
        const first = inLine[0];
        const alt = text.slice(first.offset, first.offset + first.length);
        const key = stripVs(text.slice(start, first.offset).trim()) || stripVs(alt);
        if (!key || key.length > 16 || /[\p{L}\p{N}<>&]/u.test(key)) continue;
        result.set[key] = { id: String(first.custom_emoji_id), alt };
    }
    return result;
}

/**
 * Replaces mapped emoji in the text parts of an HTML string (tags are left untouched).
 * @param {string} html
 * @param {Record<string, {id: string, alt: string}>} map
 */
function premiumize(html, map) {
    const keys = Object.keys(map || {}).sort((a, b) => b.length - a.length);
    if (keys.length === 0) return html;
    const pattern = new RegExp(`(${keys.map(key => [...key].map(escapeRegex).join(`${VS16}?`)).join('|')})${VS16}?`, 'gu');
    // Text that is already inside <tg-emoji> must not be wrapped a second time
    let insideCustom = false;
    return html
        .split(/(<[^>]+>)/)
        .map(part => {
            if (part.startsWith('<')) {
                if (/^<tg-emoji\b/i.test(part)) insideCustom = true;
                else if (/^<\/tg-emoji>/i.test(part)) insideCustom = false;
                return part;
            }
            if (insideCustom) return part;
            return part.replace(pattern, match => {
                const entry = map[stripVs(match)];
                return entry ? `<tg-emoji emoji-id="${entry.id}">${entry.alt}</tg-emoji>` : match;
            });
        })
        .join('');
}

module.exports = { parsePairs, premiumize };
