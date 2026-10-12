import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/repoFiles";

// Credentials and repository writes must stay behind release approval.
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
});
