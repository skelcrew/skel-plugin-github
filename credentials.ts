// The plugin's git credential helper: skel hands it to git for each clone, fetch and push,
// and it gives git the repository's token from skel's app, as the user x-access-token. skel
// asks git to send the repository's path, so each token works for that repository alone.
import { repositoryToken, SetupNeeded } from "./github.ts";

// git asks with "get", and tells helpers of a login it stored or one that failed with "store"
// and "erase". The token is the service's to renew, so those need nothing.
if (process.argv[2] === "get") {
  const given = new Map(
    (await Bun.stdin.text())
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const repository = given
    .get("path")
    ?.replace(/\.git$/, "")
    .replace(/\/$/, "");
  // Answering nothing lets git fail on its own words, for a host that isn't GitHub's or a
  // request without the repository's path.
  if (given.get("host") === "github.com" && repository && /^[\w.-]+\/[\w.-]+$/.test(repository)) {
    try {
      const token = await repositoryToken(repository);
      process.stdout.write(`username=x-access-token\npassword=${token}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(error instanceof SetupNeeded ? 2 : 1);
    }
  }
}
