// The plugin's setup, run in your terminal when skel installs it: it asks for skel's service,
// has you install skel's GitHub App, and signs you in with GitHub's device flow, so nothing is
// pasted. Run again, it does the same, such as to sign in again.
import { record, settingsDir, signInFrom, text, writeJson } from "./github.ts";

const headers = { "user-agent": "skel-plugin-github", accept: "application/json" };

// Opens a page in your browser when this machine has one you sit at: a Mac, or a Linux
// desktop. Over SSH or on a Sprite the browser would be on another screen or none, and the
// link printed beside it is the way.
function openPage(url: string): void {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? "xdg-open"
        : null;
  if (command && Bun.which(command))
    Bun.spawnSync([command, url], { stdout: "ignore", stderr: "ignore" });
}

// Returns GitHub's sign-in once you have authorized skel's app with the code shown, through
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
  console.log(`\nSign in to GitHub: open ${link} and enter ${code}, then authorize skel.`);
  openPage(link);
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
    if (got.error === "access_denied") throw new Error("you didn't authorize skel on GitHub");
    if (typeof got.error === "string") throw new Error(`GitHub refused the sign-in: ${got.error}`);
    return got;
  }
}

settingsDir();
try {
  const service = (prompt("skel's service:", "https://skel.run") ?? "https://skel.run").replace(
    /\/+$/,
    "",
  );
  const found = await fetch(`${service}/`, { headers });
  if (!found.ok) throw new Error(`${service} isn't skel's service: HTTP ${found.status}`);
  const app = record(await found.json(), `${service}'s answer`);
  const install = text(app.install, "the app's install page");
  console.log(`\nInstall skel's GitHub App on the repositories skel should work on:\n  ${install}`);
  openPage(install);
  prompt("Press Enter once it is installed.");
  const signIn = await deviceFlow(text(app.client_id, "the app's client ID"));
  const access = text(record(signIn, "GitHub's sign-in").access_token, "GitHub's user token");
  const user = await fetch("https://api.github.com/user", {
    headers: { ...headers, authorization: `Bearer ${access}` },
  });
  if (!user.ok) throw new Error(`GitHub didn't say who you are: HTTP ${user.status}`);
  const login = text(record(await user.json(), "your GitHub account").login, "your login");
  writeJson("settings.json", signInFrom(signIn, service, login));
  console.log(`Signed in to GitHub as ${login}. skel acts there as skel's app, never as you.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
