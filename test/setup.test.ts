// Tests of the plugin's setup, as you go through it in your terminal, against a fake GitHub
// and a fake skel's service.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, removeSettings, run, startFake } from "./fake.ts";

const fake = startFake();
afterAll(() => fake.stop());
let dir = "";
let polls = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skel-plugin-github-"));
  fake.asked = [];
  polls = 0;
  fake.route = (asked) => {
    if (asked.path === "/service/")
      return json({
        install: "https://github.com/apps/skel/installations/new",
        client_id: "Iv1.app",
      });
    if (asked.path === "/web/login/device/code")
      return json({
        device_code: "device-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 0,
        expires_in: 900,
      });
    if (asked.path === "/web/login/oauth/access_token") {
      polls++;
      if (polls === 1) return json({ error: "authorization_pending" });
      return json({
        access_token: "user-token",
        expires_in: 28800,
        refresh_token: "refresh-1",
        refresh_token_expires_in: 15724800,
        token_type: "bearer",
      });
    }
    if (asked.path === "/api/user" && asked.auth === "Bearer user-token")
      return json({ login: "simon" });
    return undefined;
  };
});
afterEach(() => removeSettings(dir));

test("setup shows the install page, signs you in with a code, and saves the sign-in", async () => {
  // Enter takes skel.run as the service, then says the app is installed.
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "\n\n");
  expect(code).toBe(0);
  expect(out).toContain("https://github.com/apps/skel/installations/new");
  expect(out).toContain("open https://github.com/login/device and enter ABCD-1234");
  expect(out).toContain("Signed in to GitHub as simon.");
  const asked = new URLSearchParams(
    fake.asked.find((a) => a.path === "/web/login/device/code")?.body,
  );
  expect(asked.get("client_id")).toBe("Iv1.app");
  const file = join(dir, "settings.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved).toMatchObject({
    service: "https://skel.run",
    login: "simon",
    access: "user-token",
    refresh: "refresh-1",
  });
  expect(saved.accessExpires).toBeGreaterThan(Date.now() + 7 * 3600_000);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("setup takes another service's address, for one you run yourself", async () => {
  const { code } = await run(fake.url, dir, ["setup.ts"], `${fake.url}/service/\n\n`);
  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).service).toBe(
    `${fake.url}/service`,
  );
});

test("setup fails plainly when you don't authorize skel", async () => {
  fake.route = (
    (before) => (asked: Parameters<typeof before>[0]) =>
      asked.path === "/web/login/oauth/access_token"
        ? json({ error: "access_denied" })
        : before(asked)
  )(fake.route);
  const { code, err } = await run(fake.url, dir, ["setup.ts"], "\n\n");
  expect(code).toBe(1);
  expect(err).toContain("you didn't authorize skel on GitHub");
});
