// Reaching GitHub as skel's GitHub App: your sign-in, kept and renewed through skel's service,
// a token from the service for each repository, and GitHub's REST and GraphQL APIs with it.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// GitHub refuses API requests without a user agent.
const headers = { "user-agent": "skel-plugin-github", accept: "application/vnd.github+json" };

// Returns the folder skel gives the plugin for its settings and tokens.
export function settingsDir(): string {
  const dir = process.env.SKELCREW_PLUGIN_CONFIG;
  if (!dir) throw new Error("SKELCREW_PLUGIN_CONFIG isn't set: Skelcrew runs this plugin, not you");
  return dir;
}

// Returns a JSON file of the plugin's settings, or null when there is none yet.
function readJson(name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(settingsDir(), name), "utf8"));
  } catch {
    return null;
  }
}

// Writes a JSON file of the plugin's settings, readable only by you, as it holds tokens. It is
// written beside the old one and moved over it, so a call running at the same time never
// reads half a file.
export function writeJson(name: string, value: unknown): void {
  const file = join(settingsDir(), name);
  const fresh = `${file}.${process.pid}`;
  writeFileSync(fresh, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(fresh, file);
}

// Returns the value as a JSON object, or throws naming what was expected, so an answer from
// GitHub or the service that isn't what the plugin expects fails plainly instead of halfway.
export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value));
  throw new Error(`${what} isn't what the GitHub plugin expects`);
}

// Returns the value as text, or throws as `record` does.
export function text(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${what} isn't what the GitHub plugin expects`);
}

// Returns the value as a number, or throws as `record` does.
export function number(value: unknown, what: string): number {
  if (typeof value === "number") return value;
  throw new Error(`${what} isn't what the GitHub plugin expects`);
}

// Returns the value as a list, or throws as `record` does.
export function list(value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`${what} isn't what the GitHub plugin expects`);
}

// Your sign-in to skel's app, as setup saved it: the service's address, your GitHub login, and
// the user token with its refresh token, each with when it runs out, in milliseconds.
export type Settings = {
  service: string;
  login: string;
  access: string;
  accessExpires: number;
  refresh: string;
  refreshExpires: number;
};

// What you run to sign in again, which every SignInNeeded names.
const signInAgain = "run sc plugin setup github to sign in again";

// A failure only you can fix, by signing in again through the plugin's setup. call.ts and
// credentials.ts exit with code 2 for it, which Skelcrew reads as "this plugin needs its setup
// again", so the error you see names the command.
export class SignInNeeded extends Error {}

// Returns your saved sign-in, or throws saying how to sign in when there is none.
export function settings(): Settings {
  const saved = readJson("settings.json");
  if (saved === null) throw new SignInNeeded(`GitHub isn't set up: ${signInAgain}`);
  const s = record(saved, "the plugin's settings.json");
  return {
    service: text(s.service, "the service's address"),
    login: text(s.login, "your GitHub login"),
    access: text(s.access, "your sign-in"),
    accessExpires: number(s.accessExpires, "when your sign-in runs out"),
    refresh: text(s.refresh, "your refresh token"),
    refreshExpires: number(s.refreshExpires, "when your refresh token runs out"),
  };
}

// Returns a sign-in from what GitHub's device flow or the service's renewal gave, with when
// each part runs out counted from now.
export function signInFrom(given: unknown, service: string, login: string): Settings {
  const got = record(given, "GitHub's sign-in");
  return {
    service,
    login,
    access: text(got.access_token, "GitHub's user token"),
    accessExpires: Date.now() + number(got.expires_in, "when the user token runs out") * 1000,
    refresh: text(got.refresh_token, "GitHub's refresh token"),
    refreshExpires:
      Date.now() + number(got.refresh_token_expires_in, "when the refresh token runs out") * 1000,
  };
}

// Runs the work while holding the plugin's lock on your sign-in. A refresh token works once,
// and skel runs several calls at once, so two renewing together would spend it twice and the
// second would lose your sign-in. A lock left over a minute belongs to a call that died.
async function holdingSignIn<T>(work: () => Promise<T>): Promise<T> {
  const lock = join(settingsDir(), "sign-in.lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const since = statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
      if (Date.now() - since > 60_000) rmSync(lock, { recursive: true, force: true });
      else await Bun.sleep(100);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// A sign-in or token with less than this left is renewed first, so it never runs out mid-call.
const margin = 5 * 60_000;

// Returns your user token, renewed through the service first when it is about to run out, or
// at once with `stale`, when GitHub no longer accepted it. Renewing needs the app's secret, so
// only the service can. Read again under the lock, as another call may have renewed it.
async function userToken(stale = false): Promise<Settings> {
  const before = settings();
  if (!stale && before.accessExpires - Date.now() > margin) return before;
  return holdingSignIn(async () => {
    const now = settings();
    if (now.access !== before.access && now.accessExpires - Date.now() > margin) return now;
    if (now.refreshExpires < Date.now())
      throw new SignInNeeded(`your GitHub sign-in ran out: ${signInAgain}`);
    const response = await fetch(`${now.service}/github/renew`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: now.refresh }),
    });
    // A 401 is the service saying the refresh token is no good, so only a new sign-in helps.
    // Any other failure, such as the service being down, may pass on its own.
    if (response.status === 401)
      throw new SignInNeeded(
        `couldn't renew your GitHub sign-in: ${await said(response)}: ${signInAgain}`,
      );
    if (!response.ok)
      throw new Error(`couldn't renew your GitHub sign-in: ${await said(response)}`);
    const renewed = signInFrom(await response.json(), now.service, now.login);
    writeJson("settings.json", renewed);
    return renewed;
  });
}

// Returns what an answer that failed says, from the service's or GitHub's own words.
async function said(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = record(JSON.parse(body), "an error");
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return `GitHub said ${parsed.message}`;
  } catch {}
  return `HTTP ${response.status}`;
}

// Asks skel's service something with your sign-in, and returns its answer, or null when it
// answers with nothing. A sign-in GitHub stopped accepting before its time is renewed and the
// question asked once more. Throws the service's own words when it refuses.
export async function askService(path: string, body: object): Promise<unknown> {
  let sign = await userToken();
  for (let tries = 0; ; tries++) {
    const response = await fetch(`${sign.service}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `Bearer ${sign.access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 && tries === 0) {
      sign = await userToken(true);
      continue;
    }
    if (!response.ok) throw new Error(await said(response));
    return response.status === 204 ? null : response.json();
  }
}

// Returns a token from skel's app for the repository, reused while it has more than a few
// minutes left. The service makes it for that repository alone, for an hour.
export async function repositoryToken(repository: string): Promise<string> {
  const saved = readJson("tokens.json");
  const tokens = saved === null ? {} : record(saved, "the plugin's tokens.json");
  const known = tokens[repository];
  if (typeof known === "object" && known !== null) {
    const { token, expires } = record(known, "a saved token");
    if (
      typeof token === "string" &&
      Date.parse(text(expires, "a token's end")) - Date.now() > margin
    )
      return token;
  }
  const made = record(await askService("/github/token", { repository }), "the service's token");
  const token = text(made.token, "the service's token");
  // Read again, as another call may have saved a token for another repository meanwhile.
  const now = readJson("tokens.json");
  writeJson("tokens.json", {
    ...(now === null ? {} : record(now, "the plugin's tokens.json")),
    [repository]: { token, expires: text(made.expires, "when the token runs out") },
  });
  return token;
}

// Returns GitHub's answer to a REST request as your sign-in, which says what you can do,
// rather than what the app can.
export async function asYou(path: string): Promise<{ status: number; body: unknown }> {
  const sign = await userToken();
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { ...headers, authorization: `Bearer ${sign.access}` },
  });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

// Sends a REST request to GitHub about a repository, as skel's app, and returns its status and
// JSON body. A failure GitHub explains throws with what it was doing, unless its status is
// one of `allowed`, which the caller handles.
export async function rest(
  repository: string,
  doing: string,
  method: string,
  path: string,
  body?: object,
  allowed: number[] = [],
): Promise<{ status: number; body: unknown }> {
  const token = await repositoryToken(repository);
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      ...headers,
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok && !allowed.includes(response.status))
    throw new Error(`couldn't ${doing}: ${await said(response)}`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// Sends a GraphQL query to GitHub as skel's app, and returns its data. GitHub answers some
// errors with a 200 and an `errors` list, which throw too.
export async function graphql(repository: string, doing: string, query: string): Promise<unknown> {
  const token = await repositoryToken(repository);
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`couldn't ${doing}: ${await said(response)}`);
  const got = record(await response.json(), "GitHub's answer");
  const [error] = Array.isArray(got.errors) ? got.errors : [];
  if (error !== undefined)
    throw new Error(
      `couldn't ${doing}: GitHub said ${text(record(error, "an error").message, "an error")}`,
    );
  return got.data;
}
