// Copyright (c) 2026 2wav Inc. AGPL-3.0-only.
'use strict';

const { resolveUrl, isInternal } = require('./utils');

/**
 * Extract all links from a rendered page using Playwright.
 *
 * @param {object} browser - Playwright browser instance
 * @param {string} pageUrl - URL to visit
 * @param {object} opts
 * @param {number} opts.timeout - page load timeout ms
 * @param {number} opts.wait - additional wait ms after load
 * @param {boolean} opts.allResources - also extract scripts, stylesheets, etc.
 * @param {string} opts.sitemapDomain - base domain for internal/external classification
 * @param {string} opts.userAgent
 * @returns {{ links: LinkRecord[], error: string|null }}
 */
async function extractLinks(browser, pageUrl, opts = {}) {
  const {
    timeout = 30000,
    wait = 2000,
    allResources = false,
    sitemapDomain = pageUrl,
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  } = opts;

  let context;
  let page;
  try {
    context = await browser.newContext({ userAgent, ignoreHTTPSErrors: true });
    page = await context.newPage();

    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout });
    } catch (navErr) {
      // If chromium already navigated to an error page, it's a hard failure — no retry
      if (page.url().startsWith('chrome-error://')) {
        return { links: [], error: navErr.message };
      }
      // Otherwise (e.g. networkidle timeout), retry with domcontentloaded
      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });
      } catch (e2) {
        return { links: [], error: e2.message };
      }
    }

    if (wait > 0) await page.waitForTimeout(wait);

    const rawLinks = await page.evaluate((includeAll) => {
      const results = [];

      // Anchors
      document.querySelectorAll('a[href]').forEach(el => {
        results.push({ href: el.href, text: el.textContent.trim().slice(0, 200), type: 'anchor' });
      });

      // Images — if srcset is present, use only its first URL (srcset entries are
      // alternatives for the same image, so checking one is sufficient and avoids
      // falsely flagging a src that the server never intends to serve alone).
      document.querySelectorAll('img').forEach(el => {
        const alt = el.alt || '';
        if (el.srcset) {
          const firstUrl = el.srcset.trim().split(',')[0].trim().split(/\s+/)[0];
          if (firstUrl) results.push({ href: firstUrl, text: alt, type: 'image' });
        } else if (el.src) {
          results.push({ href: el.src, text: alt, type: 'image' });
        }
      });

      if (includeAll) {
        document.querySelectorAll('script[src]').forEach(el => {
          results.push({ href: el.src, text: '', type: 'script' });
        });
        document.querySelectorAll('link[href]').forEach(el => {
          results.push({ href: el.href, text: '', type: 'stylesheet' });
        });
        document.querySelectorAll('source[src]').forEach(el => {
          results.push({ href: el.src, text: '', type: 'source' });
        });
        document.querySelectorAll('video[src],audio[src]').forEach(el => {
          results.push({ href: el.src, text: '', type: el.tagName.toLowerCase() });
        });
        document.querySelectorAll('iframe[src]').forEach(el => {
          results.push({ href: el.src, text: '', type: 'iframe' });
        });
      }

      return results;
    }, allResources);

    // Normalize and deduplicate. A URL used several times on one page is checked
    // once, but the repeat is counted — a reviewer needs to know a bad link
    // appears in the nav on every page, not just that the page contains it.
    const byKey = new Map();
    const links = [];
    for (const raw of rawLinks) {
      const url = resolveUrl(raw.href, pageUrl);
      if (!url) continue;
      const key = `${raw.type}::${url}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        continue;
      }
      const link = {
        url,
        text: raw.text,
        type: raw.type,
        internal: isInternal(url, sitemapDomain),
        count: 1,
      };
      byKey.set(key, link);
      links.push(link);
    }

    return { links, error: null };
  } catch (err) {
    return { links: [], error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

module.exports = { extractLinks };
