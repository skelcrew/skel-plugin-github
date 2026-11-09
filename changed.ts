// What changed in a repository's issues and PRs, as items in skel's words, read with one
// GraphQL query, however many PRs skel watches.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  graphql,
  list,
  number,
  record,
  rest,
  settings,
  settingsDir,
  text,
  writeJson,
} from "./github.ts";

// Who wrote something, in skel's words. `you` is whether it is the person signed in to the
// plugin. `push` is whether they can push to the repository, or null where the plugin didn't
// ask, as asking costs a request for each person.
type Author = { login: string; bot: boolean; you: boolean; push: boolean | null };
type Comment = { id: string; text: string; author: Author | null };
type Common = {
  id: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  author: Author | null;
  labels: string[];
  link: string;
  created: string;
  updated: string;
};
type CheckState = "running" | "passed" | "failed" | "cancelled";
type Verdict = "approved" | "changes requested" | "commented" | "dismissed";
export type Item =
  | ({ kind: "task"; closes: string } & Common)
  | ({
      kind: "pr";
      branch: string;
      base: string;
      conflicts: boolean;
      checks: { name: string; id: string | null; state: CheckState }[];
      reviews: (Comment & {
        verdict: Verdict;
        lines: { path: string; line: number | null; text: string }[];
      })[];
      comments: Comment[];
    } & Common);

// What a poll reads of a PR. A PR skel watches gets its last 50 reviews, and any other its last
// 10, since GitHub charges a query for every review it may send, times the PRs asked for.
const pullFields = (reviews: number) => `state mergeable baseRefName headRefName
  reviews(last: ${reviews}) { nodes { databaseId state body author { __typename login }
    comments(first: 50) { nodes { path line body } } } }
  comments(last: 50) { nodes { databaseId body author { __typename login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { databaseId name status conclusion }
    ... on StatusContext { context state } } } } } } }`;

// What an issue and a PR both have as items.
const itemFields = `number title body url createdAt updatedAt author { __typename login }
  labels(first: 20) { nodes { name } }`;

// Returns the nodes of a GraphQL list.
const nodes = (value: unknown, what: string) => list(record(value, what).nodes, what);

// Returns who wrote something, or null for a deleted account, which GitHub shows as ghost.
function authorOf(value: unknown, you: string): Author | null {
  if (value === null) return null;
  const author = record(value, "an author");
  const login = text(author.login, "an author's login");
  return { login, bot: author.__typename === "Bot", you: login === you, push: null };
}

// Returns what an issue and a PR share as items.
function commonOf(node: Record<string, unknown>, you: string) {
  return {
    id: String(number(node.number, "a number")),
    title: text(node.title, "a title"),
    body: text(node.body, "a body"),
    author: authorOf(node.author ?? null, you),
    labels: nodes(node.labels, "labels").map((label) =>
      text(record(label, "a label").name, "a label"),
    ),
    link: text(node.url, "a link"),
    created: text(node.createdAt, "when it was created"),
    updated: text(node.updatedAt, "when it was updated"),
  };
}

// Returns how a check stands in skel's words. A check run cancelled, left stale by a newer
// commit, or waiting on someone's action is no failure for the builder to fix.
function checkState(node: Record<string, unknown>): CheckState {
  if (node.__typename === "StatusContext") {
    const state = text(node.state, "a status");
    if (state === "PENDING" || state === "EXPECTED") return "running";
    return state === "SUCCESS" ? "passed" : "failed";
  }
  if (node.status !== "COMPLETED") return "running";
  const conclusion = node.conclusion;
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED")
    return "passed";
  if (conclusion === "CANCELLED" || conclusion === "STALE" || conclusion === "ACTION_REQUIRED")
    return "cancelled";
  return "failed";
}

// A review still being written isn't one yet, so it has no verdict and is left out.
const verdicts: Record<string, Verdict> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

// Returns an issue as a task, with the line that closes it from a PR's body.
function taskOf(node: Record<string, unknown>, you: string): Item {
  const common = commonOf(node, you);
  const state = node.state === "OPEN" ? "open" : "closed";
  return { kind: "task", ...common, state, closes: `Closes #${common.id}` };
}

// Returns a PR as an item, with only its head commit's checks, as only those count.
function pullOf(node: Record<string, unknown>, you: string): Item {
  const [head] = nodes(node.commits, "commits");
  const rollup = head === undefined ? null : record(record(head, "a commit").commit, "a commit");
  const contexts =
    rollup?.statusCheckRollup == null
      ? []
      : nodes(record(rollup.statusCheckRollup, "checks").contexts, "checks");
  return {
    kind: "pr",
    ...commonOf(node, you),
    state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
    branch: text(node.headRefName, "a branch"),
    base: text(node.baseRefName, "a base"),
    conflicts: node.mergeable === "CONFLICTING",
    checks: contexts.map((value) => {
      const check = record(value, "a check");
      const run = check.__typename === "CheckRun";
      return {
        name: text(run ? check.name : check.context, "a check's name"),
        id: run ? String(number(check.databaseId, "a check's ID")) : null,
        state: checkState(check),
      };
    }),
    reviews: nodes(node.reviews, "reviews").flatMap((value) => {
      const review = record(value, "a review");
      const verdict = verdicts[text(review.state, "a review's state")];
      if (verdict === undefined) return [];
      const lines = nodes(review.comments, "a review's comments").map((line) => {
        const said = record(line, "a review comment");
        const at = said.line === null ? null : number(said.line, "a line");
        return { path: text(said.path, "a path"), line: at, text: text(said.body, "a comment") };
      });
      const id = String(number(review.databaseId, "a review's ID"));
      const author = authorOf(review.author ?? null, you);
      return [{ id, text: text(review.body, "a review"), author, verdict, lines }];
    }),
    comments: nodes(node.comments, "comments").map((value) => {
      const comment = record(value, "a comment");
      return {
        id: String(number(comment.databaseId, "a comment's ID")),
        text: text(comment.body, "a comment"),
        author: authorOf(comment.author ?? null, you),
      };
    }),
  };
}

// How long whether someone can push is trusted before the plugin asks GitHub again.
const pushKept = 10 * 60_000;

// Sets `push` on the authors of the reviews and comments of the PRs skel watches, as those
// are what skel may type into a builder, and only someone who can push may steer it. Asked of
// GitHub once per person, and kept for a few minutes, so a poll seldom asks at all. A bot
// can't push, and is never asked about.
async function addPush(repository: string, pulls: Item[]): Promise<void> {
  let kept: Record<string, unknown> = {};
  try {
    kept = record(JSON.parse(readFileSync(join(settingsDir(), "push.json"), "utf8")), "push.json");
  } catch {}
  const known = new Map<string, boolean>();
  for (const [key, value] of Object.entries(kept)) {
    const { push, at } = record(value, "push.json");
    if (typeof push === "boolean" && typeof at === "number" && Date.now() - at < pushKept)
      known.set(key, push);
  }
  const authors = pulls.flatMap((pr) =>
    pr.kind === "pr"
      ? [...pr.reviews, ...pr.comments].flatMap((c) => (c.author ? [c.author] : []))
      : [],
  );
  const fresh: Record<string, { push: boolean; at: number }> = {};
  for (const author of authors) {
    if (author.bot) {
      author.push = false;
      continue;
    }
    const key = `${repository} ${author.login}`;
    let push = known.get(key);
    if (push === undefined) {
      const asked = await rest(
        repository,
        `check whether ${author.login} can push to ${repository}`,
        "GET",
        `/collaborators/${encodeURIComponent(author.login)}/permission`,
        undefined,
        [404],
      );
      // GitHub answers 404 for someone who is no user any more, such as a deleted account.
      const permission =
        asked.status === 404 ? "none" : record(asked.body, "a permission").permission;
      push = permission === "admin" || permission === "write";
      known.set(key, push);
      fresh[key] = { push, at: Date.now() };
    }
    author.push = push;
  }
  if (Object.keys(fresh).length > 0) writeJson("push.json", { ...kept, ...fresh });
}

// Creates the skel label in a repository whose tracker the plugin is, so you can add it to an
// issue to start a thread. GitHub answers 422 when the label is there already.
async function createLabel(repository: string): Promise<void> {
  await rest(
    repository,
    `create the skel label in ${repository}`,
    "POST",
    "/labels",
    { name: "skel", color: "5319e7", description: "skel starts a thread on this issue" },
    [422],
  );
}

// Returns one page of the repository's issues or PRs, newest updated first: with `since`,
// those updated since then, closed ones too; without, every open one. Values go in the query
// itself, quoted as JSON, as GitHub refuses a query declaring a variable it doesn't use.
function listQuery(kind: "issues" | "pullRequests", since: string | null, after: string | null) {
  const from = after ? `, after: ${JSON.stringify(after)}` : "";
  const states = since ? "" : ", states: [OPEN]";
  const order = "orderBy: { field: UPDATED_AT, direction: DESC }";
  if (kind === "issues") {
    const filter = since ? `, filterBy: { since: ${JSON.stringify(since)} }` : "";
    return `issues(first: 100${from}${states}${filter}, ${order}) {
      pageInfo { hasNextPage endCursor } nodes { ${itemFields} state } }`;
  }
  // Each PR costs more than an issue, and few change between two polls.
  return `pullRequests(first: ${since ? 10 : 50}${from}${states}, ${order}) {
    pageInfo { hasNextPage endCursor } nodes { ${itemFields} ${pullFields(10)} } }`;
}

// Answers `changed`: what changed in the repository since `next`, or everything open without
// it, as items, and the `next` to ask from at the next poll. Issues come only as its tracker,
// PRs only as its forge. As the forge, the PRs skel watches come too, whatever changed, since
// GitHub doesn't count a finished check as a change to its PR. They all come in one GraphQL
// query, so the number of requests doesn't grow with the PRs watched. Only a list longer than
// a page asks again, for the rest of that list. A watched PR GitHub doesn't find is left out.
export async function changed(
  repository: string,
  jobs: string[],
  next: string | null,
  watched: number[],
): Promise<{ items: Item[]; next: string | null }> {
  const tracker = jobs.includes("tracker");
  const forge = jobs.includes("forge");
  const you = settings().login;
  // Once per daemon start, which is when skel asks with no `next`.
  if (tracker && next === null) await createLabel(repository);
  const [owner = "", name = ""] = repository.split("/");
  const items: Item[] = [];
  const pulls: Item[] = [];
  // Where each list goes on, null to start it, and false once it is done.
  const cursor: Record<"issues" | "pullRequests", string | null | false> = {
    issues: tracker ? null : false,
    pullRequests: forge ? null : false,
  };
  for (
    let first = true;
    first || cursor.issues !== false || cursor.pullRequests !== false;
    first = false
  ) {
    const lists = (["issues", "pullRequests"] as const).flatMap((kind) => {
      const after = cursor[kind];
      return after === false ? [] : [`${kind}: ${listQuery(kind, next, after)}`];
    });
    const watching =
      first && forge
        ? watched.map(
            (n) => `pr${n}: pullRequest(number: ${n}) { ${itemFields} ${pullFields(50)} }`,
          )
        : [];
    if (lists.length === 0 && watching.length === 0) break;
    const data = record(
      await graphql(
        repository,
        `read what changed in ${repository}`,
        `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          ${[...lists, ...watching].join("\n")} } }`,
      ),
      "GitHub's answer",
    );
    const repo = record(data.repository, `${repository} on GitHub`);
    for (const kind of ["issues", "pullRequests"] as const) {
      if (cursor[kind] === false) continue;
      const page = record(repo[kind], `the ${kind}`);
      const found = list(page.nodes, `the ${kind}`).map((node) => record(node, `the ${kind}`));
      for (const node of found)
        items.push(kind === "issues" ? taskOf(node, you) : pullOf(node, you));
      const info = record(page.pageInfo, "a page");
      // With `next`, a full page whose oldest change is still new may have more beyond it.
      const oldest = found.at(-1)?.updatedAt;
      const more =
        info.hasNextPage === true &&
        (next === null || (typeof oldest === "string" && oldest >= next));
      cursor[kind] = more ? text(info.endCursor, "a page's end") : false;
    }
    for (const n of first && forge ? watched : []) {
      const node = repo[`pr${n}`];
      if (node === null || node === undefined) continue;
      const pr = pullOf(record(node, `PR #${n}`), you);
      pulls.push(pr);
    }
  }
  await addPush(repository, pulls);
  // A watched PR that also changed comes once, with its fuller reviews.
  const watchedIds = new Set(pulls.map((pr) => pr.id));
  const all = [...items.filter((item) => item.kind !== "pr" || !watchedIds.has(item.id)), ...pulls];
  // GitHub's times sort as text.
  const newest = [next ?? "", ...all.map((item) => item.updated)].sort().at(-1);
  return { items: all, next: newest || null };
}
