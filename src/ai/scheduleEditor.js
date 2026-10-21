// ------------------------------
// scheduleEditor.js - turns a free-text request ("only sleep every day 21:30-7:00")
// into a new schedule JSON. The result is validated and never applied
// automatically: the owner confirms it in the panel.
// ------------------------------

const config = require('../../config/config');
const { client, extraParams, stripThink } = require('./openai');
const { normalizeSchedule } = require('../utils/scheduleChecker');

const EDITOR_PROMPT = `
You edit the auto-reply schedule of a Telegram assistant. The owner describes changes in free text
(any language). You return the COMPLETE new schedule as JSON - nothing else.

FORMAT:
{
  "rules": [                                   // weekly time slots when the owner is unavailable
    { "start": "HH:MM", "end": "HH:MM",        // 24h; end may be "24:00"; end < start = crosses midnight
      "days": ["mon","tue","wed","thu","fri","sat","sun"],   // omit or [] = every day
      "reasonText": "short status shown to people, e.g. Sleeping 🌙" }
  ],
  "exceptions": [                              // one-off date periods (holidays, vacation, trips)
    { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "label": "Winter holidays",
      "reasonText": "default status during this period (optional)",
      "rules": [ ...slots used INSTEAD of the weekly rules on these dates; [] = no slots ] }
  ],
  "defaultReasonText": "optional, status when no slot matches",
  "mode": "optional: always | schedule | strict",
  "note": "one short sentence for the owner in THEIR language: assumptions you made or questions"
}

RULES:
- Start from the CURRENT schedule and change only what the owner asked. Keep everything else exactly as is.
- "delete everything / only X" means: remove all other rules (and exceptions only if they say so).
- "every day" = omit "days". "weekdays" = mon-fri. "weekends" = sat, sun.
- A night slot like 21:30-07:00 is ONE rule (it crosses midnight), not two.
- Resolve relative dates ("next week", "this summer", "from the 20th") using TODAY below.
- Write reasonText in the same language as the existing texts, or the owner's language if there are none.
- Output valid JSON only. No markdown, no comments.

EXAMPLE
Current: {"rules":[{"start":"23:00","end":"07:00","reasonText":"Sleeping 🌙"},{"start":"08:00","end":"15:00","days":["mon","tue","wed","thu","fri"],"reasonText":"At school 📚"}],"exceptions":[]}
Request: "school is off from 22 dec to 6 jan, I sleep until 11 then"
Answer: {"rules":[{"start":"23:00","end":"07:00","reasonText":"Sleeping 🌙"},{"start":"08:00","end":"15:00","days":["mon","tue","wed","thu","fri"],"reasonText":"At school 📚"}],"exceptions":[{"from":"2026-12-22","to":"2027-01-06","label":"Winter holidays","rules":[{"start":"23:00","end":"11:00","reasonText":"Sleeping 🌙"}]}],"note":"Added winter holidays without school; sleep until 11:00."}
`.trim();

// Pulls the first {...} block out of a model answer (handles ```json fences and chatter)
function extractJson(text) {
    const clean = stripThink(text);
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('the model did not return JSON');
    return JSON.parse(clean.slice(start, end + 1));
}

async function complete(messages, useJsonMode) {
    const response = await client.chat.completions.create({
        model: config.model,
        messages,
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...extraParams()
    }, { timeout: 120_000, maxRetries: 0 });
    return response.choices?.[0]?.message?.content || '';
}

/**
 * @param {object} params
 * @param {object} params.current   current schedule { mode, defaultReasonText, rules, exceptions }
 * @param {string} params.request   owner's free-text request
 * @param {{ date: string, weekday: string, label: string }} params.local  local "now"
 * @returns {Promise<{ schedule: object, note: string }>}
 */
async function proposeSchedule({ current, request, local }) {
    const messages = [
        { role: 'system', content: EDITOR_PROMPT },
        {
            role: 'user',
            content: [
                `TODAY: ${local.date} (${local.weekday}), time ${local.label}, timezone ${config.timezone}`,
                `CURRENT: ${JSON.stringify(current)}`,
                `REQUEST: ${request}`
            ].join('\n')
        }
    ];

    let answer;
    try {
        answer = await complete(messages, true);
    } catch (err) {
        // Some OpenAI-compatible servers don't support response_format -> plain retry
        if (err?.status !== 400) throw err;
        answer = await complete(messages, false);
    }

    const raw = extractJson(answer);
    return {
        schedule: normalizeSchedule(raw),
        note: String(raw.note ?? '').trim().slice(0, 500)
    };
}

module.exports = { proposeSchedule };
