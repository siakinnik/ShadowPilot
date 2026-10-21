// ------------------------------
// markdownToRich.js - converts the Markdown that models usually write into
// rich message HTML (<p>, <h3>, <ul>, <blockquote>, <pre>, <table>, <hr/>).
// Works on partial text too (streaming): unfinished markup stays as plain text.
// ------------------------------

const { escapeHtml } = require('./text');

// Inline markup on already escaped text. Code spans are cut out first so
// nothing inside them is touched.
function inline(raw) {
    const codes = [];
    let text = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_, code) => {
        codes.push(code);
        return `\u0000${codes.length - 1}\u0000`;
    });
    text = text
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`)
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/__([^_\n]+)__/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s.,!?:;)])/g, '$1<i>$2</i>')
        .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=$|[\s.,!?:;)])/g, '$1<i>$2</i>')
        .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
        .replace(/\|\|([^|\n]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const isTableRow = line => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

/**
 * @param {string} markdown
 * @returns {string} rich HTML
 */
function markdownToRich(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let list = null; // { tag: 'ul'|'ol', items: [] }

    const closeList = () => {
        if (!list) return;
        out.push(`<${list.tag}>${list.items.map(item => `<li>${item}</li>`).join('')}</${list.tag}>`);
        list = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Fenced code block (an unclosed fence at the end = code still streaming)
        if (/^```/.test(trimmed)) {
            closeList();
            const code = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
            out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }

        if (!trimmed) {
            closeList();
            continue;
        }

        // Table: header row + separator + rows
        if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
            closeList();
            const header = cells(line);
            const rows = [];
            i += 2;
            while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
            i--;
            const th = header.map(cell => `<th>${inline(cell)}</th>`).join('');
            const tds = rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('');
            out.push(`<table><tr>${th}</tr>${tds}</table>`);
            continue;
        }

        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
            closeList();
            out.push('<hr/>');
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (heading) {
            closeList();
            // Keep headings modest: # -> h3 ... ###### -> h6
            const size = Math.min(6, heading[1].length + 2);
            out.push(`<h${size}>${inline(heading[2])}</h${size}>`);
            continue;
        }

        const quote = /^>\s?(.*)$/.exec(trimmed);
        if (quote) {
            closeList();
            const parts = [quote[1]];
            while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) parts.push(lines[++i].trim().replace(/^>\s?/, ''));
            out.push(`<blockquote>${parts.map(inline).join('\n')}</blockquote>`);
            continue;
        }

        const bullet = /^[-*+•]\s+(.*)$/.exec(trimmed);
        const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
        if (bullet || numbered) {
            const tag = bullet ? 'ul' : 'ol';
            if (!list || list.tag !== tag) {
                closeList();
                list = { tag, items: [] };
            }
            list.items.push(inline((bullet || numbered)[1]));
            continue;
        }

        closeList();
        out.push(`<p>${inline(trimmed)}</p>`);
    }
    closeList();
    return out.join('');
}

module.exports = { markdownToRich };
