import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import en from "../../_locales/en/messages.json";
import { GITHUB_REPO_URL, SECURITY_POLICY_URL } from "../../src/shared/links";

/**
 * Issue forms (Phase 4 Task 12). These checks read the YAML as text: they are a
 * structural sanity check, not GitHub's schema validation, and nothing here proves
 * GitHub will render the forms - that can only be seen on the pushed repository
 * (Task 45). What they do pin is what the forms must say and must not do.
 */
const DIR = join(process.cwd(), ".github", "ISSUE_TEMPLATE");
const TYPES = ["markdown", "input", "textarea", "dropdown", "checkboxes"];

function read(name: string): string {
  const path = join(DIR, name);
  expect(existsSync(path), `${name} exists`).toBe(true);
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

interface Block {
  type: string;
  text: string;
  id?: string;
}

function blocksOf(yaml: string): Block[] {
  const start = yaml.indexOf("\nbody:\n");
  expect(start, "has a body:").toBeGreaterThan(-1);
  return yaml
    .slice(start + "\nbody:\n".length)
    .split(/\n(?=  - type: )/)
    .map((text) => ({
      text,
      type: /^ {2}- type: (\w+)/.exec(text)?.[1] ?? "?",
      id: /^ {4}id: ([\w-]+)$/m.exec(text)?.[1],
    }));
}

const block = (blocks: Block[], id: string) => blocks.find((b) => b.id === id);
const required = (b: Block | undefined) => /validations:\n\s+required: true/.test(b?.text ?? "");

describe.each(["bug_report.yml", "feature_request.yml"])("%s: form structure", (file) => {
  it("has the top-level keys GitHub needs, indents with spaces, and ends with a newline", () => {
    const yaml = read(file);

    for (const key of ["name", "description", "title", "labels", "body"]) expect(yaml).toMatch(new RegExp(`^${key}:`, "m"));
    expect(yaml).not.toContain("\t");
    expect(yaml.endsWith("\n")).toBe(true);
  });

  it("uses only known field types, gives every input a label, and keeps ids unique", () => {
    const blocks = blocksOf(read(file));

    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      expect(TYPES, `type of block ${b.id ?? b.text.slice(0, 30)}`).toContain(b.type);
      if (b.type !== "markdown") {
        expect(b.text, `${b.id} has attributes`).toMatch(/^ {4}attributes:/m);
        expect(b.text, `${b.id} has a label`).toMatch(/^ {6}label: \S/m);
        expect(b.id, "an id, so answers can be referred to").toMatch(/^[a-z][a-z0-9_-]*$/);
      }
    }
    const ids = blocks.map((b) => b.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains no link but the repository's own, and nothing that pre-fills an issue body", () => {
    const yaml = read(file);
    const urls = yaml.match(/https?:\/\/[^\s)>"']+/g) ?? [];

    for (const url of urls) expect(url.startsWith(GITHUB_REPO_URL), url).toBe(true);
    expect(yaml).not.toMatch(/body=|\?title=|&labels=/);
  });
});

describe("bug_report.yml", () => {
  const yaml = () => read("bug_report.yml");
  const blocks = () => blocksOf(yaml());

  it("asks for the browser, the extension version and how to reproduce it - all required", () => {
    expect(required(block(blocks(), "browser"))).toBe(true);
    expect(required(block(blocks(), "version"))).toBe(true);
    expect(required(block(blocks(), "steps"))).toBe(true);
    expect(block(blocks(), "browser")?.type).toBe("dropdown");
    expect(block(blocks(), "version")?.type).toBe("input");
  });

  it("offers Chrome and Edge as the supported browsers and marks any other as unsupported", () => {
    const options = block(blocks(), "browser")!.text;

    expect(options).toContain("Google Chrome (latest stable)");
    expect(options).toContain("Microsoft Edge (latest stable)");
    expect(options).toMatch(/Another Chromium browser \(not officially supported\)/);
    expect(options).not.toMatch(/Brave|Opera|Vivaldi|Firefox|Safari/);
  });

  it("asks for the diagnostics but does not require them, and names the About button that produces them", () => {
    const diagnostics = block(blocks(), "diagnostics");

    expect(diagnostics?.type).toBe("textarea");
    expect(required(diagnostics)).toBe(false);
    expect(diagnostics?.text).toContain(en.dashboard_about_copyDiagnostics.message);
    expect(diagnostics?.text).toContain(en.dashboard_sidebar_about.message);
    expect(diagnostics?.text).toMatch(/render: text/);
  });

  it("asks for the impact, and never asks for a backup, an export, or anyone's nicknames or notes", () => {
    expect(block(blocks(), "impact")?.type).toBe("textarea");

    // Field labels only (attributes.label): the warnings are allowed to name these things, the fields are not.
    const labels = [...yaml().matchAll(/^ {6}label: (.+)$/gm)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThanOrEqual(5);
    for (const label of labels) expect(label, label).not.toMatch(/backup|export|nickname|note/i);
  });

  it("warns, in English and Traditional Chinese, against pasting private data into a public issue", () => {
    const intro = blocks()[0].text;

    expect(intro).toContain("Do not post private data in a public issue");
    expect(intro).toContain("請勿在公開 Issue 貼上私人暱稱、備註、完整 JSON 備份或復原資料");
    for (const thing of ["nicknames", "notes", "json backup", "recovery export"]) expect(intro.toLowerCase()).toContain(thing);
  });

  it("sends security vulnerabilities and privacy leaks to the private channel, and asks people to confirm it is not one", () => {
    const b = blocks();

    // Every link in the warning - the English one and the Chinese one - is the policy page, and there are both.
    const links = [...b[0].text.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
    expect(links).toEqual([SECURITY_POLICY_URL, SECURITY_POLICY_URL]);
    expect(b[0].text).toMatch(/Security vulnerability or privacy leak\?/);
    const confirm = b.find((x) => x.type === "checkboxes");
    expect(confirm?.text).toMatch(/not a security vulnerability or a privacy leak/i);
    expect(confirm?.text).toMatch(/not included private nicknames, notes, a full JSON backup or a raw Recovery export/i);
    expect((confirm?.text.match(/required: true/g) ?? []).length).toBe(2);
  });

  it("labels the issue as a bug", () => {
    expect(yaml()).toMatch(/^labels: \["bug"\]/m);
  });
});

describe("feature_request.yml", () => {
  const yaml = () => read("feature_request.yml");

  it("asks for the problem and the proposal, both required", () => {
    const blocks = blocksOf(yaml());

    expect(required(block(blocks, "problem"))).toBe(true);
    expect(required(block(blocks, "proposal"))).toBe(true);
  });

  it("says the project is local-first, so proposals that need a server, telemetry or cloud sync are out of scope", () => {
    const intro = blocksOf(yaml())[0].text;

    for (const thing of ["local-first", "server", "telemetry", "cloud sync", "out of scope"]) expect(intro).toContain(thing);
  });

  it("asks people not to include private data, and labels the issue as an enhancement", () => {
    expect(blocksOf(yaml())[0].text).toMatch(/private data/i);
    expect(yaml()).toMatch(/^labels: \["enhancement"\]/m);
  });
});
