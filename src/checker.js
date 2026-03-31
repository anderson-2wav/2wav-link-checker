'use strict';

/**
 * Check a single URL via HEAD (with GET fallback).
 * Returns a result object.
 */
async function checkUrl(url, opts = {}) {
  const {
    timeout = 10000,
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    maxRedirects = 10,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const fetchOpts = {
    headers: { 'User-Agent': userAgent },
    redirect: 'follow',
    signal: controller.signal,
  };

  const start = Date.now();

  async function attempt(method) {
    const res = await fetch(url, { ...fetchOpts, method });
    const elapsed = Date.now() - start;
    // Collect redirect chain via node-fetch's res.url (final URL after redirects)
    const redirectUrl = res.url !== url ? res.url : null;
    return {
      url,
      status: res.status,
      redirectUrl,
      responseTime: elapsed,
      error: null,
    };
  }

  try {
    let result = await attempt('HEAD');
    // hypothesis, illinois.gov returns 404 on HEAD
    // Retry with GET if HEAD is unreliable
    if (result.status === 404 || result.status === 405 || result.status === 501) {
      result = await attempt('GET');
    }
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    let errorType;
    if (err.name === 'AbortError' || err.type === 'aborted') {
      errorType = 'Timeout';
    } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      errorType = 'DNS Error';
    } else if (err.code === 'ECONNREFUSED') {
      errorType = 'Connection Refused';
    } else if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.message.includes('SSL')) {
      errorType = 'SSL Error';
    } else {
      errorType = `Error: ${err.message.slice(0, 80)}`;
    }
    return {
      url,
      status: null,
      redirectUrl: null,
      responseTime: elapsed,
      error: errorType,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a result into a category.
 */
function classify(result) {
  if (result.error) {
    if (result.error === 'Timeout') return 'timeout';
    return 'error';
  }
  const s = result.status;
  if (s >= 200 && s < 300) return 'ok';
  if (s >= 300 && s < 400) return 'redirect';
  return 'broken'; // 4xx, 5xx
}

/**
 * Check an array of unique URLs with concurrency control.
 * Returns a Map<url, result>.
 *
 * @param {string[]} urls
 * @param {object} opts
 * @param {number} opts.concurrency        - Max simultaneous requests across all domains
 * @param {number} opts.domainConcurrency  - Max simultaneous requests to any single domain (politeness cap)
 * @param {number} opts.timeout
 * @param {string} opts.userAgent
 * @param {object} opts.cache - LinkCache instance (optional)
 * @param {function} opts.onProgress - called after each check with (checked, total, brokenCount)
 */
async function checkUrls(urls, opts = {}) {
  const { concurrency = 10, domainConcurrency = 2, domainDelay = 0, onProgress, cache, ...checkOpts } = opts;
  const pLimit = (await import('p-limit')).default;
  const globalLimit = pLimit(concurrency);

  // Lazily create one p-limit instance per hostname
  const domainLimiters = new Map();
  function getDomainLimit(url) {
    let hostname;
    try { hostname = new URL(url).hostname; }
    catch { hostname = '__invalid__'; }
    if (!domainLimiters.has(hostname)) {
      domainLimiters.set(hostname, pLimit(domainConcurrency));
    }
    return domainLimiters.get(hostname);
  }

  const results = new Map();
  let checked = 0;
  let broken = 0;

  await Promise.all(
    urls.map(url =>
      globalLimit(async () => {
        // Cache hits bypass the domain limiter — no HTTP request made
        const cached = cache?.get(url);
        if (cached) {
          results.set(url, cached);
          checked++;
          if (onProgress) onProgress(checked, urls.length, broken);
          return;
        }

        // Real HTTP request: respect per-domain concurrency cap and delay
        const result = await getDomainLimit(url)(async () => {
          const r = await checkWithRetry(url, checkOpts);
          if (domainDelay > 0) await new Promise(res => setTimeout(res, domainDelay));
          return r;
        });
        cache?.set(url, result);
        results.set(url, result);
        checked++;
        const cat = classify(result);
        if (cat === 'broken' || cat === 'error' || cat === 'timeout') broken++;
        if (onProgress) onProgress(checked, urls.length, broken);
      })
    )
  );

  return results;
}

/**
 * Check a URL with one retry on transient failures.
 */
async function checkWithRetry(url, opts = {}) {
  const result = await checkUrl(url, opts);
  // Retry on timeout or 429
  if (result.error === 'Timeout' || result.status === 429) {
    if (result.status === 429) {
      // Minimal back-off — don't block the whole queue for too long
      await new Promise(r => setTimeout(r, 2000));
    }
    return checkUrl(url, opts);
  }
  return result;
}

module.exports = { checkUrls, classify };
