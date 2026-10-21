// ------------------------------
// telegramRetry.js - Telegram API calls that survive network hiccups.
// After the bot has been idle, a pooled keep-alive socket may already be
// closed by Telegram and the next request fails with "fetch failed".
// Such network errors are retried with a short backoff.
// ------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Network-level failure: no HTTP response from Telegram at all
function isNetworkError(err) {
    if (!err || err.response) return false;
    return /fetch failed|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|other side closed/i.test(
        `${err.message} ${err.code || ''} ${err.cause?.code || ''} ${err.cause?.message || ''}`
    );
}

/**
 * telegram.callApi with retries on network errors.
 * @param {object} telegram  telegraf Telegram instance
 * @param {string} method
 * @param {object} payload
 * @param {number} [attempts=4]
 */
async function callApiRetry(telegram, method, payload, attempts = 4) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await telegram.callApi(method, payload);
        } catch (err) {
            if (!isNetworkError(err) || attempt >= attempts) throw err;
            await sleep(500 * attempt);
        }
    }
}

module.exports = { callApiRetry };
