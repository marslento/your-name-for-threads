import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT, markdownTable } from "../fixtures/repoFiles";

/**
 * The release pipeline's approval gate and secrets (Phase 4 Task 38; review checklist 34, 38 and 39). A store credential is
 * released only to a job that names the approval environment, and a job that can write to the repository may only run
 * after one that did. Those are rules about the workflow, so they are checked as rules: the check is a function of the
 * workflow's text, it is shown to catch each way of breaking the rule on made-up workflows, and then it is run on the real
 * one. The document that tells the owner how to set the environment up is held to the workflow too: every secret the
 * workflow uses is in its table, and nothing else is.
 */
const ENVIRONMENT = "production-release";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const uncommented = (text: string) => text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, "")).join("\n");

/** Every job in a workflow, by name, with its block of text. */
function jobsOf(text: string): Record<string, string> {
  const at = text.indexOf("\njobs:\n");
  if (at === -1) return {};
  const chunks = text.slice(at + "\njobs:\n".length).split(/\n(?= {2}[a-z][\w-]*:\n)/);
  return Object.fromEntries(chunks.filter((chunk) => /^ {2}[a-z][\w-]*:/.test(chunk)).map((chunk) => [/^ {2}([a-z][\w-]*):/.exec(chunk)![1], chunk]));
}

function needsOf(block: string): string[] {
  const inline = /^ {4}needs:[ \t]*(.+)$/m.exec(block)?.[1];
  if (inline !== undefined) return inline.replace(/[[\]]/g, "").split(",").map((name) => name.trim()).filter(Boolean);
  const list = /^ {4}needs:\n((?: {6}- .+\n?)+)/m.exec(block)?.[1];
  return list ? list.split("\n").map((line) => line.replace(/^ {6}- /, "").trim()).filter(Boolean) : [];
}

const environmentOf = (block: string): string | undefined => /^ {4}environment:[ \t]*(\S+)[ \t]*$/m.exec(block)?.[1] ?? /^ {4}environment:\n {6}name:[ \t]*(\S+)/m.exec(block)?.[1];
const usesSecrets = (block: string) => /\bsecrets\./.test(block);
const canWrite = (block: string) => /^ {6}[a-z-]+: write\s*$/m.test(block);

/** What is wrong with a release workflow's use of the approval, in words. Empty when nothing is. */
function problems(workflow: string): string[] {
  const jobs = jobsOf(uncommented(workflow));
  const gated = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name) || jobs[name] === undefined) return false;
    seen.add(name);
    return environmentOf(jobs[name]) === ENVIRONMENT || needsOf(jobs[name]).some((needed) => gated(needed, seen));
  };
  const found: string[] = [];
  for (const [name, block] of Object.entries(jobs)) {
    const environment = environmentOf(block);
    if (environment !== undefined && environment !== ENVIRONMENT) found.push(`${name} is in the environment "${environment}", not ${ENVIRONMENT}`);
    if (usesSecrets(block) && environment !== ENVIRONMENT) found.push(`${name} uses a secret and is not in ${ENVIRONMENT}`);
    if (canWrite(block) && !gated(name)) found.push(`${name} can write and does not come after an approval`);
  }
  return found;
}

const WORKFLOW = [
  "name: X",
  "on: {}",
  "jobs:",
  "  package:",
  "    runs-on: ubuntu-latest",
  "    permissions:",
  "      contents: read",
  "    steps:",
  "      - run: echo hi",
].join("\n");
const withJobs = (...jobs: string[]) => `${WORKFLOW}\n${jobs.join("\n")}\n`;

describe("the approval rule, on made-up workflows", () => {
  const store = ["  chrome:", "    needs: package", "    runs-on: ubuntu-latest", `    environment: ${ENVIRONMENT}`, "    steps:", "      - run: node x", "        env:", "          TOKEN: ${{ secrets.CHROME_REFRESH_TOKEN }}"];

  it("accepts a store job that names the environment", () => {
    expect(problems(withJobs(...store))).toEqual([]);
  });

  it("accepts the same job with the environment written as a block", () => {
    const block = store.map((line) => (line === `    environment: ${ENVIRONMENT}` ? `    environment:\n      name: ${ENVIRONMENT}` : line));

    expect(problems(withJobs(...block))).toEqual([]);
  });

  it("finds a store job that uses a secret outside the environment", () => {
    expect(problems(withJobs(...store.filter((line) => !line.includes("environment:"))))).toEqual(["chrome uses a secret and is not in production-release"]);
  });

  it("finds a job that is in an environment with another name, which has no approval on it", () => {
    const other = store.map((line) => line.replace(ENVIRONMENT, "production"));

    expect(problems(withJobs(...other))).toEqual(expect.arrayContaining(["chrome is in the environment \"production\", not production-release", "chrome uses a secret and is not in production-release"]));
  });

  it("finds a job that uses a secret in a step, not only in a job-level env", () => {
    const release = ["  edge:", "    needs: package", "    runs-on: ubuntu-latest", "    steps:", "      - run: curl -H \"Authorization: ApiKey ${{ secrets.EDGE_API_KEY }}\" x"];

    expect(problems(withJobs(...release))).toEqual(["edge uses a secret and is not in production-release"]);
  });

  it("finds a job that can write and is not after an approval", () => {
    const write = ["  github-release:", "    needs: package", "    runs-on: ubuntu-latest", "    permissions:", "      contents: write", "    steps:", "      - run: gh release create"];

    expect(problems(withJobs(...write))).toEqual(["github-release can write and does not come after an approval"]);
  });

  it("accepts a job that can write when it comes after a job that has the approval, directly or through another", () => {
    const write = (needs: string) => ["  github-release:", `    needs: ${needs}`, "    runs-on: ubuntu-latest", "    permissions:", "      contents: write", "    steps:", "      - run: gh release create"];
    const chain = ["  publish:", "    needs: [chrome]", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo done"];

    expect(problems(withJobs(...store, ...write("[chrome, edge]")))).toEqual([]);
    expect(problems(withJobs(...store, ...chain, ...write("publish")))).toEqual([]);
  });

  it("finds a job that can write and comes after only jobs that have no approval", () => {
    const write = ["  github-release:", "    needs: [package]", "    runs-on: ubuntu-latest", "    permissions:", "      contents: write", "    steps:", "      - run: gh release create"];

    expect(problems(withJobs(...write))).toHaveLength(1);
  });

  it("reads a needs list written over several lines", () => {
    const write = ["  github-release:", "    needs:", "      - package", "      - chrome", "    runs-on: ubuntu-latest", "    permissions:", "      contents: write", "    steps:", "      - run: gh release create"];

    expect(problems(withJobs(...store, ...write))).toEqual([]);
  });

  it("does not take a comment for a secret or an environment", () => {
    const job = ["  package2:", "    runs-on: ubuntu-latest", "    # uses secrets.X and environment: something-else", "    steps:", "      - run: echo hi"];

    expect(problems(withJobs(...job))).toEqual([]);
  });

  it("does not loop on a job that needs itself", () => {
    const loop = ["  a:", "    needs: a", "    runs-on: ubuntu-latest", "    permissions:", "      contents: write", "    steps:", "      - run: x"];

    expect(problems(withJobs(...loop))).toEqual(["a can write and does not come after an approval"]);
  });
});

describe("the real release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  it("keeps every secret in a job behind the approval, and every job that can write after it", () => {
    expect(problems(workflow)).toEqual([]);
  });

  it("uses no secret named GITHUB_TOKEN: the built-in token is github.token, and secrets are the environment's", () => {
    expect(uncommented(workflow)).not.toMatch(/secrets\.GITHUB_TOKEN/);
  });

  it("names the approval environment only as production-release", () => {
    const names = [...uncommented(workflow).matchAll(/^ {4}environment:[ \t]*(\S+)/gm)].map((match) => match[1]);

    for (const name of names) expect(name).toBe(ENVIRONMENT);
  });
});

describe("the document", () => {
  const doc = read("docs/release/release-pipeline.md");
  const workflow = read(".github/workflows/release.yml");
  const jobs = jobsOf(uncommented(workflow));
  const documented = () => markdownTable(doc, "Secrets").slice(1).map(([name, usedBy]) => ({ name, usedBy }));
  const used = [...uncommented(workflow).matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);

  it("lists the secrets in a table: upper-case names, each for the chrome or the edge job, and each with where it comes from", () => {
    const [header, ...rows] = markdownTable(doc, "Secrets");

    expect(header).toEqual(["Secret", "Used by", "Where it comes from"]);
    expect(rows.length).toBeGreaterThan(0);
    for (const [name, usedBy, source] of rows) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(["chrome", "edge"]).toContain(usedBy);
      expect(name.startsWith(usedBy.toUpperCase() + "_"), `${name} belongs to ${usedBy}`).toBe(true);
      expect(source.length).toBeGreaterThan(10);
    }
  });

  it("documents every secret the workflow uses, and the workflow uses no secret that is not documented", () => {
    for (const name of used) expect(documented().map((row) => row.name), name).toContain(name);
  });

  it("is the whole list once the store jobs exist: each documented secret is used, by the job that the table names", () => {
    if (!jobs.chrome || !jobs.edge) return;

    expect(new Set(used)).toEqual(new Set(documented().map((row) => row.name)));
    for (const { name, usedBy } of documented()) expect(jobs[usedBy], `${name} in the ${usedBy} job`).toContain(`secrets.${name}`);
  });

  it("tells the owner how to set the environment up: its name, its reviewers, no bypass, tags only, environment secrets", () => {
    for (const phrase of ["`production-release`", "Required reviewers", "Prevent self-review", "Allow administrators to bypass", "Selected branches and tags", "`v*.*.*`", "environment secrets, not repository secrets", "Two-step sign-in"]) {
      expect(doc, phrase).toContain(phrase);
    }
  });

  it("says what protects main and the version tags, since the workflow trusts main and the tag", () => {
    expect(doc).toContain("Protect `main`");
    expect(doc).toContain("Protect the `v*` tags");
    expect(doc).toMatch(/refuses a commit that is not on `main`/);
  });

  it("says the first listing is manual, the path is stable only, and a fix is a new version", () => {
    expect(doc).toMatch(/manual first submission|first (?:listing|submission)[^.]+(?:by hand|manual)/i);
    expect(doc).toMatch(/Stable only/i);
    expect(doc).toMatch(/a fix is a new version/);
  });

  it("promises no rebuild and no credential in the repository, and says a test holds each", () => {
    expect(doc).toMatch(/Never rebuild to fix a failed upload/);
    expect(doc).toMatch(/a test refuses one anywhere in the repository/);
  });

  it("puts the approval where the release checklist says the artifact is smoked: before the stores", () => {
    const checklist = read("docs/release/release-checklist.md");

    expect(checklist).toContain("`docs/release/release-pipeline.md`");
  });
});

describe("the store scripts the document names", () => {
  const doc = read("docs/release/release-pipeline.md");
  const commands = [...doc.matchAll(/^node (scripts\/publish-[a-z]+\.mjs) (.+)$/gm)].map((match) => ({ script: match[1], rest: match[2] }));

  it("are real, one dry run is shown for each store, and each uses only flags its script has", () => {
    expect(commands.map((command) => command.script).sort()).toEqual(["scripts/publish-chrome.mjs", "scripts/publish-edge.mjs"]);
    for (const { script, rest } of commands) {
      const source = read(script);
      const flags = [...rest.matchAll(/--[a-z0-9-]+/g)].map((match) => match[0]);

      expect(flags).toContain("--dry-run");
      for (const flag of flags) expect(source, `${script} ${flag}`).toContain(`"${flag}"`);
    }
  });

  it.each([["scripts/publish-chrome.mjs", "CHROME_"], ["scripts/publish-edge.mjs", "EDGE_"]])("say which credentials %s needs, and each is a documented secret, and each documented secret of that store is needed", (script, prefix) => {
    const table = markdownTable(doc, "Secrets").slice(1).map(([name]) => name);
    const needed = [...read(script).matchAll(new RegExp(`"(${prefix}[A-Z_]+)"`, "g"))].map((match) => match[1]);

    expect(needed.length).toBeGreaterThan(0);
    for (const name of needed) expect(table, name).toContain(name);
    for (const name of table.filter((secret) => secret.startsWith(prefix))) expect(needed, name).toContain(name);
  });

  it("promise a re-run is safe only for a store whose script does what the document says: it reads the store first, and refuses what a person must decide", () => {
    const source = read("scripts/publish-chrome.mjs");

    expect(doc).toMatch(/Chrome script reads what the store already has before it acts/);
    expect(source).toContain("fetchStatus");
    for (const state of ["PENDING_REVIEW", "PUBLISHED"]) expect(source).toContain(state);
    for (const refusal of ["pending review; cancel that submission", "is not newer", "taken down"]) expect(source).toContain(refusal);
  });

  it("say plainly that Edge cannot promise the same, because its API has no way to read what the store holds, and the script does not pretend to", () => {
    const source = read("scripts/publish-edge.mjs");

    expect(doc).toMatch(/The Edge API cannot be asked what the store already holds/);
    expect(source).not.toMatch(/fetchStatus|already-submitted|already-published/);
    expect(source).toMatch(/no way to read what the store already holds/);
  });

  it("describe the notes for certification the Edge script sends: at most 4000 characters, and the reviewer's instructions from the listing document", () => {
    const max = Number(/MAX_NOTES = (\d+)/.exec(read("scripts/publish-edge.mjs"))![1]);

    expect(doc).toContain(`at most ${max} characters`);
    expect(doc).toContain("docs/release/edge-store-listing.md");
  });
});
