// Loaded before the plugin in tests: sends its requests to GitHub, github.com and skel.run to
// the test's fake instead, so no test reaches the real ones.
const fake = process.env.FAKE_GITHUB;
if (!fake) throw new Error("FAKE_GITHUB isn't set");
const real = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const moved = url
      .replace(/^https:\/\/api\.github\.com/, `${fake}/api`)
      .replace(/^https:\/\/github\.com/, `${fake}/web`)
      .replace(/^https:\/\/skel\.run/, `${fake}/service`);
    return real(input instanceof Request ? new Request(moved, input) : moved, init);
  },
  { preconnect: real.preconnect },
);
