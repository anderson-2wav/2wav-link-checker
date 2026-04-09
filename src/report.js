// Copyright (c) 2026 2wav Inc. AGPL-3.0-only.
'use strict';

const fs = require('fs');
const path = require('path');
const { statusDescription, formatDuration } = require('./utils');
const { classify } = require('./checker');

/**
 * Build the flat list of reportable rows from per-page results.
 *
 * @param {Map<string, {links: LinkRecord[], error: string|null}>} pageResults
 *   Map of pageUrl -> { links, error }
 * @param {Map<string, CheckResult>} checkResults
 *   Map of linkUrl -> check result
 * @param {object} opts
 * @param {boolean} opts.includeRedirects
 */
function buildRows(pageResults, checkResults, opts = {}) {
  const { includeRedirects = false } = opts;
  const rows = [];

  for (const [pageUrl, { links, error }] of pageResults) {
    if (error) {
      // Page itself failed to load
      rows.push({
        pageUrl,
        linkUrl: pageUrl,
        linkText: '',
        linkType: 'page',
        status: null,
        statusDesc: error,
        category: 'error',
        redirectUrl: '',
        responseTime: '',
        internal: true,
      });
      continue;
    }

    for (const link of links) {
      const result = checkResults.get(link.url);
      if (!result) continue;
      const cat = classify(result);
      if (cat === 'ok') continue;
      if (cat === 'redirect' && !includeRedirects) continue;

      rows.push({
        pageUrl,
        linkUrl: link.url,
        linkText: link.text,
        linkType: link.type,
        status: result.status,
        statusDesc: result.error
          ? result.error
          : result.status === 403 && result.serverSig
            ? `Forbidden (${result.serverSig})`
            : statusDescription(result.status),
        category: cat,
        redirectUrl: result.redirectUrl || '',
        responseTime: result.responseTime != null ? result.responseTime : '',
        internal: link.internal,
      });
    }
  }

  // Sort: by pageUrl, then errors first
  const catOrder = { error: 0, timeout: 1, broken: 2, uncheckable: 3, redirect: 4 };
  rows.sort((a, b) => {
    if (a.pageUrl < b.pageUrl) return -1;
    if (a.pageUrl > b.pageUrl) return 1;
    return (catOrder[a.category] ?? 9) - (catOrder[b.category] ?? 9);
  });

  return rows;
}

function escapeCsv(val) {
  const s = String(val == null ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function generateCsv(rows, skippedUrls = []) {
  const header = [
    'Page URL', 'Link URL', 'Link Text', 'Link Type',
    'Status', 'Status Description', 'Redirect URL',
    'Response Time (ms)', 'Internal/External',
  ];
  const lines = [header.map(escapeCsv).join(',')];
  for (const r of rows) {
    lines.push([
      r.pageUrl, r.linkUrl, r.linkText, r.linkType,
      r.status ?? '', r.statusDesc, r.redirectUrl,
      r.responseTime, r.internal ? 'Internal' : 'External',
    ].map(escapeCsv).join(','));
  }
  for (const url of skippedUrls) {
    lines.push(['', url, '', '', 'skipped', 'Bot-blocked domain', '', '', ''].map(escapeCsv).join(','));
  }
  lines.push('');
  lines.push('# This software © 2026 2wav inc. All Rights Reserved. Free for use under the GNU Affero General Public License v3.0 (https://www.gnu.org/licenses/agpl-3.0.html)');
  return lines.join('\n');
}

function categoryBadge(cat, status) {
  const colors = {
    broken: '#dc2626',
    uncheckable: '#f97316',
    error: '#ea580c',
    timeout: '#d97706',
    redirect: '#ca8a04',
    ok: '#16a34a',
  };
  const color = colors[cat] || '#6b7280';
  const label = status != null ? status : cat.toUpperCase();
  return `<span class="badge" style="background:${color}">${label}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateHtml(rows, summary, logoDataUri = '') {
  const { pagesScanned, uniqueLinks, uniqueChecked, internalCount, externalCount, skippedUrls = [], duration, startTime } = summary;

  const brokenCount       = rows.filter(r => r.category === 'broken').length;
  const uncheckableCount  = rows.filter(r => r.category === 'uncheckable').length;
  const errorCount        = rows.filter(r => r.category === 'error' || r.category === 'timeout').length;
  const redirectCount     = rows.filter(r => r.category === 'redirect').length;

  // Group by page for per-page breakdown
  const byPage = new Map();
  for (const row of rows) {
    if (!byPage.has(row.pageUrl)) byPage.set(row.pageUrl, []);
    byPage.get(row.pageUrl).push(row);
  }

  const tableRows = rows.map(r => `
    <tr class="row-${r.category}">
      <td><a href="${escapeHtml(r.pageUrl)}" target="_blank">${escapeHtml(r.pageUrl)}</a></td>
      <td><a href="${escapeHtml(r.linkUrl)}" target="_blank">${escapeHtml(r.linkUrl)}</a></td>
      <td>${escapeHtml(r.linkText)}</td>
      <td>${escapeHtml(r.linkType)}</td>
      <td>${categoryBadge(r.category, r.status)}</td>
      <td>${escapeHtml(r.statusDesc)}</td>
      <td>${r.redirectUrl ? `<a href="${escapeHtml(r.redirectUrl)}" target="_blank">${escapeHtml(r.redirectUrl)}</a>` : ''}</td>
      <td>${r.responseTime !== '' ? r.responseTime + 'ms' : ''}</td>
      <td>${r.internal ? 'Internal' : 'External'}</td>
    </tr>`).join('');

  const perPageSections = [...byPage.entries()].map(([page, pageRows]) => {
    const rowsHtml = pageRows.map(r => `
      <tr class="row-${r.category}">
        <td><a href="${escapeHtml(r.linkUrl)}" target="_blank">${escapeHtml(r.linkUrl)}</a></td>
        <td>${escapeHtml(r.linkText)}</td>
        <td>${escapeHtml(r.linkType)}</td>
        <td>${categoryBadge(r.category, r.status)}</td>
        <td>${escapeHtml(r.statusDesc)}</td>
        <td>${r.responseTime !== '' ? r.responseTime + 'ms' : ''}</td>
      </tr>`).join('');
    return `
    <details>
      <summary><strong>${escapeHtml(page)}</strong> — ${pageRows.length} issue(s)</summary>
      <table>
        <thead><tr><th>Link URL</th><th>Text</th><th>Type</th><th>Status</th><th>Description</th><th>Response Time</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </details>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Broken Link Report</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1f2937;background:#f9fafb;padding:24px}
  h1{font-size:22px;font-weight:700;margin-bottom:4px}
  .meta{color:#6b7280;font-size:13px;margin-bottom:24px}
  .summary{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:32px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;min-width:160px}
  .card .label{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .card .value{font-size:28px;font-weight:700;margin-top:4px}
  .card.broken .value{color:#dc2626}
  .card.uncheckable .value{color:#f97316}
  .card.error .value{color:#ea580c}
  .card.redirect .value{color:#ca8a04}
  .card.skipped .value{color:#6b7280}
  h2{font-size:17px;font-weight:600;margin:32px 0 12px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:13px}
  th{background:#f3f4f6;text-align:left;padding:10px 12px;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap}
  td{padding:8px 12px;border-bottom:1px solid #f3f4f6;vertical-align:top;word-break:break-all}
  tr:last-child td{border-bottom:none}
  tr.row-broken td{background:#fff5f5}
  tr.row-uncheckable td{background:#fff7ed}
  tr.row-error td,tr.row-timeout td{background:#fff7f0}
  tr.row-redirect td{background:#fefce8}
  a{color:#2563eb;text-decoration:none}
  a:hover{text-decoration:underline}
  .badge{display:inline-block;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap}
  details{background:#fff;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:10px;padding:12px 16px}
  summary{cursor:pointer;font-size:13px;padding:2px 0}
  details table{margin-top:12px;font-size:12px}
  .filter-bar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .filter-bar input,.filter-bar select{padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px}
  .filter-bar input{flex:1;min-width:200px}
  footer{margin-top:48px;padding-top:16px;border-top:1px solid #e5e7eb;display:flex;align-items:center;gap:16px;color:#6b7280;font-size:12px}
  footer a{color:#6b7280}
  footer a:hover{color:#1f2937}
  .footer-logo{height:28px;width:auto;display:block;opacity:.7}
  .footer-logo:hover{opacity:1}
</style>
</head>
<body>
<h1>Broken Link Report</h1>
<div class="meta">Generated ${new Date(startTime).toLocaleString()} &nbsp;·&nbsp; Scan duration: ${formatDuration(duration)}</div>

<div class="summary">
  <div class="card"><div class="label">Pages Scanned</div><div class="value">${pagesScanned.toLocaleString()}</div></div>
  <div class="card"><div class="label">Unique Links Found</div><div class="value">${uniqueLinks.toLocaleString()}</div></div>
  <div class="card"><div class="label">Links Checked</div><div class="value">${uniqueChecked.toLocaleString()}</div></div>
  <div class="card"><div class="label">Internal</div><div class="value">${internalCount.toLocaleString()}</div></div>
  <div class="card"><div class="label">External</div><div class="value">${externalCount.toLocaleString()}</div></div>
  <div class="card broken"><div class="label">Broken (4xx/5xx)</div><div class="value">${brokenCount.toLocaleString()}</div></div>
  <div class="card uncheckable"><div class="label">Uncheckable (403)</div><div class="value">${uncheckableCount.toLocaleString()}</div></div>
  <div class="card error"><div class="label">Errors / Timeouts</div><div class="value">${errorCount.toLocaleString()}</div></div>
  <div class="card redirect"><div class="label">Redirects</div><div class="value">${redirectCount.toLocaleString()}</div></div>
  <div class="card skipped"><div class="label">Skipped (bot-blocked)</div><div class="value">${skippedUrls.length.toLocaleString()}</div></div>
</div>

<h2>All Issues (${rows.length.toLocaleString()})</h2>
<div class="filter-bar">
  <input type="text" id="filterText" placeholder="Filter by URL or text…" oninput="applyFilters()">
  <select id="filterCat" onchange="applyFilters()">
    <option value="">All categories</option>
    <option value="broken">Broken (4xx/5xx)</option>
    <option value="uncheckable">Uncheckable (403)</option>
    <option value="error">Error</option>
    <option value="timeout">Timeout</option>
    <option value="redirect">Redirect</option>
  </select>
  <select id="filterScope" onchange="applyFilters()">
    <option value="">Internal &amp; External</option>
    <option value="Internal">Internal only</option>
    <option value="External">External only</option>
  </select>
</div>
<table id="mainTable">
  <thead><tr>
    <th>Page URL</th><th>Link URL</th><th>Link Text</th><th>Type</th>
    <th>Status</th><th>Description</th><th>Redirect URL</th><th>Response Time</th><th>Scope</th>
  </tr></thead>
  <tbody>${tableRows}</tbody>
</table>

<h2>Per-Page Breakdown</h2>
${perPageSections || '<p style="color:#6b7280">No issues found.</p>'}

${skippedUrls.length > 0 ? `
<h2>Skipped — Bot-Blocked Domains (${skippedUrls.length.toLocaleString()})</h2>
<details>
  <summary>These URLs were not checked because their domains are known to block automated requests (Facebook, LinkedIn, etc.). Use <code>--no-skip-bot-domains</code> to disable this behaviour.</summary>
  <ul style="margin-top:12px;padding-left:20px;font-size:13px;line-height:1.8">
    ${skippedUrls.map(u => `<li><a href="${escapeHtml(u)}" target="_blank">${escapeHtml(u)}</a></li>`).join('\n    ')}
  </ul>
</details>` : ''}

<footer>
  ${logoDataUri ? `<a href="https://2wav.com" target="_blank" aria-label="2wav inc."><img src="${logoDataUri}" alt="2wav inc." class="footer-logo"></a>` : ''}
  <p>This software &copy; 2026 2wav inc. All Rights Reserved. Free for use under the <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank">GNU Affero General Public License v3.0</a></p>
</footer>

<script>
function applyFilters() {
  const text = document.getElementById('filterText').value.toLowerCase();
  const cat = document.getElementById('filterCat').value;
  const scope = document.getElementById('filterScope').value;
  const rows = document.querySelectorAll('#mainTable tbody tr');
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    const rowText = row.textContent.toLowerCase();
    const rowCat = row.className.replace('row-','');
    const rowScope = cells[8] ? cells[8].textContent.trim() : '';
    const textOk = !text || rowText.includes(text);
    const catOk = !cat || rowCat === cat;
    const scopeOk = !scope || rowScope === scope;
    row.style.display = textOk && catOk && scopeOk ? '' : 'none';
  });
}
</script>
</body>
</html>`;
}

/**
 * Write reports to disk.
 *
 * @param {Map} pageResults
 * @param {Map} checkResults
 * @param {object} summary
 * @param {object} opts
 * @param {string} opts.output - base path (no extension)
 * @param {string} opts.format - 'csv' | 'html' | 'both'
 * @param {boolean} opts.includeRedirects
 */
function writeReports(pageResults, checkResults, summary, opts = {}) {
  const { output = './broken-link-report', format = 'both', includeRedirects = false } = opts;
  const rows = buildRows(pageResults, checkResults, { includeRedirects });
  const written = [];

  const skippedUrls = summary.skippedUrls || [];

  let logoDataUri = '';
  try {
    const logoPath = path.join(__dirname, '../images/2wav-logo-dark.svg');
    const logoBase64 = fs.readFileSync(logoPath, 'base64');
    if (logoBase64) logoDataUri = `data:image/svg+xml;base64,${logoBase64}`;
  } catch (_) { /* logo is optional */ }

  if (format === 'csv' || format === 'both') {
    const csvPath = `${output}.csv`;
    fs.writeFileSync(csvPath, generateCsv(rows, skippedUrls), 'utf-8');
    written.push(csvPath);
  }
  if (format === 'html' || format === 'both') {
    const htmlPath = `${output}.html`;
    fs.writeFileSync(htmlPath, generateHtml(rows, summary, logoDataUri), 'utf-8');
    written.push(htmlPath);
  }

  return { rows, written };
}

module.exports = { writeReports };
