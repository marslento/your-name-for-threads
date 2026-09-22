#!/usr/bin/env node
/**
 * Writes the privacy page of the GitHub Pages site, `site/privacy/index.html`, from `PRIVACY.md` (Phase 4 Task 32;
 * review checklist 28, "Public Disclosure Consistency").
 *
 *   node scripts/build-site.mjs
 *   pnpm build:site
 *
 * The privacy page is not written a second time, it is PRIVACY.md rendered. PRIVACY.md is the document that is held to
 * the Data Handling Matrix, so a page rendered from it cannot say something the matrix does not and cannot fall behind
 * it. The rendered file is committed, so what the Pages workflow publishes is what was reviewed, and
 * `tests/repo/site.test.ts` fails while it is out of date.
 *
 * Only what PRIVACY.md uses is understood (headings, paragraphs, bullets, tables, **bold**, `code` and links). Anything
 * else stops the build, because a page that quietly shows raw markdown is worse than no page. A relative link becomes a
 * link to that file in the repository on GitHub. Node built-ins only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The repository, which a relative link in PRIVACY.md points into. `src/shared/links.ts` says the same and a test compares them. */
export const REPO_URL = "https://github.com/marslento/your-name-for-threads";

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const unsupported = (what, line) => new Error(`build-site: ${what} is not supported in PRIVACY.md: ${line.slice(0, 70)}`);

/** A link's target: an `https` address or an in-page anchor stays; a path in the repository goes to that file on GitHub. */
function target(href) {
  if (href.startsWith("#") || href.startsWith("https://")) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) throw unsupported("a link that is not https", href);
  return `${REPO_URL}/blob/main/${href}`;
}

/** Prose is escaped and may hold **bold** and links; what is inside `code` is escaped and nothing else is read from it. */
function inline(text) {
  const pieces = text.split("`");
  if (pieces.length % 2 === 0) throw unsupported("a backtick with no partner", text);
  return pieces.map((piece, index) => (index % 2 === 1 ? `<code>${escapeHtml(piece)}</code>` : prose(piece))).join("");
}

function prose(text) {
  const html = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${target(href)}">${label}</a>`);
  if (/\*\*|\]\(/.test(html)) throw unsupported("this inline markup", text);
  return html;
}

function table(rows, label) {
  const cells = (row) => {
    if (!row.endsWith("|")) throw unsupported("a table row that does not end with |", row);
    return row.slice(1, -1).split("|").map((cell) => cell.trim());
  };
  if (rows.length < 3 || !/^\|[\s:|-]+\|$/.test(rows[1])) throw unsupported("a table without a header rule", rows[0]);
  const [head, , ...body] = rows.map(cells);
  const columns = head.length;
  const out = [`<div class="table-scroll" role="region" aria-label="${escapeHtml(label)}" tabindex="0">`, "<table>", "<thead>", `<tr>${head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr>`, "</thead>", "<tbody>"];
  for (const row of body) {
    if (row.length !== columns) throw unsupported("a table row with a different number of cells", row.join("|"));
    out.push(`<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${inline(cell)}</th>` : `<td>${inline(cell)}</td>`)).join("")}</tr>`);
  }
  return [...out, "</tbody>", "</table>", "</div>"].join("\n");
}

const STRUCTURE = /^(#{1,2} |- |\|)/;
const UNSUPPORTED = /^(#{3,} |>|\d+[.)] |[*+] |```|<|\s|(-{3,}|\*{3,}|_{3,})\s*$)/;

/** The rendered `<main>` content of PRIVACY.md, and its title. */
function render(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const body = [];
  let title = "";
  let heading = "";
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    if (line.trim() === "") index += 1;
    else if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      body.push(`<h1>${inline(title)}</h1>`);
      index += 1;
    } else if (line.startsWith("## ")) {
      heading = line.slice(3).trim();
      body.push(`<h2 id="${slug(heading)}">${inline(heading)}</h2>`);
      index += 1;
    } else if (line.startsWith("|")) {
      const rows = [];
      while (index < lines.length && lines[index].startsWith("|")) rows.push(lines[index++]);
      body.push(table(rows, heading));
    } else if (line.startsWith("- ")) {
      const items = [];
      while (index < lines.length && lines[index].startsWith("- ")) items.push(lines[index++].slice(2));
      body.push(`<ul>\n${items.map((item) => `<li>${inline(item)}</li>`).join("\n")}\n</ul>`);
    } else if (UNSUPPORTED.test(line)) throw unsupported("this syntax", line);
    else {
      const paragraph = [];
      while (index < lines.length && lines[index].trim() !== "" && !STRUCTURE.test(lines[index])) paragraph.push(lines[index++].trim());
      body.push(`<p>${inline(paragraph.join(" "))}</p>`);
    }
  }
  if (title === "") throw new Error("build-site: PRIVACY.md has no # title");
  return { title, body: body.join("\n") };
}

/** The whole page. Its header and footer are the ones `site/index.html` and `site/support/index.html` carry, from one level down. */
export function renderPrivacyPage(markdown) {
  const { title, body } = render(markdown);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} - Your Name for Threads</title>
<meta name="description" content="What Your Name for Threads stores, what it reads on Threads, and what can leave your browser.">
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header>
<a class="brand" href="../">Your Name for Threads</a>
<nav aria-label="Site">
<a href="./" aria-current="page">Privacy</a>
<a href="../support/">Support</a>
<a href="${REPO_URL}">GitHub</a>
</nav>
</header>
<main>
${body}
</main>
<footer>
<p>This is an independent open-source project.</p>
</footer>
</body>
</html>
`;
}

/** Writes `site/privacy/index.html` under `cwd` from its `PRIVACY.md`. Returns the exit code. */
export function run({ cwd = process.cwd(), log = console.log } = {}) {
  const page = join(cwd, "site", "privacy", "index.html");
  mkdirSync(join(cwd, "site", "privacy"), { recursive: true });
  writeFileSync(page, renderPrivacyPage(readFileSync(join(cwd, "PRIVACY.md"), "utf8")));
  log("site/privacy/index.html written from PRIVACY.md");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run();
