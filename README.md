# 2wav Link Checker

A CLI tool that finds broken links across a website by parsing an XML sitemap, rendering each page in a headless browser to capture JavaScript-rendered links, and verifying each link via HTTP. Outputs HTML and CSV reports.

Built to handle SPAs and JS-heavy sites (Meteor, Nuxt with SSR off, etc.) where a plain HTTP fetch of the HTML source would miss links entirely.

## Features

- Renders pages via Playwright/Chromium — captures links injected by JavaScript
- Checks `<a href>`, `<img src/srcset>`, and optionally all other resource links
- Global link deduplication — each unique URL is checked once regardless of how many pages reference it
- Persistent known-good URL cache — repeat runs skip URLs that were good last time
- Per-domain concurrency and delay controls — avoids triggering anti-bot responses
- Automatic skip list for bot-hostile domains (Facebook, LinkedIn, Instagram, etc.)
- HTML report with filterable/sortable table and per-page breakdown
- CSV report for spreadsheet analysis
- Graceful Ctrl+C — writes a partial report of whatever has been checked so far

## Requirements

- Node.js 18 or later

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
node src/cli.js <sitemap-url> [options]
```

### Examples

```bash
# Full scan with both HTML and CSV reports
node src/cli.js https://example.com/sitemap.xml -o report -f both -v

# Only check internal links, filter to blog pages
node src/cli.js https://example.com/sitemap.xml --filter "/blog/" --internal-only -o blog-report

# Extra-polite scan for servers that throttle bots
node src/cli.js https://example.com/sitemap.xml --domain-concurrency 1 --domain-delay 1000 -v

# SPA with slow JS rendering
node src/cli.js https://example.com/sitemap.xml --wait 5000 -v

# Check all resource links (scripts, stylesheets, iframes, etc.)
node src/cli.js https://example.com/sitemap.xml --all-resources -o full-report
```

### Options

| Option | Default | Description |
|---|---|---|
| `-o, --output <path>` | `./broken-link-report` | Output file path (no extension) |
| `-f, --format <format>` | `both` | Output format: `csv`, `html`, or `both` |
| `-c, --concurrency <n>` | `3` | Pages to render in parallel |
| `--link-concurrency <n>` | `10` | Links to check in parallel (global) |
| `--domain-concurrency <n>` | `2` | Max concurrent requests to any single domain |
| `--domain-delay <ms>` | `0` | Delay between requests to the same domain |
| `--filter <regex>` | | Regex to filter which sitemap pages are scanned |
| `--timeout <ms>` | `30000` | Page load timeout |
| `--link-timeout <ms>` | `10000` | Per-link HTTP timeout |
| `--wait <ms>` | `2000` | Extra wait after page load (for JS rendering) |
| `--all-resources` | | Also check scripts, stylesheets, iframes, etc. |
| `--internal-only` | | Only check links on the same domain |
| `--external-only` | | Only check links on other domains |
| `--include-redirects` | | Include 3xx redirects in the report |
| `--summary` | | One row per unique link instead of one per page occurrence |
| `--cache <path>` | `.link-checker-cache.json` | Path to the known-good URL cache |
| `--no-cache` | | Disable the cache for this run |
| `--cache-max-age <days>` | `7` | How long cached results are considered valid |
| `--ignore-domains <list>` | | Comma-separated extra domains to skip |
| `--no-skip-bot-domains` | | Disable the built-in bot-hostile domain skip list |
| `--user-agent <ua>` | | Custom User-Agent string |
| `-v, --verbose` | | Print detailed progress to stderr |

### Bot-hostile domains

The following domains are skipped by default because they block automated requests and return false error codes: `facebook.com`, `fb.com`, `instagram.com`, `linkedin.com`, `twitter.com`, `x.com`, `tiktok.com`.

Skipped URLs appear in a separate section of the HTML report and are labeled `skipped` in the CSV. Use `--no-skip-bot-domains` to disable this behaviour, or `--ignore-domains` to add more domains to the skip list.

### Caching

Successful (2xx) link check results are saved to `.link-checker-cache.json` and reused on subsequent runs. This makes repeat scans much faster. Only successful results are cached — broken, errored, and timed-out URLs are always re-checked.

The cache expires after 7 days by default. Use `--cache-max-age` to change this, or `--no-cache` to bypass it entirely.

## Report Output

### HTML Report
A self-contained HTML file (no external dependencies) with:
- Summary cards: pages scanned, links found, links checked, broken/error/redirect counts
- Filterable table of all issues
- Per-page breakdown (expandable)
- Skipped domains section

### CSV Report
One row per issue with columns: Page URL, Link URL, Link Text, Link Type, Status, Status Description, Redirect URL, Response Time (ms), Internal/External.

### Summary Mode (`--summary`)
Collapses the report to one row per unique link, sorted worst-first and then by how
widely the link is used. Intended for a human reviewing a site's links — a shared nav
link that appears on 300 pages is one decision, not 300 rows.

The CSV columns become: Link URL, Link Text, Link Type, Status, Status Description,
Redirect URL, Internal/External, Occurrences, Pages, Example Page. In the HTML report
the "All Issues" table becomes the unique-link list; the per-page breakdown is
unchanged below it.

`Occurrences` counts every use of the link (a link in a nav and again in a footer on the
same page counts twice); `Pages` counts the distinct pages to edit.

## License

MIT License

Copyright (c) 2026 2wav Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
