// Copyright (c) 2026 2wav Inc. MIT License.
'use strict';

const fs = require('fs');

/**
 * Persistent cache of known-good URL check results.
 * Stored as a JSON file: { [url]: { status, responseTime, checkedAt } }
 *
 * Only 2xx results are cached. Broken/error/timeout results are always re-checked
 * so transient failures don't get permanently suppressed.
 */
class LinkCache {
  constructor(filePath, maxAgeMs) {
    this.filePath = filePath;
    this.maxAgeMs = maxAgeMs;
    this.data = {};
  }

  load() {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = {};
    }
    // Prune expired entries on load
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [url, entry] of Object.entries(this.data)) {
      if (entry.checkedAt < cutoff) delete this.data[url];
    }
  }

  /** Return a cached result if the URL is known-good and not expired, else null. */
  get(url) {
    const entry = this.data[url];
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > this.maxAgeMs) {
      delete this.data[url];
      return null;
    }
    return {
      url,
      status: entry.status,
      redirectUrl: entry.redirectUrl || null,
      responseTime: entry.responseTime,
      error: null,
      fromCache: true,
    };
  }

  /** Store a 2xx result. Non-2xx results are intentionally not cached. */
  set(url, result) {
    if (!this.filePath) return;
    if (result.error || result.status == null || result.status < 200 || result.status >= 300) return;
    this.data[url] = {
      status: result.status,
      redirectUrl: result.redirectUrl || null,
      responseTime: result.responseTime,
      checkedAt: Date.now(),
    };
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      process.stderr.write(`[Cache] Warning: could not save cache: ${err.message}\n`);
    }
  }

  get size() {
    return Object.keys(this.data).length;
  }
}

module.exports = { LinkCache };
