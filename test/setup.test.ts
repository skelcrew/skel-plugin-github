// Tests of the plugin's setup, as you go through it in your terminal, against a fake GitHub
// and a fake skel's service.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asked, json, removeSettings, run, signedIn, startFake } from "./fake.ts";

const fake = startFake();
afterAll(() => fake.stop());
let dir = "";
let polls = 0;
// What GET /user/installations answers, one list per time it is asked; the last one stays.
let installed: object[][] = [];
// The repositories each installation covers, by its ID.
let covers: Record<string, string[]> = {};

const install = "https://github.com/apps/skelcrew/installations/new";
const onSimon = (selection = "selected") => ({
  id: 9,
  app_slug: "skelcrew",
  account: { login: "simon", id: 1234 },
  repository_selection: selection,
  html_url: "https://github.com/settings/installations/9",
});
const app = "git@github.com:simon/app.git";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skelcrew-github-"));
  fake.asked = [];
  polls = 0;
  installed = [[], [onSimon()]];
  covers = { "9": ["simon/app"] };
  fake.route = (asked) => {
    if (asked.path === "/service/github") return json({ install, client_id: "Iv1.app" });
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
    // As GitHub answers a sign-in it no longer accepts.
    if (asked.path === "/api/user") return json({ message: "Bad credentials" }, 401);
    // Anyone may read a public repository, with no sign-in.
    if (asked.path === "/api/repos/simon/app" && asked.auth === null)
      return json({ id: 5678, private: false, owner: { login: "simon", id: 1234 } });
    if (asked.path.startsWith("/api/user/installations?") && asked.auth === "Bearer user-token") {
      const now = installed.length > 1 ? installed.shift() : installed[0];
      return json({ total_count: now?.length ?? 0, installations: now ?? [] });
    }
    const listed = asked.path.match(/^\/api\/user\/installations\/(\d+)\/repositories\?/);
    // As GitHub does, a page at a time, 30 unless asked for up to 100.
    if (listed?.[1] && asked.auth === "Bearer user-token") {
      const names = covers[listed[1]] ?? [];
      const query = new URLSearchParams(asked.path.split("?")[1]);
      const size = Math.min(Number(query.get("per_page") ?? 30), 100);
      const page = Number(query.get("page") ?? 1);
      return json({
        total_count: names.length,
        repositories: names
          .slice((page - 1) * size, page * size)
          .map((full_name) => ({ full_name })),
      });
    }
    return undefined;
  };
});
afterEach(() => removeSettings(dir));

const asked = (path: string): Asked[] => fake.asked.filter((a) => a.path.startsWith(path));

test("setup signs you in, has you install the app on the checkout's repository with it picked, and sees the install", async () => {
  const { code, out, err } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toBe(
    [
      "Sign in to GitHub: open https://github.com/login/device and enter ABCD-1234.",
      "Signed in to GitHub as simon.",
      "Skelcrew's GitHub App needs to be installed on simon/app. Open this link:",
      `${install}/permissions?suggested_target_id=1234&repository_ids[]=5678`,
      "Skelcrew's GitHub App is on simon/app.",
      "",
    ].join("\n"),
  );
  const device = new URLSearchParams(asked("/web/login/device/code")[0]?.body);
  expect(device.get("client_id")).toBe("Iv1.app");
  const file = join(dir, "settings.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved).toMatchObject({
    service: "https://skelcrew.dev",
    login: "simon",
    access: "user-token",
    refresh: "refresh-1",
  });
  expect(saved.accessExpires).toBeGreaterThan(Date.now() + 7 * 3600_000);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

// GitHub picks a repository on the install page only by its ID, which no one outside can read
// for a private repository, and leaving it out would pick every repository.
test("for a private repository, the install page opens with nothing picked", async () => {
  const before = fake.route;
  fake.route = (a) => (a.path === "/api/repos/simon/app" ? undefined : before(a));
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(code).toBe(0);
  expect(out).toContain(`Open this link:\n${install}\n`);
  expect(out).not.toContain("repository_ids");
  expect(out).toContain("Skelcrew's GitHub App is on simon/app.");
});

test("when the app is on the repository already, there is nothing to install", async () => {
  installed = [[onSimon()]];
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(code).toBe(0);
  expect(out).not.toContain("needs to be installed");
  expect(out).toEndWith("Signed in to GitHub as simon.\n");
});

test("an install that covers the repository on a later page needs nothing more", async () => {
  installed = [[onSimon()]];
  const many = Array.from({ length: 150 }, (_, at) => `simon/repo-${at}`);
  covers = { "9": [...many, "simon/app"] };
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(code).toBe(0);
  expect(out).not.toContain("needs to be installed");
});

test("an app installed on all your repositories covers this one too", async () => {
  installed = [[onSimon("all")]];
  covers = {};
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(code).toBe(0);
  expect(out).not.toContain("needs to be installed");
});

// GitHub doesn't say what its new-install page does for an account that has the app already,
// so setup opens that install's own page, where the repository is added.
test("when the app is on your account but not this repository, the link is that install's page", async () => {
  installed = [[onSimon()]];
  covers = { "9": ["simon/site"] };
  const before = fake.route;
  let lists = 0;
  // You add the repository once the page has been shown, after the first look.
  fake.route = (a) => {
    if (a.path.startsWith("/api/user/installations/9/repositories?") && ++lists === 2)
      covers = { "9": ["simon/site", "simon/app"] };
    return before(a);
  };
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(code).toBe(0);
  expect(out).toContain("Open this link:\nhttps://github.com/settings/installations/9\n");
  expect(out).toContain("Skelcrew's GitHub App is on simon/app.");
});

test("outside a checkout on GitHub, setup waits for the app on any repository", async () => {
  for (const remote of [undefined, "git@gitlab.com:simon/app.git"]) {
    installed = [[], [onSimon()]];
    const { code, out } = await run(
      fake.url,
      dir,
      ["setup.ts"],
      "",
      remote ? { SKELCREW_REMOTE: remote } : {},
    );
    expect(code).toBe(0);
    expect(out).toContain(
      `Skelcrew's GitHub App needs to be installed on your repositories. Open this link:\n${install}\n`,
    );
    expect(out).toContain("Skelcrew's GitHub App is installed.");
  }
  expect(asked("/api/repos/")).toEqual([]);
});

test("on a desktop, Enter opens each page in your browser, and the links aren't printed", async () => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$1" >> "${join(dir, "opened")}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "\n\n", {
    SKELCREW_REMOTE: app,
    SSH_CONNECTION: "",
    SSH_TTY: "",
    DISPLAY: ":0",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  expect(code).toBe(0);
  expect(out).toContain(
    "Sign in to GitHub with the code ABCD-1234. Press Enter to open your browser.",
  );
  expect(out).toContain(
    "Skelcrew's GitHub App needs to be installed on simon/app. Press Enter to open your browser.",
  );
  expect(out).not.toContain("https://");
  expect(readFileSync(join(dir, "opened"), "utf8")).toBe(
    `https://github.com/login/device\n${install}/permissions?suggested_target_id=1234&repository_ids[]=5678\n`,
  );
});

test("setup never asks for the service, and uses the one named in the settings folder", async () => {
  writeFileSync(join(dir, "service"), `${fake.url}/service/\n`);
  const { code, out } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(code).toBe(0);
  expect(out).not.toContain("service");
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).service).toBe(
    `${fake.url}/service`,
  );
});

test("setup fails plainly when you don't authorize skel", async () => {
  fake.route = (
    (before) => (a: Asked) =>
      a.path === "/web/login/oauth/access_token" ? json({ error: "access_denied" }) : before(a)
  )(fake.route);
  const { code, err } = await run(fake.url, dir, ["setup.ts"], "");
  expect(code).toBe(1);
  expect(err).toContain("you didn't authorize Skelcrew on GitHub");
});

// So sc can run setup for a repository whose app isn't installed, with only the install to do.
test("a sign-in that still works isn't asked for again, and setup goes straight to the app", async () => {
  removeSettings(dir);
  dir = signedIn();
  const { code, out, err } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toBe(
    [
      "Skelcrew's GitHub App needs to be installed on simon/app. Open this link:",
      `${install}/permissions?suggested_target_id=1234&repository_ids[]=5678`,
      "Skelcrew's GitHub App is on simon/app.",
      "",
    ].join("\n"),
  );
  expect(asked("/web/login/device/code")).toEqual([]);
});

test("a sign-in GitHub refuses, or one with another service, is asked for again", async () => {
  removeSettings(dir);
  dir = signedIn({ access: "revoked" });
  const refused = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(refused.code).toBe(0);
  expect(refused.out).toContain("Signed in to GitHub as simon.");
  removeSettings(dir);
  dir = signedIn();
  writeFileSync(join(dir, "service"), `${fake.url}/service\n`);
  const moved = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(moved.code).toBe(0);
  expect(moved.out).toContain("Signed in to GitHub as simon.");
});

// A GitHub that is down or limiting requests says nothing about the sign-in, so asking you to
// sign in again would only hide what went wrong.
test("when GitHub can't answer, setup says so instead of asking you to sign in again", async () => {
  removeSettings(dir);
  dir = signedIn();
  fake.route = (
    (before) => (a: Asked) =>
      a.path === "/api/user" ? json({ message: "Service Unavailable" }, 503) : before(a)
  )(fake.route);
  const { code, err } = await run(fake.url, dir, ["setup.ts"], "", { SKELCREW_REMOTE: app });
  expect(code).toBe(1);
  expect(err).toContain("503");
  expect(asked("/web/login/device/code")).toEqual([]);
});
