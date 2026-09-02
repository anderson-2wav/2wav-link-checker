#!/usr/bin/env node
// Copyright (c) 2026 2wav Inc. AGPL-3.0-only.
'use strict';

const { program } = require('commander');
const { chromium } = require('playwright');
const { fetchSitemap } = require('./sitemap');
const { extractLinks } = require('./extractor');
const { checkUrls, classify } = require('./checker');
const { writeReports } = require('./report');
const { formatDuration } = require('./utils');
const { LinkCache } = require('./cache');

const BOT_BLOCKED_DOMAINS = new Set([
  'facebook.com', 'fb.com', 'instagram.com',
  'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com',
]);

program
  .name('link-checker')
  .argument('<sitemap-url>', 'URL of the XML sitemap to scan')
  .option('-o, --output <path>', 'Output file path (no extension)', './broken-link-report')
  .option('-f, --format <format>', 'Output format: csv, html, both', 'both')
  .option('-c, --concurrency <n>', 'Pages to process in parallel', parseInt, 3)
  .option('--link-concurrency <n>', 'Links to check in parallel', parseInt, 10)
  .option('--domain-concurrency <n>', 'Max concurrent requests per domain (politeness cap)', parseInt, 2)
  .option('--domain-delay <ms>', 'Delay between consecutive requests to the same domain in ms', parseInt, 0)
  .option('--filter <regex>', 'Regex to filter page URLs from sitemap')
  .option('--timeout <ms>', 'Page load timeout in ms', parseInt, 30000)
  .option('--link-timeout <ms>', 'Per-link check timeout in ms', parseInt, 10000)
  .option('--wait <ms>', 'Additional wait after page load in ms', parseInt, 2000)
  .option('--all-resources', 'Check all resource links, not just anchors and images')
  .option('--internal-only', 'Only check internal links')
  .option('--external-only', 'Only check external links')
  .option('--include-redirects', 'Include 3xx redirects in the report')
  .option('--summary', 'Report one row per unique link instead of one per page occurrence')
  .option('-v, --verbose', 'Print detailed progress to console')
  .option('--user-agent <ua>', 'Custom User-Agent string')
  .option('--cache <path>', 'Path to persistent known-good URL cache file', '.link-checker-cache.json')
  .option('--no-cache', 'Disable the persistent cache for this run')
  .option('--cache-max-age <days>', 'Max age of cached results in days', parseFloat, 7)
  .option('--ignore-domains <list>', 'Comma-separated extra domains to skip (e.g. facebook.com,linkedin.com)')
  .option('--no-skip-bot-domains', 'Disable the built-in bot-hostile domain skip list')
  .parse();

const [sitemapUrl] = program.args;
const opts = program.opts();

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

function logVerbose(...args) {
  if (opts.verbose) log(...args);
}

function pad(n, total) {
  return String(n).padStart(String(total).length, ' ');
}

/**
 * Re-check a URL using a real Playwright browser context.
 * Used as a fallback for URLs that returned 403 via fetch, which may be
 * bot-detection blocks that a real browser can pass (TLS fingerprint, JS challenges, cookies).
 */
async function verifyUrlWithPlaywright(browser, url, opts) {
  const contextOpts = { ignoreHTTPSErrors: true };
  if (opts.userAgent) contextOpts.userAgent = opts.userAgent;
  const timeout = opts.linkTimeout ?? 15000;

  let context, page;
  const start = Date.now();
  try {
    context = await browser.newContext(contextOpts);
    page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const elapsed = Date.now() - start;
    const status = response?.status() ?? null;
    const finalUrl = page.url();
    // Walk the chain backwards so the first hop's status is what we keep,
    // matching what checkUrl records for a fetch-level redirect.
    let redirectStatus = null;
    let redirectCount = 0;
    let hop = response?.request().redirectedFrom();
    while (hop) {
      redirectCount++;
      const hopResponse = await hop.response();
      if (hopResponse) redirectStatus = hopResponse.status();
      hop = hop.redirectedFrom();
    }
    return {
      url,
      status,
      redirectUrl: finalUrl !== url ? finalUrl : null,
      redirectStatus,
      redirectCount,
      responseTime: elapsed,
      serverSig: null,
      error: null,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      url,
      status: null,
      redirectUrl: null,
      redirectStatus: null,
      redirectCount: 0,
      responseTime: elapsed,
      serverSig: null,
      error: `Error: ${err.message.slice(0, 80)}`,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

async function main() {
  const startTime = Date.now();
  const filter = opts.filter ? new RegExp(opts.filter) : null;

  // Load persistent cache
  const cachePath = opts.cache !== false ? opts.cache : null;
  const cache = new LinkCache(cachePath, opts.cacheMaxAge * 24 * 60 * 60 * 1000);
  cache.load();
  if (cachePath) log(`[Cache]   Loaded ${cache.size} known-good URLs from ${cachePath}`);

  // Phase 1 – Fetch sitemap
  log('[Sitemap] Fetching', sitemapUrl);
  let pages;
  try {
    pages = await fetchSitemap(sitemapUrl, filter);
  } catch (err) {
    process.stderr.write(`[Error] Failed to fetch sitemap: ${err.message}\n`);
    process.exit(1);
  }

  if (pages.length === 0) {
    log('[Sitemap] No pages found. Check your sitemap URL or --filter pattern.');
    process.exit(0);
  }
  log(`[Sitemap] Found ${pages.length} pages`);

  // Determine base domain for internal/external classification
  const sitemapDomain = new URL(sitemapUrl).origin;

  // Phase 1 – Extract links
  const pLimit = (await import('p-limit')).default;
  const pageLimit = pLimit(opts.concurrency);

  const browser = await chromium.launch({ headless: true });
  const pageResults = new Map(); // pageUrl -> { links, error }

  // Global link dedup map: url -> Set of { text, type, internal } (first seen wins for text)
  const allLinksMap = new Map(); // url -> { text, type, internal }

  // Graceful shutdown on Ctrl+C
  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('\n[Shutdown] Writing partial report…');
    await browser.close().catch(() => {});
    await finalize(pageResults, allLinksMap, startTime, cache, true);
    process.exit(0);
  });

  let pagesDone = 0;
  const extractOpts = {
    timeout: opts.timeout,
    wait: opts.wait,
    allResources: opts.allResources || false,
    sitemapDomain,
    userAgent: opts.userAgent,
  };

  await Promise.all(
    pages.map(pageUrl =>
      pageLimit(async () => {
        if (shuttingDown) return;
        const idx = ++pagesDone;
        logVerbose(`[Scan]    [${pad(idx, pages.length)}/${pages.length}] Extracting links from ${pageUrl}`);

        const result = await extractLinks(browser, pageUrl, extractOpts);
        pageResults.set(pageUrl, result);

        if (result.error) {
          log(`[Scan]    [${pad(idx, pages.length)}/${pages.length}] ERROR loading ${pageUrl}: ${result.error}`);
          return;
        }

        // Register all links in the global map (first-seen text wins)
        for (const link of result.links) {
          if (!allLinksMap.has(link.url)) {
            allLinksMap.set(link.url, { text: link.text, type: link.type, internal: link.internal });
          }
        }

        const internal = result.links.filter(l => l.internal).length;
        const external = result.links.filter(l => !l.internal).length;
        logVerbose(`[Scan]    [${pad(idx, pages.length)}/${pages.length}] Found ${result.links.length} links (${internal} internal, ${external} external)`);
      })
    )
  );

  // Keep browser open — finalize uses it for Playwright verification of 403s, then closes it
  await finalize(pageResults, allLinksMap, startTime, cache, false, browser);
}

async function finalize(pageResults, allLinksMap, startTime, cache, partial, browser = null) {
  // Apply scope filter
  const opts2 = program.opts();
  let urlsToCheck = [...allLinksMap.keys()];

  if (opts2.internalOnly) {
    urlsToCheck = urlsToCheck.filter(u => allLinksMap.get(u)?.internal);
  } else if (opts2.externalOnly) {
    urlsToCheck = urlsToCheck.filter(u => !allLinksMap.get(u)?.internal);
  }

  // Apply bot-blocked domain skip list
  const skipSet = opts2.skipBotDomains !== false
    ? new Set([...BOT_BLOCKED_DOMAINS, ...(opts2.ignoreDomains ? opts2.ignoreDomains.split(',').map(d => d.trim()) : [])])
    : new Set(opts2.ignoreDomains ? opts2.ignoreDomains.split(',').map(d => d.trim()) : []);

  const skippedUrls = [];
  urlsToCheck = urlsToCheck.filter(u => {
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      if (skipSet.has(host)) { skippedUrls.push(u); return false; }
    } catch { /* malformed URL — leave it to be checked */ }
    return true;
  });
  if (skippedUrls.length > 0) {
    log(`[Check]   Skipping ${skippedUrls.length} URLs on bot-blocked domains`);
  }

  // Count internal/external among urls being checked
  const internalCount = urlsToCheck.filter(u => allLinksMap.get(u)?.internal).length;
  const externalCount = urlsToCheck.filter(u => !allLinksMap.get(u)?.internal).length;

  const cachedCount = urlsToCheck.filter(u => cache?.get(u)).length;
  log(`[Check]   Checking ${urlsToCheck.length.toLocaleString()} unique links (${cachedCount} from cache)…${partial ? ' (partial)' : ''}`);

  let lastReported = 0;
  const checkResults = await checkUrls(urlsToCheck, {
    concurrency: opts2.linkConcurrency,
    domainConcurrency: opts2.domainConcurrency,
    domainDelay: opts2.domainDelay,
    timeout: opts2.linkTimeout,
    userAgent: opts2.userAgent,
    cache,
    onProgress(checked, total, broken) {
      // Log every 100 or at end
      const milestone = Math.floor(checked / 100) * 100;
      if (milestone > lastReported || checked === total) {
        lastReported = milestone;
        log(`[Check]   [${String(checked).padStart(String(total).length, ' ')}/${total}] ${broken} broken so far…`);
      }
    },
  });

  // Phase 2b — Playwright verification for fetch-level 403s
  let verifySummary = null;
  if (browser && !partial) {
    const toVerify = [...checkResults.entries()]
      .filter(([, r]) => r.status === 403)
      .map(([url]) => url);

    if (toVerify.length > 0) {
      log(`[Verify]  Re-checking ${toVerify.length} blocked URL${toVerify.length === 1 ? '' : 's'} via browser…`);
      const pLimitVerify = (await import('p-limit')).default;
      const verifyLimit = pLimitVerify(3);
      let verified = 0;
      await Promise.all(
        toVerify.map(url =>
          verifyLimit(async () => {
            const result = await verifyUrlWithPlaywright(browser, url, opts2);
            checkResults.set(url, result);
            verified++;
            logVerbose(`[Verify]  [${String(verified).padStart(String(toVerify.length).length, ' ')}/${toVerify.length}] ${result.status ?? result.error} ${url}`);
          })
        )
      );
      const cleared = toVerify.filter(u => (checkResults.get(u)?.status ?? 0) < 400).length;
      verifySummary = { checked: toVerify.length, cleared };
    }
  }

  if (browser) await browser.close().catch(() => {});

  cache?.save();

  const duration = Date.now() - startTime;

  // Build summary stats
  let totalBroken = 0;
  let totalUncheckable = 0;
  for (const result of checkResults.values()) {
    const cat = classify(result);
    if (cat === 'broken' || cat === 'error' || cat === 'timeout') totalBroken++;
    if (cat === 'uncheckable') totalUncheckable++;
  }

  const summary = {
    pagesScanned: pageResults.size,
    uniqueLinks: allLinksMap.size,
    uniqueChecked: urlsToCheck.length,
    internalCount,
    externalCount,
    skippedUrls,
    duration,
    startTime: Date.now() - duration,
  };

  const { rows, written } = writeReports(pageResults, checkResults, summary, {
    output: opts2.output,
    format: opts2.format,
    includeRedirects: opts2.includeRedirects || false,
    summarize: opts2.summary || false,
  });

  log(`\n[Done]    Scan complete in ${formatDuration(duration)}`);
  log(`          ${pageResults.size} pages scanned`);
  log(`          ${urlsToCheck.length.toLocaleString()} unique links checked`);
  if (verifySummary) {
    log(`          ${verifySummary.cleared} of ${verifySummary.checked} fetch-level 403s cleared by browser verification`);
  }
  log(`          ${totalBroken} broken links found`);
  if (totalUncheckable > 0) {
    log(`          ${totalUncheckable} uncheckable (403 — bot-blocked or paywalled)`);
  }
  log(`          Report saved to ${written.join(' and ')}`);
}

main().catch(err => {
  process.stderr.write(`[Fatal] ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
