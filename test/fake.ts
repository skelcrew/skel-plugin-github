// A fake GitHub and a fake skel's service in one local server, and a way to run the plugin's
// commands against them as skel does, each test with a settings folder of its own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One request the fake was sent. `path` starts with /api for GitHub's API, /web for
// github.com and /service for skel's service.
export type Asked = { method: string; path: string; auth: string | null; body: string };

// The fake's answer to a request, or undefined for a 404.
export type Route = (asked: Asked) => Response | undefined;

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// Starts the fake. Each test sets `route`, and reads what it was asked in `asked`.
export function startFake() {
  const fake = {
    asked: [] as Asked[],
    route: (() => undefined) as Route,
    url: "",
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const asked = {
        method: request.method,
        path: url.pathname + url.search,
        auth: request.headers.get("authorization"),
        body: await request.text(),
      };
      fake.asked.push(asked);
      return fake.route(asked) ?? json({ message: "Not Found" }, 404);
    },
  });
  fake.url = `http://localhost:${server.port}`;
  fake.stop = () => server.stop(true);
  return fake;
}

// Returns a new settings folder, signed in as simon with a sign-in good for hours, through
// skel's service at skelcrew.dev. Removed by `removeSettings`.
export function signedIn(overrides: object = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-github-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      service: "https://skelcrew.dev",
      login: "simon",
      access: "user-token",
      accessExpires: Date.now() + 8 * 3600_000,
      refresh: "refresh-1",
      refreshExpires: Date.now() + 100 * 24 * 3600_000,
      ...overrides,
    }),
  );
  return dir;
}

export const removeSettings = (dir: string) => rmSync(dir, { recursive: true, force: true });

const root = join(import.meta.dir, "..");

// Runs one of the plugin's commands as skel does, over SSH, in the plugin's folder with its settings
// folder, with its requests sent to the fake, and `more` in its environment. Returns its exit
// code and output.
export async function run(
  fakeUrl: string,
  dir: string,
  words: string[],
  input: string,
  more: Record<string, string> = {},
) {
  const child = Bun.spawn(
    [process.execPath, "--preload", join(root, "test", "redirect.ts"), ...words],
    {
      cwd: root,
      // As over SSH, so setup prints its links and never opens a browser.
      env: {
        ...process.env,
        SKELCREW_PLUGIN: "github",
        SKELCREW_PLUGIN_CONFIG: dir,
        FAKE_GITHUB: fakeUrl,
        SSH_CONNECTION: "test",
        SKELCREW_REMOTE: "",
        ...more,
      },
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}
