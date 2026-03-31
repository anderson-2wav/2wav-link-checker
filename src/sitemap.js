// Copyright (c) 2026 2wav Inc. MIT License.
'use strict';

const { XMLParser } = require('fast-xml-parser');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

async function fetchRaw(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status} ${url}`);
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  // Decompress if gzipped (by content-type or magic bytes)
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('gzip') || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    return (await gunzip(buf)).toString('utf-8');
  }
  return buf.toString('utf-8');
}

function extractUrls(parsed) {
  const urls = [];
  // <urlset><url><loc>
  const urlset = parsed.urlset;
  if (urlset) {
    const items = Array.isArray(urlset.url) ? urlset.url : [urlset.url].filter(Boolean);
    for (const item of items) {
      if (item && item.loc) urls.push(String(item.loc).trim());
    }
  }
  return urls;
}

function extractSitemaps(parsed) {
  const sitemaps = [];
  const idx = parsed.sitemapindex;
  if (idx) {
    const items = Array.isArray(idx.sitemap) ? idx.sitemap : [idx.sitemap].filter(Boolean);
    for (const item of items) {
      if (item && item.loc) sitemaps.push(String(item.loc).trim());
    }
  }
  return sitemaps;
}

/**
 * Fetch a sitemap URL and return a flat array of page URLs.
 * Handles <urlset> and <sitemapindex> (nested) formats.
 * @param {string} sitemapUrl
 * @param {RegExp|null} filter - optional regex to filter page URLs
 * @param {Set} visited - tracks already-fetched sitemap URLs to avoid loops
 */
async function fetchSitemap(sitemapUrl, filter = null, visited = new Set()) {
  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  const xml = await fetchRaw(sitemapUrl);
  const parsed = parser.parse(xml);

  // Nested sitemap index
  const nested = extractSitemaps(parsed);
  if (nested.length > 0) {
    const results = await Promise.all(
      nested.map(url => fetchSitemap(url, filter, visited))
    );
    return results.flat();
  }

  // Flat urlset
  let urls = extractUrls(parsed);
  if (filter) urls = urls.filter(u => filter.test(u));
  return urls;
}

module.exports = { fetchSitemap };
