// Parses a comma/space separated list of ids from .env into an array of numbers.
// "123, 456 789" -> [123, 456, 789]. Invalid entries are skipped.
function parseToNumberArray(value) {
    if (!value) return [];
    return String(value)
        .split(/[\s,;]+/)
        .map(item => Number(item.trim()))
        .filter(num => Number.isFinite(num) && num !== 0);
}

module.exports = { parseToNumberArray };
