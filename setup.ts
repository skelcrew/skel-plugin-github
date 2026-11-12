// The plugin's setup, run in your terminal when Skelcrew installs it: it signs you in to Skelcrew's
// GitHub App with GitHub's device flow, then has you install the app on the repository Skelcrew
// was run in, so nothing is pasted. Run again, it skips what is done already, such as a
// sign-in that still works, so Skelcrew can run it just to install the app.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asYou,
  githubRemote,
  list,
  record,
  SetupNeeded,
  settings,
  settingsDir,
  signInFrom,
  text,
  writeJson,
} from "./github.ts";

const headers = { "user-agent": "skelcrew-github", accept: "application/json" };

// Returns the program that opens a page in your browser when this machine has one you sit at:
// a Mac, or a Linux desktop. Over SSH or on a Sprite the browser would be on another screen or
// none, so there is none, and setup prints the link instead.
function opener(): string | null {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return null;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? "xdg-open"
        : null;
  return command && Bun.which(command) ? command : null;
}

// Sends you to a page: at a desktop, `ask` waits for Enter and opens it in your browser, and
// elsewhere `elsewhere` says what to do with the link, on any device.
function sendTo(url: string, ask: string, elsewhere: (url: string) => string): void {
  const command = opener();
  if (!command) {
    console.log(elsewhere(url));
    return;
  }
  prompt(ask);
  Bun.spawnSync([command, url], { stdout: "ignore", stderr: "ignore" });
}

// Returns GitHub's sign-in once you have authorized Skelcrew's app with the code shown, through
// GitHub's device flow, which needs only the app's client ID. GitHub says how often to ask,
// and to ask more slowly when it answers slow_down.
async function deviceFlow(clientId: string): Promise<unknown> {
  const started = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers,
    body: new URLSearchParams({ client_id: clientId }),
  });
  if (!started.ok) throw new Error(`GitHub didn't start a sign-in: HTTP ${started.status}`);
  const device = record(await started.json(), "GitHub's sign-in");
  const code = text(device.user_code, "GitHub's code");
  const link = text(device.verification_uri, "GitHub's link");
  let wait = typeof device.interval === "number" ? device.interval : 5;
  // The code is what you type on GitHub's page, so it stands out in bold. Only in a terminal
  // that shows bold, so a log or a pipe gets the plain code.
  const bold =
    Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const shown = bold ? `\x1b[1m${code}\x1b[22m` : code;
  sendTo(
    link,
    `Sign in to GitHub with the code ${shown}. Press Enter to open your browser.`,
    (url) => `Sign in to GitHub: open ${url} and enter ${shown}.`,
  );
  for (;;) {
    await Bun.sleep(wait * 1000);
    const asked = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers,
      body: new URLSearchParams({
        client_id: clientId,
        device_code: text(device.device_code, "GitHub's device code"),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const got = record(await asked.json(), "GitHub's sign-in");
    if (got.error === "authorization_pending") continue;
    if (got.error === "slow_down") {
      wait += 5;
      continue;
    }
    if (got.error === "expired_token") throw new Error("the code ran out: run the setup again");
    if (got.error === "access_denied") throw new Error("you didn't authorize Skelcrew on GitHub");
    if (typeof got.error === "string") throw new Error(`GitHub refused the sign-in: ${got.error}`);
    return got;
  }
}

// Returns the service's address: skelcrew.dev, unless the settings folder has a file named
// service with the address of one you run yourself.
function serviceAddress(): string {
  const file = join(settingsDir(), "service");
  const named = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return (named || "https://skelcrew.dev").replace(/\/+$/, "");
}

// Reports whether the saved sign-in still works with this service, renewing it first if it
// must, so setup asks you to sign in only when it has to. One saved for another service, such
// as before you named your own, doesn't count, as its renewals go through that service.
async function stillSignedIn(service: string): Promise<boolean> {
  // A settings file that is missing or can't be read is replaced by signing in, as setup is
  // what fixes it.
  try {
    if (settings().service !== service) return false;
  } catch {
    return false;
  }
  try {
    // Only a 401 means GitHub refused the sign-in. Any other failure, such as GitHub being down
    // or limiting requests, says nothing about it, and signing in again wouldn't help.
    const { status } = await asYou("/user");
    if (status === 401) return false;
    if (status !== 200)
      throw new Error(`GitHub couldn't check your sign-in: it answered ${status}`);
    return true;
  } catch (error) {
    // A sign-in that can't be renewed. Anything else, such as no network, is setup's failure
    // too, and is said as it is.
    if (error instanceof SetupNeeded) return false;
    throw error;
  }
}

type Installation = { id: number; owner: string; all: boolean; page: string };

// Returns the app's installations you can see with your sign-in. The app is known by its slug,
// the name in its install page's address. Only the first hundred are read, far more than one
// person's accounts.
async function installations(slug: string): Promise<Installation[]> {
  const found = await asYou("/user/installations?per_page=100");
  if (found.status !== 200)
    throw new Error(`GitHub didn't list the app's installs: HTTP ${found.status}`);
  return list(record(found.body, "GitHub's installs").installations, "GitHub's installs")
    .map((each) => record(each, "an install"))
    .filter((each) => each.app_slug === slug)
    .map((each) => ({
      id: Number(each.id),
      owner: text(record(each.account, "an install's account").login, "an account's login"),
      all: each.repository_selection === "all",
      page: text(each.html_url, "an install's page"),
    }));
}

// Reports whether the installation covers the repository, given as owner/name. GitHub lists an
// install's repositories a hundred at a time, so it reads page after page until it finds the
// repository or a page comes back short.
async function covers(installation: Installation, repository: string): Promise<boolean> {
  if (installation.all) return true;
  for (let page = 1; ; page++) {
    const path = `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`;
    const found = await asYou(path);
    if (found.status !== 200) return false;
    const names = list(
      record(found.body, "an install's repositories").repositories,
      "repositories",
    ).map((each) => text(record(each, "a repository").full_name, "a name").toLowerCase());
    if (names.includes(repository.toLowerCase())) return true;
    if (names.length < 100) return false;
  }
}

// Returns the page that installs the app with your account and the repository picked already.
// GitHub picks a repository only by its ID, which anyone can read for a public repository and
// no one outside can for a private one. Leaving it out would pick every repository, so for a
// private one the page is the plain install page, where you pick it.
async function installPage(install: string, owner: string, name: string): Promise<string> {
  const found = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
  if (!found.ok) return install;
  const repository = record(await found.json(), "the repository");
  if (repository.private !== false) return install;
  const ownerId = record(repository.owner, "its owner").id;
  return `${install}/permissions?suggested_target_id=${ownerId}&repository_ids[]=${repository.id}`;
}

// Has you install the app on the repository at SKELCREW_REMOTE, or, outside a checkout on GitHub,
// on any repository, unless it is there already. Then waits until your sign-in sees the install,
// so there is nothing to press once you click Install. Where the app is on the account already,
// GitHub's new-install page isn't documented to add a repository, so the link is that install's
// own page, where you add it.
async function installApp(install: string): Promise<void> {
  const slug = install.match(/\/apps\/([^/]+)\//)?.[1] ?? "";
  const remote = githubRemote(process.env.SKELCREW_REMOTE ?? "");
  const repository = remote ? `${remote.owner}/${remote.name}` : null;
  // Whether the app covers the repository, and its install on the repository's account, if
  // any. An account has at most one install of an app.
  const look = async (): Promise<{ covered: boolean; account?: Installation | undefined }> => {
    const all = await installations(slug);
    if (!repository) return { covered: all.length > 0 };
    const account = all.find((each) => each.owner.toLowerCase() === remote?.owner.toLowerCase());
    return { covered: account !== undefined && (await covers(account, repository)), account };
  };
  const first = await look();
  if (first.covered) return;
  const page =
    first.account?.page ??
    (remote ? await installPage(install, remote.owner, remote.name) : install);
  const where = repository ?? "your repositories";
  sendTo(
    page,
    `Skelcrew's GitHub App needs to be installed on ${where}. Press Enter to open your browser.`,
    (url) => `Skelcrew's GitHub App needs to be installed on ${where}. Open this link:\n${url}`,
  );
  // As long as GitHub gives a device code, so a forgotten page doesn't hold setup forever.
  const deadline = Date.now() + 15 * 60_000;
  while (!(await look()).covered) {
    if (Date.now() > deadline)
      throw new Error("the app wasn't installed within 15 minutes: run the setup again");
    await Bun.sleep(3000);
  }
  console.log(
    repository
      ? `Skelcrew's GitHub App is on ${repository}.`
      : "Skelcrew's GitHub App is installed.",
  );
}

settingsDir();
try {
  const service = serviceAddress();
  const found = await fetch(`${service}/github`, { headers });
  if (!found.ok) throw new Error(`${service} isn't Skelcrew's service: HTTP ${found.status}`);
  const app = record(await found.json(), `${service}'s answer`);
  // Signing in comes first, as only your sign-in can see when the app is installed.
  if (!(await stillSignedIn(service))) {
    const signIn = await deviceFlow(text(app.client_id, "the app's client ID"));
    const access = text(record(signIn, "GitHub's sign-in").access_token, "GitHub's user token");
    const user = await fetch("https://api.github.com/user", {
      headers: { ...headers, authorization: `Bearer ${access}` },
    });
    if (!user.ok) throw new Error(`GitHub didn't say who you are: HTTP ${user.status}`);
    const login = text(record(await user.json(), "your GitHub account").login, "your login");
    writeJson("settings.json", signInFrom(signIn, service, login));
    console.log(`Signed in to GitHub as ${login}.`);
  }
  await installApp(text(app.install, "the app's install page"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
