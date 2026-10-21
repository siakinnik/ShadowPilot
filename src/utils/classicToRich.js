// ------------------------------
// classicToRich.js - converts classic Telegram HTML (lines separated by "\n",
// inline tags only) into rich message HTML: one <p> per line, "━━━" lines
// become <hr/>, <pre> and <blockquote> stay blocks.
// Used for everything the bot sends to the owner (panel, notifications).
// ------------------------------

const DIVIDER_RE = /^[━─—=_-]{5,}$/;

// Splits HTML into top-level chunks: block elements that may span lines
// (<pre>, <blockquote>) are kept whole, everything else is split by "\n"
function chunks(html) {
    const parts = [];
    const blockRe = /<(pre|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi;
    let last = 0;
    let match;
    while ((match = blockRe.exec(html))) {
        parts.push(...html.slice(last, match.index).split('\n').map(line => ({ line })));
        parts.push({ block: match[0], tag: match[1].toLowerCase() });
        last = match.index + match[0].length;
    }
    parts.push(...html.slice(last).split('\n').map(line => ({ line })));
    return parts;
}

/**
 * @param {string} html classic Telegram HTML
 * @returns {string} rich HTML
 */
function classicToRich(html) {
    const out = [];
    let paragraph = []; // inline pieces of the current line(s)

    const flush = () => {
        const text = paragraph.join('').trim();
        if (text) out.push(`<p>${text}</p>`);
        paragraph = [];
    };

    for (const part of chunks(String(html ?? ''))) {
        if (part.block) {
            // A quote/code block that sits inside a line ends the paragraph before it
            flush();
            if (part.tag === 'pre' && !/<code\b/i.test(part.block)) {
                out.push(part.block.replace(/^<pre[^>]*>/i, '<pre><code>').replace(/<\/pre>$/i, '</code></pre>'));
            } else {
                out.push(part.block);
            }
            continue;
        }
        // A new line starts a new paragraph
        flush();
        const line = part.line.trim();
        if (!line) continue;
        if (DIVIDER_RE.test(line)) {
            out.push('<hr/>');
            continue;
        }
        paragraph.push(line);
    }
    flush();
    return out.join('');
}

module.exports = { classicToRich };
