// ------------------------------
// time.js - date/time formatting in the owner's timezone
// ------------------------------

const config = require('../../config/config');

function parts(unixSeconds) {
    const options = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    let formatter;
    try {
        formatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: config.timezone });
    } catch {
        formatter = new Intl.DateTimeFormat('en-GB', options);
    }
    const list = formatter.formatToParts(new Date(unixSeconds * 1000));
    const get = type => list.find(p => p.type === type).value;
    return { date: `${get('day')}.${get('month')}`, time: `${get('hour')}:${get('minute')}` };
}

// 1791489476 -> "09.10 14:03"
function formatDateTime(unixSeconds) {
    const p = parts(unixSeconds);
    return `${p.date} ${p.time}`;
}

// Same day -> "09.10 14:03–15:20", otherwise "09.10 23:50 – 10.10 00:20"
function formatRange(fromSeconds, toSeconds) {
    const a = parts(fromSeconds);
    const b = parts(toSeconds);
    if (a.date === b.date) return a.time === b.time ? `${a.date} ${a.time}` : `${a.date} ${a.time}–${b.time}`;
    return `${a.date} ${a.time} – ${b.date} ${b.time}`;
}

module.exports = { formatDateTime, formatRange };
