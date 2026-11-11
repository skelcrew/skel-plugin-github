// Tests of the plugin's git credential helper, run as git runs it, against a fake skel's
// service.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { json, removeSettings, run, signedIn, startFake } from "./fake.ts";

const fake = startFake();
afterAll(() => fake.stop());
let dir = "";

beforeEach(() => {
  dir = signedIn();
  fake.asked = [];
  fake.route = (asked) =>
    asked.path === "/service/github/token" && JSON.parse(asked.body).repository === "simon/app"
      ? json({ token: "ghs_app", expires: new Date(Date.now() + 3600_000).toISOString() })
      : undefined;
});
afterEach(() => removeSettings(dir));

const helper = (action: string, input: string) =>
  run(fake.url, dir, ["credentials.ts", action], input);

test("git gets the repository's token from skel's app, as x-access-token", async () => {
  const { code, out } = await helper(
    "get",
    "protocol=https\nhost=github.com\npath=simon/app.git\n\n",
  );
  expect(code).toBe(0);
  expect(out).toBe("username=x-access-token\npassword=ghs_app\n");
});

test("git gets nothing for another host, or without the repository's path", async () => {
  for (const input of [
    "protocol=https\nhost=gitlab.com\npath=simon/app.git\n",
    "protocol=https\nhost=github.com\n",
  ]) {
    const { code, out } = await helper("get", input);
    expect(code).toBe(0);
    expect(out).toBe("");
  }
  expect(fake.asked).toEqual([]);
});

test("a repository the app isn't installed on exits 2, so Skelcrew runs the setup", async () => {
  fake.route = (asked) =>
    asked.path === "/service/github/token"
      ? json({ error: "skel's GitHub App isn't installed" }, 404)
      : undefined;
  const { code, out, err } = await helper("get", "protocol=https\nhost=github.com\npath=simon/x\n");
  expect(code).toBe(2);
  expect(out).toBe("");
  expect(err).toBe("Skelcrew's GitHub App isn't installed on simon/x\n");
});

test("any other refusal fails with the service's words", async () => {
  fake.route = (asked) =>
    asked.path === "/service/github/token"
      ? json({ error: "too many requests: wait a minute" }, 429)
      : undefined;
  const { code, out, err } = await helper("get", "protocol=https\nhost=github.com\npath=simon/x\n");
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toContain("too many requests: wait a minute");
});

test("a lapsed sign-in exits 2, naming the command that signs in again", async () => {
  removeSettings(dir);
  dir = signedIn({ accessExpires: Date.now() - 1000, refreshExpires: Date.now() - 1000 });
  const { code, err } = await helper("get", "protocol=https\nhost=github.com\npath=simon/app\n");
  expect(code).toBe(2);
  expect(err.trim()).toBe(
    "your GitHub sign-in ran out: run sc plugin setup github to sign in again",
  );
});

test("storing or erasing a login does nothing", async () => {
  for (const action of ["store", "erase"]) {
    const { code, out } = await helper(action, "protocol=https\nhost=github.com\npassword=x\n");
    expect(code).toBe(0);
    expect(out).toBe("");
  }
  expect(fake.asked).toEqual([]);
});
