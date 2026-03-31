'use strict';

const SKIP_SCHEMES = /^(mailto:|tel:|javascript:|data:|#)/i;

/**
 * Normalize a URL to absolute form given a base URL.
 * Returns null if the URL should be skipped.
 */
function resolveUrl(href, base) {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed || SKIP_SCHEMES.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, base);
    // Strip fragment — we care about the resource, not the anchor
    resolved.hash = '';
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * Return true if linkUrl is on the same hostname as baseUrl.
 */
function isInternal(linkUrl, baseUrl) {
  try {
    const link = new URL(linkUrl);
    const base = new URL(baseUrl);
    return link.hostname === base.hostname;
  } catch {
    return false;
  }
}

/**
 * Human-readable description for an HTTP status code or error string.
 */
function statusDescription(status) {
  if (typeof status === 'string') return status; // already descriptive error
  const map = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
    307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
    410: 'Gone', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  return map[status] || `HTTP ${status}`;
}

/**
 * Format milliseconds as a human-readable duration string.
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

module.exports = { resolveUrl, isInternal, statusDescription, formatDuration };
