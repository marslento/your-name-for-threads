import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { REPO_URL, renderPrivacyPage, run } from "../../scripts/build-site.mjs";
import { auditReleaseGates } from "../../scripts/release-audit.mjs";
import { GITHUB_BUG_REPORT_URL, GITHUB_ISSUES_URL, GITHUB_REPO_URL, PRIVACY_POLICY_URL, SECURITY_POLICY_URL } from "../../src/shared/links";
import { filesUnder, removeBuilt, scratchDirectory } from "../fixtures/buildPackage";
import { ROOT } from "../fixtures/repoFiles";

/**
 * The GitHub Pages site (Phase 4 Task 32; review checklist 28, "Public Disclosure Consistency"): a home page, /privacy and
 * /support, published from `site/` exactly as committed. The site is a public statement about what the extension does, so
 * what is held here is that it says only what the rest of the project says (the privacy page is PRIVACY.md rendered, the
 * support page uses the extension's own words and links), that it fetches nothing from anywhere, and that it cannot be
 * released with a store link that goes nowhere.
 */
const SITE = join(ROOT, "site");
const PAGES = ["index.html", "privacy/index.html", "support/index.html"];

const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const page = (name: string) => read(`site/${name}`);
const messages = JSON.parse(read("_locales/en/messages.json")) as Record<string, { message: string }>;
const message = (key: string) => messages[key].message;

const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");
const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** The words on a page, as one line: tags removed and comments dropped. Each block is on its own line in the source. */
const plain = (html: string) => decode(withoutComments(html).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const hrefs = (html: string) => [...withoutComments(html).matchAll(/\bhref="([^"]*)"/g)].map((match) => decode(match[1]));
const isRemote = (href: string) => /^https?:/i.test(href);
const between = (html: string, tag: string) => html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))![1];

afterEach(removeBuilt);

describe("the site", () => {
  it("is exactly the three pages and the stylesheet, so nothing unreviewed is published with them", () => {
    const files = filesUnder(SITE).map((file) => relative(SITE, file).split(sep).join("/")).sort();

    expect(files).toEqual(["index.html", "privacy/index.html", "style.css", "support/index.html"]);
  });

  it("is made of text: no file the site is made from has a NUL byte, which would make Git show its changes as binary and hide them from review", () => {
    const made = [...filesUnder(SITE), join(ROOT, "scripts", "build-site.mjs"), join(ROOT, "scripts", "build-site.d.mts"), join(ROOT, ".github", "workflows", "pages.yml"), join(ROOT, "tests", "repo", "site.test.ts")];

    for (const file of made) expect(readFileSync(file).includes(0), relative(ROOT, file)).toBe(false);
  });

  it.each(PAGES)("%s is a whole page: its language, a viewport, one title, one h1, one main region and a description", (file) => {
    const html = page(file);

    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html.match(/<title>[^<]+<\/title>/g)).toHaveLength(1);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<main>/g)).toHaveLength(1);
    expect(html).toMatch(/<meta name="description" content="[^"]{20,}">/);
    expect(html.match(/aria-current="page"/g), "it says which page it is").toHaveLength(1);
  });

  it("gives each page a title of its own", () => {
    const titles = PAGES.map((file) => page(file).match(/<title>([^<]+)<\/title>/)![1]);

    expect(new Set(titles).size).toBe(3);
  });

  it("carries the same header and the same independence statement on every page", () => {
    const navigation = (file: string) =>
      [...between(page(file), "nav").matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => [match[2], new URL(match[1], `https://site.test/base/${file}`).href]);
    const brand = (file: string) => new URL(page(file).match(/<a class="brand" href="([^"]+)"/)![1], `https://site.test/base/${file}`).href;

    for (const file of PAGES) {
      expect(navigation(file), file).toEqual([["Privacy", "https://site.test/base/privacy/"], ["Support", "https://site.test/base/support/"], ["GitHub", GITHUB_REPO_URL]]);
      expect(brand(file), file).toBe("https://site.test/base/");
      expect(plain(between(page(file), "footer")), file).toBe(message("dashboard_about_independent"));
    }
  });
});

describe("what the site fetches", () => {
  it.each(PAGES)("%s loads nothing but its own stylesheet: no script, font, image, frame or form", (file) => {
    const html = withoutComments(page(file));
    const links = [...html.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]);

    expect(html).not.toMatch(/<(script|iframe|object|embed|img|video|audio|source|form|input|base|svg)\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=|javascript:|http-equiv/i);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^<link rel="stylesheet" href="(\.\.\/)?style\.css">$/);
  });

  it("has a stylesheet that imports nothing and names no font or file to fetch", () => {
    expect(read("site/style.css")).not.toMatch(/@import|url\(|@font-face/i);
  });

  it.each(PAGES)("%s links out only to this project's own repository (and, once they exist, the two stores)", (file) => {
    for (const href of hrefs(page(file)).filter(isRemote)) {
      const ours = href === GITHUB_REPO_URL || href.startsWith(`${GITHUB_REPO_URL}/`) || href.startsWith(`${GITHUB_REPO_URL}#`);
      const store = /^https:\/\/(chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)\//.test(href);
      expect(ours || store, `${file} links to ${href}`).toBe(true);
    }
  });

  it.each(PAGES)("%s publishes no email address", (file) => {
    expect(page(file)).not.toMatch(/mailto:|[\w.+-]+@[\w-]+\.[\w.-]+/i);
  });
});

describe("the links between the pages", () => {
  it.each(PAGES)("every link in %s that stays on the site goes to a file that exists, and to an anchor that exists", (file) => {
    const local = hrefs(page(file)).filter((href) => !isRemote(href));

    expect(local.length).toBeGreaterThan(2);
    for (const href of local) {
      const url = new URL(href, `https://site.test/base/${file}`);
      const path = decodeURIComponent(url.pathname).replace(/^\/base\//, "");
      const target = path === "" || path.endsWith("/") ? `${path}index.html` : path;

      expect(existsSync(join(SITE, target)), `${file} -> ${href}`).toBe(true);
      if (url.hash) expect(page(target), `${file} -> ${href}`).toContain(`id="${url.hash.slice(1)}"`);
    }
  });

  it("serves the address the extension links to for its privacy policy", () => {
    const [owner, name] = new URL(GITHUB_REPO_URL).pathname.split("/").slice(1);
    const policy = new URL(PRIVACY_POLICY_URL);

    expect(policy.hostname, "a project site is served from the owner's github.io").toBe(`${owner}.github.io`);
    expect(policy.pathname, "and under the repository's name").toBe(`/${name}/privacy`);
    expect(existsSync(join(SITE, "privacy", "index.html"))).toBe(true);
  });
});

describe("the colours", () => {
  const css = read("site/style.css");
  const scheme = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z]+):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1], match[2]]));
  const light = scheme(css.match(/:root\s*\{([^}]*)\}/)![1]);
  const dark = scheme(css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)![1]);
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each([["light", light], ["dark", dark]] as const)("keeps every text colour at 4.5:1 or better on the page and on a band, in the %s theme", (_name, colours) => {
    expect(Object.keys(colours).sort()).toEqual(["bg", "band", "fg", "link", "muted", "rule"].sort());
    for (const text of ["fg", "muted", "link"]) {
      for (const ground of ["bg", "band"]) expect(contrast(colours[text], colours[ground]), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("measures contrast correctly: black on white is 21:1, and a pale grey on white fails", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#bbbbbb", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("the privacy page", () => {
  it("is PRIVACY.md rendered, exactly, so it cannot say anything PRIVACY.md does not, or fall behind it", () => {
    expect(page("privacy/index.html"), "site/privacy/index.html is out of date: run `pnpm build:site` and commit it").toBe(renderPrivacyPage(read("PRIVACY.md")));
  });

  it("would notice a change: a PRIVACY.md with one more sentence renders differently", () => {
    expect(renderPrivacyPage(`${read("PRIVACY.md")}\nAn extra sentence.\n`)).not.toBe(page("privacy/index.html"));
  });

  it("names the same repository as the extension, for the links PRIVACY.md points into it", () => {
    expect(REPO_URL).toBe(GITHUB_REPO_URL);
  });

  it("has a script in package.json that renders it", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

    expect(scripts["build:site"]).toBe("node scripts/build-site.mjs");
  });

  it("is written by that script, from the PRIVACY.md next to it", () => {
    const directory = scratchDirectory();
    writeFileSync(join(directory, "PRIVACY.md"), "# Privacy\r\n\r\nA sentence.\r\n");
    const said: string[] = [];

    expect(run({ cwd: directory, log: (line) => said.push(line) })).toBe(0);

    expect(readFileSync(join(directory, "site", "privacy", "index.html"), "utf8")).toBe(renderPrivacyPage("# Privacy\n\nA sentence.\n"));
    expect(said).toHaveLength(1);
  });
});

describe("the renderer", () => {
  const render = (markdown: string) => renderPrivacyPage(`# Title\n\n${markdown}\n`);

  it("reads a file with Windows line endings the same as one with Unix ones", () => {
    const markdown = read("PRIVACY.md");

    expect(renderPrivacyPage(markdown.replace(/\n/g, "\r\n"))).toBe(renderPrivacyPage(markdown));
  });

  it("shows text as text, never as markup", () => {
    const html = render('a <script>alert(1)</script> & "b"');

    expect(html).toContain("<p>a &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;b&quot;</p>");
    expect(html).not.toContain("<script>");
  });

  it("escapes what is inside `code` too", () => {
    expect(render("`<b>&</b>`")).toContain("<code>&lt;b&gt;&amp;&lt;/b&gt;</code>");
  });

  it("leaves what is inside `code` alone, and finds bold and links outside it", () => {
    const html = render("`**x** [a](b)` and **bold** and [a link](#here)");

    expect(html).toContain("<code>**x** [a](b)</code> and <strong>bold</strong> and <a href=\"#here\">a link</a>");
  });

  it("turns a path in the repository into a link to that file on GitHub, and leaves https links and anchors as they are", () => {
    const html = render("[a](docs/x.md) [b](https://example.org/y) [c](#z)");

    expect(html).toContain(`<a href="${REPO_URL}/blob/main/docs/x.md">a</a>`);
    expect(html).toContain('<a href="https://example.org/y">b</a> <a href="#z">c</a>');
  });

  it.each(["[x](javascript:alert(1))", "[x](http://example.org)", "[x](mailto:a@example.org)", "[x](data:text/html,hi)"])("refuses the link %s, which is not https", (markdown) => {
    expect(() => render(markdown)).toThrow(/not https/);
  });

  it.each([
    ["a quotation", "> quoted"],
    ["a numbered list", "1. one"],
    ["a third-level heading", "### three"],
    ["a code fence", "```"],
    ["a star bullet", "* star"],
    ["a rule", "---"],
    ["an indented line", "  indented"],
    ["raw HTML", "<b>html</b>"],
    ["a backtick with no partner", "an unmatched `tick"],
    ["bold that is never closed", "**unclosed"],
  ])("refuses %s rather than publishing it wrongly", (_name, markdown) => {
    expect(() => render(markdown)).toThrow(/build-site/);
  });

  it("refuses a table without a header rule, a row with the wrong number of cells, and a row with no closing bar", () => {
    expect(() => render("| a | b |\n| c | d |\n| e | f |")).toThrow(/header rule/);
    expect(() => render("| a | b |\n| --- | --- |\n| c |")).toThrow(/different number of cells|does not end/);
    expect(() => render("| a | b |\n| --- | --- |\n| c | d | e |")).toThrow(/different number of cells/);
    expect(() => render("| a | b |\n| --- | --- |\n| c | d")).toThrow(/does not end/);
  });

  it("needs a title", () => {
    expect(() => renderPrivacyPage("Just a sentence.\n")).toThrow(/no # title/);
  });

  it("gives every heading an id from its words, a table's headers and rows their scope, and a scrolling table a name and a way to focus it", () => {
    const html = render("## Your choices\n\n| What | Why |\n| --- | --- |\n| One | Two |");

    expect(html).toContain('<h2 id="your-choices">Your choices</h2>');
    expect(html).toContain('<th scope="col">What</th><th scope="col">Why</th>');
    expect(html).toContain('<tr><th scope="row">One</th><td>Two</td></tr>');
    expect(html).toContain('<div class="table-scroll" role="region" aria-label="Your choices" tabindex="0">');
  });

  it("joins the lines of a paragraph, and ends a list and a table at the next line that is neither", () => {
    const html = render("one\ntwo\n\n- a\n- b\n\nthree\n\n| a |\n| - |\n| b |\nfour");

    expect(html).toContain("<p>one two</p>");
    expect(html).toContain("<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    expect(html).toContain("<p>three</p>");
    expect(html).toContain("<p>four</p>");
  });
});

describe("the home page", () => {
  const html = page("index.html");
  const bullets = (markdown: string) => markdown.split("## Privacy at a glance")[1].split("\n## ")[0].split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).replace(/`/g, ""));

  it("gives the README's 'Privacy at a glance' as it stands, and no more claims than that", () => {
    const privacy = html.split('<h2 id="privacy-at-a-glance">')[1].split("<h2")[0];
    const items = [...privacy.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => plain(match[1]));

    expect(items).toEqual(bullets(read("README.md")));
  });

  it("says it is independent, unofficial and open source, and links to the repository and to the other two pages", () => {
    expect(plain(html)).toMatch(/independent, unofficial, open-source/);
    expect(hrefs(html)).toEqual(expect.arrayContaining([GITHUB_REPO_URL, "privacy/", "support/"]));
  });

  it("has no store link before publication, and has both after the follow-up is complete", () => {
    const chrome = /href="https:\/\/chromewebstore\.google\.com\/[^"]+"/;
    const edge = /href="https:\/\/microsoftedge\.microsoft\.com\/addons\/[^"]+"/;

    if (html.includes("POST-PUBLICATION")) {
      expect(html).not.toMatch(chrome);
      expect(html).not.toMatch(edge);
      expect(plain(html)).toContain("not in the Chrome Web Store or Microsoft Edge Add-ons yet");
    } else {
      expect(html).toMatch(chrome);
      expect(html).toMatch(edge);
      expect(plain(html)).not.toMatch(/not in the Chrome Web Store/);
    }
  });

  it("does not require public store listings before the first package can be submitted", () => {
    const found = auditReleaseGates(ROOT).filter((finding) => finding.path.startsWith("site/index.html:"));

    expect(found).toEqual([]);
  });
});

describe("the support page", () => {
  const html = page("support/index.html");
  const text = plain(html);

  it("tells someone how to copy diagnostics, with the names the extension gives its own buttons", () => {
    for (const key of ["popup_openDashboard", "dashboard_sidebar_about", "dashboard_about_copyDiagnostics", "dashboard_about_reportIssue", "recovery_exportAction"]) {
      expect(text, key).toContain(message(key));
    }
  });

  it("repeats the About page's guidance on what diagnostics hold and on what never to paste, word for word", () => {
    expect(text).toContain(message("dashboard_about_supportDiagnostics"));
    expect(text).toContain(message("dashboard_about_supportPrivate"));
  });

  it("links to the bug-report form, to Issues and to the security policy that the extension itself links to", () => {
    expect(hrefs(html)).toEqual(expect.arrayContaining([GITHUB_BUG_REPORT_URL, GITHUB_ISSUES_URL, SECURITY_POLICY_URL]));
  });

  it("opens the bug-report form with nothing but its template, so no diagnostics or account data go with the link", () => {
    const forms = hrefs(html).filter((href) => href.startsWith(`${GITHUB_REPO_URL}/issues/new`));

    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) expect(["", "?template=bug_report.yml"]).toContain(new URL(form).search);
  });

  it("sends a security problem to the policy and never to a public issue", () => {
    expect(text).toContain("Do not open a public issue");
  });

  it("promises no response time and no bounty it cannot keep", () => {
    expect(text).toContain("no guaranteed response time");
    expect(text).not.toMatch(/within \d|hours|business days|bounty/i);
  });
});

describe("the Pages workflow", () => {
  const text = () => read(".github/workflows/pages.yml").split("\n").map((line) => line.replace(/(^|\s)#.*$/, "")).join("\n");

  it("runs when main changes the site, or when the owner asks, and never for a pull request or a fork's code", () => {
    expect(text()).toMatch(/^on:\n\s+push:\n\s+branches:\s*\[main\]\n\s+paths:\n\s+- "site\/\*\*"\n\s+- "\.github\/workflows\/pages\.yml"\n\s+workflow_dispatch:\s*$/m);
    expect(text()).not.toMatch(/pull_request|workflow_run|schedule:/);
  });

  it("can read the repository and publish Pages, and can do nothing else", () => {
    expect(text()).toMatch(/^permissions:\n\s+contents:\s*read\n\s+pages:\s*write\n\s+id-token:\s*write\s*$/m);
    expect(text().match(/:\s*write\b/g)).toHaveLength(2);
  });

  it("has no secret, no store step and no release step", () => {
    expect(text()).not.toMatch(/secrets\.|GITHUB_TOKEN|chrome-webstore|edge-add|release create|gh release|publish/i);
  });

  it("runs no project code: it installs nothing and builds nothing, so the pages go out as they were reviewed", () => {
    expect(text()).not.toMatch(/^\s*(?:-\s*)?run:/m);
  });

  it("uses only the three actions it has been reviewed for, each at a verified commit, and uploads exactly site/", () => {
    const actions = [...text().matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);

    expect(actions).toEqual(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9", "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346"]);
    expect(text()).toMatch(/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9\n\s+with:\n\s+path:\s*site\s*$/m);
  });

  it("deploys to the github-pages environment, one deployment at a time, and cannot run forever", () => {
    expect(text()).toMatch(/environment:\n\s+name:\s*github-pages/);
    expect(text()).toMatch(/concurrency:\n\s+group:\s*pages\n\s+cancel-in-progress:\s*false/);
    expect(text()).toMatch(/timeout-minutes:\s*\d+/);
  });
});
