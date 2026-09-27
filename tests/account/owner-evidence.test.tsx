import { afterEach, expect, it } from "vitest";

import { startThreadsPrivateDirectory } from "../../src/content/index";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { surfaceHealth } from "../../src/shared/surfaceHealth";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE_DIR, AT, BOB, BOB_DIR, directory, twoAccounts } from "../fixtures/storage/recoveryStorage";

/**
 * Codex Security scan 092502, findings 1, 2 and 4: the identity cache is fed by page messages anyone on the page can
 * forge, and by several tabs at once, so a username it knows must never choose the account whose Directory opens.
 * This runs the real content script and the real resolver over storage whose cache maps `bob` to Bob's account,
 * on a page whose navigation links to `/@bob`. Only the bootstrap naming Bob may open Bob's Directory.
 */
const storage = () =>
  twoAccounts({
    directories: {
      [ALICE_DIR]: directory(ALICE_DIR),
      [BOB_DIR]: directory(BOB_DIR, {
        contacts: { c2: { id: "c2", username: "dave", nickname: "小華", createdAt: AT, updatedAt: AT, identityUpdatedAt: AT } },
        identityIndex: { "username:dave": "c2" },
      }),
    },
    identityCache: { bob: { username: "bob", threadsUserId: BOB, source: "network", observedAt: AT, expiresAt: "2099-01-01T00:00:00.000Z" } },
  });

const bootstrapNamingBob = `<script type="application/json" data-sjs>${JSON.stringify({
  require: [["ScheduledServerJS", "handle", null, [{ __bbox: { define: [["BarcelonaSharedData", [], { viewer: { id: BOB, username: "bob" } }, 1]] } }]]],
})}</script>`;
const davesPost = `
  <div class="post">
    <div class="header">
      <span class="identity"><a href="https://www.threads.com/@dave">dave</a></span>
      <span class="meta"><a href="/t/topic">topic</a><span>·</span><time>2h</time></span>
    </div>
  </div>`;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const label = () => document.querySelector("[data-tpd-nickname]")?.textContent ?? null;

let stop: () => void = () => undefined;

function open(bootstrap: string) {
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = `${bootstrap}<nav><a href="/@bob">bob</a></nav>${davesPost}`;
  installFakeChrome(storage(), backgroundSendMessage());
  stop = startThreadsPrivateDirectory(window, document);
}

afterEach(() => {
  stop();
  surfaceHealth.reset();
  __resetDiagnosticReportsForTests();
  __resetMigrationCoordinatorForTests();
  Reflect.deleteProperty(globalThis, "chrome");
  document.body.replaceChildren();
});

it("(control) opens Bob's Directory when the bootstrap names Bob, so the page can show his nickname for dave", async () => {
  open(bootstrapNamingBob);

  for (let turn = 0; turn < 50 && label() === null; turn += 1) await wait(10);

  expect(label()).toBe("[小華]");
});

it("does not open it from the navigation's link to Bob and the cache's ID for him, without the bootstrap", async () => {
  open("");

  await wait(500);

  expect(label()).toBeNull();
});
