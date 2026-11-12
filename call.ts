// The plugin's call command: skel asks one question as JSON on stdin, and the plugin answers it
// as JSON on stdout, acting on GitHub as skel's GitHub App. A failure exits non-zero with its
// reason as the last line of stderr, which skel shows: code 2 when only the setup fixes it, by
// signing in again or installing the app on the repository, and 1 for anything else.
import { changed, type Item } from "./changed.ts";
import {
  askService,
  asYou,
  githubRemote,
  list,
  number,
  record,
  repositoryToken,
  rest,
  SetupNeeded,
  settings,
  text,
} from "./github.ts";

// Returns a repository skel names as owner/name, so nothing else reaches a GitHub path.
function repositoryOf(value: unknown): string {
  const name = text(value, "the repository");
  if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.includes(".."))
    throw new Error(`${name} isn't a GitHub repository's owner/name`);
  return name;
}

// Returns an issue's, PR's or check's number as skel gives it, so nothing else reaches a path.
function numberOf(value: unknown, what: string): number {
  const given = typeof value === "number" ? String(value) : text(value, what);
  if (!/^\d+$/.test(given)) throw new Error(`${given} isn't ${what}`);
  return Number(given);
}

// Returns who commits as the app, as GitHub names its bot: the app's name from its install
// page, which the service names, and the bot's ID, which links a commit to it.
async function appBot(): Promise<{ name: string; email: string }> {
  const { service } = settings();
  const found = await fetch(`${service}/github`, {
    headers: { "user-agent": "skelcrew-github", accept: "application/json" },
  });
  if (!found.ok) throw new Error(`${service} didn't name its app: HTTP ${found.status}`);
  const install = text(record(await found.json(), "the service's answer").install, "the app");
  const slug = install.match(/\/apps\/([\w-]+)\//)?.[1];
  if (!slug) throw new Error(`${install} isn't a GitHub App's install page`);
  const name = `${slug}[bot]`;
  const bot = await asYou(`/users/${encodeURIComponent(name)}`);
  if (bot.status !== 200) throw new Error(`GitHub doesn't know ${name}`);
  const id = number(record(bot.body, name).id, `${name}'s ID`);
  return { name, email: `${id}+${name}@users.noreply.github.com` };
}

// Answers `claims`: the repository's key, short name, link and clone URL, whether you can
// push to it, whether it is a fork, and who commits as the app, or null for a remote that
// isn't on GitHub. Asking the service for a token checks that the app is installed there. Where
// it isn't, claims exits 2, so from your terminal Skelcrew runs the setup, which installs it.
async function claims(remote: string) {
  const found = githubRemote(remote);
  if (!found) return null;
  const given = `${found.owner}/${found.name}`;
  const seen = await asYou(`/repos/${given}`);
  if (seen.status !== 200) throw new Error(`${given} isn't on GitHub, or you can't reach it`);
  const repo = record(seen.body, `${given} on GitHub`);
  const key = text(repo.full_name, "the repository's name");
  await repositoryToken(key);
  const permissions = record(repo.permissions ?? {}, "your permissions");
  return {
    key,
    name: text(repo.name, "the repository's name"),
    link: text(repo.html_url, "the repository's link"),
    clone: text(repo.clone_url, "the repository's clone URL"),
    push: permissions.push === true,
    fork: repo.fork === true,
    author: await appBot(),
  };
}

// Answers `create task`: opens an issue and returns it as a task.
async function createTask(repository: string, title: string, body: string): Promise<Item> {
  const made = await rest(repository, `create an issue in ${repository}`, "POST", "/issues", {
    title,
    body,
  });
  const issue = record(made.body, "the new issue");
  const user = issue.user == null ? null : record(issue.user, "the issue's author");
  const login = user === null ? null : text(user.login, "the issue's author");
  const id = String(number(issue.number, "the issue's number"));
  return {
    kind: "task",
    id,
    title: text(issue.title, "the issue's title"),
    body: typeof issue.body === "string" ? issue.body : "",
    state: "open",
    author:
      login === null
        ? null
        : { login, bot: user?.type === "Bot", you: login === settings().login, push: null },
    labels: list(issue.labels ?? [], "labels").map((l) =>
      text(record(l, "a label").name, "a label"),
    ),
    link: text(issue.html_url, "the issue's link"),
    created: text(issue.created_at, "when the issue was created"),
    updated: text(issue.updated_at, "when the issue was updated"),
    closes: `Closes #${id}`,
  };
}

// Answers `open pr`: the number of the PR open from the branch, opening one when there is
// none. GitHub matches a branch only when it is named with its owner, as owner:branch.
async function openPr(
  repository: string,
  pr: { branch: string; base: string; title: string; body: string },
): Promise<{ number: number }> {
  const owner = repository.split("/")[0];
  const head = encodeURIComponent(`${owner}:${pr.branch}`);
  const found = await rest(
    repository,
    `look for a PR from ${pr.branch}`,
    "GET",
    `/pulls?state=open&head=${head}`,
  );
  const [open] = list(found.body, "the open PRs");
  if (open !== undefined) return { number: number(record(open, "a PR").number, "a PR's number") };
  const made = await rest(repository, `open a PR from ${pr.branch}`, "POST", "/pulls", {
    head: pr.branch,
    base: pr.base,
    title: pr.title,
    body: pr.body,
  });
  return { number: number(record(made.body, "the new PR").number, "the new PR's number") };
}

// Answers `review`: posts the reviewer's verdict on the PR as a review that only comments,
// for the commit it covers. GitHub doesn't let a PR's author approve it, and skel's app opened
// the PR, so the verdict is in its first words, and the skelcrew/check check carries it.
async function review(
  repository: string,
  pr: number,
  commit: string,
  verdict: string,
  body: string,
): Promise<{ id: string }> {
  const said = verdict === "approve" ? "**Approved.**" : "**Changes requested.**";
  const posted = await rest(repository, `post a review on #${pr}`, "POST", `/pulls/${pr}/reviews`, {
    event: "COMMENT",
    commit_id: commit,
    body: `${said}\n\n${body}`,
  });
  return { id: String(number(record(posted.body, "the review").id, "the review's ID")) };
}

// Answers `log`: the end of a failed check's log, kept short, as skel types it into the
// builder, which can run the tests itself for more. A check from GitHub Actions has a job's
// log, with a time in front of each line, which goes. Any other check has only its summary.
async function log(repository: string, check: string): Promise<{ log: string }> {
  const token = await repositoryToken(repository);
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/jobs/${check}/logs`,
    { headers: { authorization: `Bearer ${token}`, "user-agent": "skelcrew-github" } },
  );
  let lines: string[];
  if (response.ok)
    lines = (await response.text())
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
  else {
    const run = await rest(repository, `read check ${check}`, "GET", `/check-runs/${check}`);
    const output = record(record(run.body, "the check").output ?? {}, "the check's output");
    lines = [output.title, output.summary, output.text]
      .filter((part) => typeof part === "string" && part !== "")
      .join("\n\n")
      .split("\n");
  }
  return { log: lines.slice(-30).join("\n").slice(-3000) };
}

// Returns the answer to one question from skel.
async function answer(question: Record<string, unknown>): Promise<unknown> {
  const ask = text(question.ask, "the question");
  if (ask === "claims") return claims(text(question.remote, "the remote"));
  const repository = repositoryOf(question.repository);
  if (ask === "changed")
    return changed(
      repository,
      list(question.jobs, "the jobs").map((job) => text(job, "a job")),
      question.next == null ? null : text(question.next, "next"),
      list(question.prs ?? [], "the PRs").map((pr) => number(pr, "a PR")),
    );
  if (ask === "create task")
    return createTask(
      repository,
      text(question.title, "the title"),
      text(question.body, "the body"),
    );
  if (ask === "took") {
    const task = numberOf(question.task, "an issue's number");
    await rest(repository, `react to #${task}`, "POST", `/issues/${task}/reactions`, {
      content: "eyes",
    });
    return null;
  }
  if (ask === "open pr")
    return openPr(repository, {
      branch: text(question.branch, "the branch"),
      base: text(question.base, "the base"),
      title: text(question.title, "the title"),
      body: text(question.body, "the body"),
    });
  if (ask === "review")
    return review(
      repository,
      numberOf(question.pr, "a PR's number"),
      text(question.commit, "the commit"),
      text(question.verdict, "the verdict"),
      text(question.body, "the body"),
    );
  if (ask === "status") {
    const commit = text(question.commit, "the commit");
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${commit} isn't a commit`);
    // GitHub refuses a description longer than 140 characters.
    await rest(
      repository,
      `set the skelcrew/check check on ${commit}`,
      "POST",
      `/statuses/${commit}`,
      {
        state: text(question.state, "the state"),
        context: "skelcrew/check",
        description: text(question.description, "the description").slice(0, 140),
      },
    );
    return null;
  }
  if (ask === "log") return log(repository, String(numberOf(question.check, "a check's ID")));
  if (ask === "wake" || ask === "unwake") {
    await askService(`/github/${ask}`, { repository, url: text(question.url, "the address") });
    return null;
  }
  throw new Error(`the GitHub plugin doesn't answer ${ask}`);
}

try {
  const question = record(JSON.parse(await Bun.stdin.text()), "Skelcrew's question");
  console.log(JSON.stringify(await answer(question)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof SetupNeeded ? 2 : 1);
}
