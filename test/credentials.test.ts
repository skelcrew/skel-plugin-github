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

test("a repository the app can't reach fails with the service's words", async () => {
  fake.route = (asked) =>
    asked.path === "/service/github/token"
      ? json({ error: "skel's GitHub App isn't installed" }, 404)
      : undefined;
  const { code, out, err } = await helper("get", "protocol=https\nhost=github.com\npath=simon/x\n");
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toContain("skel's GitHub App isn't installed");
});

test("storing or erasing a login does nothing", async () => {
  for (const action of ["store", "erase"]) {
    const { code, out } = await helper(action, "protocol=https\nhost=github.com\npassword=x\n");
    expect(code).toBe(0);
    expect(out).toBe("");
  }
  expect(fake.asked).toEqual([]);
});
