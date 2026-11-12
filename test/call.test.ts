// Tests of the plugin's call command, asked as skel asks it, against a fake GitHub and a fake
// skel's service.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Asked, json, removeSettings, run, signedIn, startFake } from "./fake.ts";

const fake = startFake();
afterAll(() => fake.stop());
let dir = "";

beforeEach(() => {
  dir = signedIn();
  fake.asked = [];
  fake.route = world;
});
afterEach(() => removeSettings(dir));

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

// A GitHub where simon can push to simon/app, which has skel's app installed, and simon/other
// has it not installed.
function world(asked: Asked): Response | undefined {
  const { method, path, auth } = asked;
  if (method === "POST" && path === "/service/github/token") {
    if (auth !== "Bearer user-token")
      return json({ error: "GitHub doesn't accept your sign-in" }, 401);
    const { repository } = JSON.parse(asked.body);
    if (repository === "simon/app") return json({ token: "ghs_app", expires: inAnHour() });
    return json(
      {
        error: `skel's GitHub App isn't installed on ${repository}: install it at https://github.com/apps/skelcrew/installations/new`,
      },
      404,
    );
  }
  if (path === "/api/repos/simon/app" && auth === "Bearer user-token")
    return json({
      full_name: "simon/app",
      name: "app",
      html_url: "https://github.com/simon/app",
      clone_url: "https://github.com/simon/app.git",
      fork: false,
      permissions: { push: true },
    });
  if (method === "GET" && path === "/service/github")
    return json({
      install: "https://github.com/apps/skelcrew/installations/new",
      client_id: "Iv1.app",
    });
  if (path === "/api/users/skelcrew%5Bbot%5D") return json({ login: "skelcrew[bot]", id: 41 });
  if (path === "/api/repos/simon/other" && auth === "Bearer user-token")
    return json({ full_name: "simon/other", name: "other", permissions: { push: true } });
  return undefined;
}

// Asks the plugin one question, as skel does, and returns its answer, or throws its error.
async function ask(question: object): Promise<unknown> {
  const { code, out, err } = await run(fake.url, dir, ["call.ts"], JSON.stringify(question));
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1));
  return JSON.parse(out);
}

const sent = (path: string) =>
  fake.asked.filter((a) => a.path === path).map((a) => JSON.parse(a.body || "null"));

// Commits are authored by the app's bot, as GitHub names it, so they show as the app's.
test("claims answers for a remote on GitHub, in any form git writes one, or its full name", async () => {
  const claimed = {
    key: "simon/app",
    name: "app",
    link: "https://github.com/simon/app",
    clone: "https://github.com/simon/app.git",
    push: true,
    fork: false,
    author: { name: "skelcrew[bot]", email: "41+skelcrew[bot]@users.noreply.github.com" },
  };
  for (const remote of [
    "git@github.com:simon/app.git",
    "https://github.com/simon/app",
    "ssh://git@github.com/simon/app.git",
    "simon/app",
  ])
    expect(await ask({ ask: "claims", remote })).toEqual(claimed);
});

test("claims answers null for a remote somewhere else, without asking anyone", async () => {
  expect(await ask({ ask: "claims", remote: "git@gitlab.com:simon/app.git" })).toBeNull();
  expect(fake.asked).toEqual([]);
});

// Exit code 2 has Skelcrew run the setup, which installs the app, from your terminal.
test("claims exits 2 where the app isn't installed, saying so", async () => {
  const question = JSON.stringify({ ask: "claims", remote: "git@github.com:simon/other.git" });
  const { code, out, err } = await run(fake.url, dir, ["call.ts"], question);
  expect(code).toBe(2);
  expect(out).toBe("");
  expect(err).toBe("Skelcrew's GitHub App isn't installed on simon/other\n");
});

test("a repository's token is asked for once and used until it nearly runs out", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/issues/12/reactions" ? json({}, 201) : world(asked);
  await ask({ ask: "took", repository: "simon/app", task: "12" });
  await ask({ ask: "took", repository: "simon/app", task: "12" });
  expect(sent("/service/github/token")).toEqual([{ repository: "simon/app" }]);
  const reactions = fake.asked.filter((a) => a.path.endsWith("/reactions"));
  expect(reactions.map((a) => a.auth)).toEqual(["Bearer ghs_app", "Bearer ghs_app"]);
  expect(JSON.parse(reactions[0]?.body ?? "")).toEqual({ content: "eyes" });
});

test("a sign-in about to run out is renewed through the service once, by calls at once", async () => {
  removeSettings(dir);
  dir = signedIn({ access: "old-token", accessExpires: Date.now() + 60_000 });
  let renewals = 0;
  fake.route = (asked) => {
    if (asked.path === "/service/github/renew") {
      renewals++;
      // A refresh token works once.
      if (JSON.parse(asked.body).refresh_token !== "refresh-1")
        return json({ error: "GitHub refused the sign-in" }, 401);
      return json({
        access_token: "user-token",
        expires_in: 28800,
        refresh_token: "refresh-2",
        refresh_token_expires_in: 15724800,
      });
    }
    if (asked.path.endsWith("/reactions")) return json({}, 201);
    return world(asked);
  };
  await Promise.all(
    [1, 2, 3].map((n) => ask({ ask: "took", repository: "simon/app", task: String(n) })),
  );
  expect(renewals).toBe(1);
  const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(saved.access).toBe("user-token");
  expect(saved.refresh).toBe("refresh-2");
});

// A GraphQL answer for simon/app: issue 12 labeled skelcrew, PR 26 from a thread, with checks,
// a review from skel's app and a comment from someone else, and PR 30 nobody watches.
const issue12 = {
  number: 12,
  title: "Fix the login",
  body: "It redirects wrong.",
  url: "https://github.com/simon/app/issues/12",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-09T10:00:00Z",
  author: { __typename: "User", login: "simon" },
  labels: { nodes: [{ name: "skelcrew" }] },
  state: "OPEN",
};
const pull = (n: number, updatedAt: string) => ({
  number: n,
  title: `PR ${n}`,
  body: "Closes #12",
  url: `https://github.com/simon/app/pull/${n}`,
  createdAt: "2026-11-02T10:00:00Z",
  updatedAt,
  author: { __typename: "Bot", login: "skelcrew" },
  labels: { nodes: [] },
  state: "OPEN",
  mergeable: "CONFLICTING",
  baseRefName: "main",
  headRefName: `skel/12-fix-login`,
  reviews: {
    nodes: [
      {
        databaseId: 501,
        state: "COMMENTED",
        body: "**Approved.**",
        author: { __typename: "Bot", login: "skelcrew" },
        comments: { nodes: [] },
      },
      {
        databaseId: 502,
        state: "CHANGES_REQUESTED",
        body: "Rename it",
        author: { __typename: "User", login: "ana" },
        comments: { nodes: [{ path: "src/a.ts", line: 3, body: "here" }] },
      },
      {
        databaseId: 503,
        state: "PENDING",
        body: "",
        author: { __typename: "User", login: "ana" },
        comments: { nodes: [] },
      },
    ],
  },
  comments: {
    nodes: [{ databaseId: 601, body: "lgtm", author: { __typename: "User", login: "bob" } }],
  },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  databaseId: 9,
                  name: "test",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                },
                {
                  __typename: "CheckRun",
                  databaseId: 10,
                  name: "lint",
                  status: "IN_PROGRESS",
                  conclusion: null,
                },
                {
                  __typename: "CheckRun",
                  databaseId: 11,
                  name: "old",
                  status: "COMPLETED",
                  conclusion: "CANCELLED",
                },
                { __typename: "StatusContext", context: "skelcrew/check", state: "SUCCESS" },
              ],
            },
          },
        },
      },
    ],
  },
});
const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

// A GitHub that answers GraphQL with simon/app's issues and PRs, as asked, and says ana can
// push and bob can't.
function withRepository(asked: Asked): Response | undefined {
  if (asked.path === "/api/graphql") {
    const { query } = JSON.parse(asked.body);
    const repository: Record<string, unknown> = {};
    if (query.includes("issues(")) repository.issues = page([issue12]);
    if (query.includes("pullRequests("))
      repository.pullRequests = page([
        pull(30, "2026-11-09T11:00:00Z"),
        pull(26, "2026-11-08T10:00:00Z"),
      ]);
    if (query.includes("pr26:")) repository.pr26 = pull(26, "2026-11-08T10:00:00Z");
    if (query.includes("pr99:")) repository.pr99 = null;
    return json({ data: { repository } });
  }
  if (asked.path === "/api/repos/simon/app/labels") return json({ message: "exists" }, 422);
  if (asked.path === "/api/repos/simon/app/collaborators/ana/permission")
    return json({ permission: "write" });
  if (asked.path === "/api/repos/simon/app/collaborators/bob/permission")
    return json({ permission: "read" });
  return world(asked);
}

test("changed with no next brings everything open, and the PRs skel watches, in one query", async () => {
  fake.route = withRepository;
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker", "forge"],
    next: null,
    prs: [26, 99],
  });
  const graphql = fake.asked.filter((a) => a.path === "/api/graphql");
  expect(graphql.length).toBe(1);
  const { query } = JSON.parse(graphql[0]?.body ?? "");
  expect(query).toContain("states: [OPEN]");
  // The label is made when the plugin is first asked, as the tracker.
  expect(sent("/api/repos/simon/app/labels")).toEqual([
    { name: "skelcrew", color: "5319e7", description: "Skelcrew starts a thread on this issue" },
  ]);
  expect(answer).toMatchObject({ next: "2026-11-09T11:00:00Z" });
  const { items } = answer as { items: ({ kind: string; id: string } & Record<string, unknown>)[] };
  expect(items.map((item) => `${item.kind} ${item.id}`)).toEqual(["task 12", "pr 30", "pr 26"]);
  expect(items[0]).toEqual({
    kind: "task",
    id: "12",
    title: "Fix the login",
    body: "It redirects wrong.",
    state: "open",
    author: { login: "simon", bot: false, you: true, push: null },
    labels: ["skelcrew"],
    link: "https://github.com/simon/app/issues/12",
    created: "2026-11-01T10:00:00Z",
    updated: "2026-11-09T10:00:00Z",
    closes: "Closes #12",
  });
  expect(items[2]).toEqual({
    kind: "pr",
    id: "26",
    title: "PR 26",
    body: "Closes #12",
    state: "open",
    author: { login: "skelcrew", bot: true, you: false, push: null },
    labels: [],
    link: "https://github.com/simon/app/pull/26",
    created: "2026-11-02T10:00:00Z",
    updated: "2026-11-08T10:00:00Z",
    branch: "skel/12-fix-login",
    base: "main",
    conflicts: true,
    checks: [
      { name: "test", id: "9", state: "failed" },
      { name: "lint", id: "10", state: "running" },
      { name: "old", id: "11", state: "cancelled" },
      { name: "skelcrew/check", id: null, state: "passed" },
    ],
    reviews: [
      {
        id: "501",
        text: "**Approved.**",
        author: { login: "skelcrew", bot: true, you: false, push: false },
        verdict: "commented",
        lines: [],
      },
      {
        id: "502",
        text: "Rename it",
        author: { login: "ana", bot: false, you: false, push: true },
        verdict: "changes requested",
        lines: [{ path: "src/a.ts", line: 3, text: "here" }],
      },
    ],
    comments: [
      { id: "601", text: "lgtm", author: { login: "bob", bot: false, you: false, push: false } },
    ],
  });
});

test("whether someone can push is asked once, and kept for the next poll", async () => {
  fake.route = withRepository;
  const question = {
    ask: "changed",
    repository: "simon/app",
    jobs: ["forge"],
    next: null,
    prs: [26],
  };
  await ask(question);
  await ask(question);
  expect(fake.asked.filter((a) => a.path.includes("/collaborators/")).length).toBe(2);
});

test("changed with next asks only for what changed since, closed ones too", async () => {
  fake.route = withRepository;
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker", "forge"],
    next: "2026-11-09T09:00:00Z",
    prs: [],
  });
  const { query } = JSON.parse(fake.asked.find((a) => a.path === "/api/graphql")?.body ?? "");
  expect(query).toContain('filterBy: { since: "2026-11-09T09:00:00Z" }');
  expect(query).not.toContain("states: [OPEN]");
  expect(sent("/api/repos/simon/app/labels")).toEqual([]);
  expect(answer).toMatchObject({ next: "2026-11-09T11:00:00Z" });
});

test("as the forge alone, changed leaves issues out and makes no label", async () => {
  fake.route = withRepository;
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["forge"],
    next: null,
    prs: [],
  });
  const { query } = JSON.parse(fake.asked.find((a) => a.path === "/api/graphql")?.body ?? "");
  expect(query).not.toContain("issues(");
  expect((answer as { items: { kind: string }[] }).items.map((i) => i.kind)).toEqual(["pr", "pr"]);
  expect(sent("/api/repos/simon/app/labels")).toEqual([]);
});

test("a list longer than a page is read to its end", async () => {
  let pages = 0;
  fake.route = (asked) => {
    if (asked.path !== "/api/graphql") return world(asked);
    const { query } = JSON.parse(asked.body);
    pages++;
    const first = !query.includes("after:");
    const node = { ...issue12, number: first ? 1 : 2 };
    return json({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: first, endCursor: "c1" }, nodes: [node] },
        },
      },
    });
  };
  fake.asked = [];
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker"],
    next: "2026-11-01T00:00:00Z",
    prs: [],
  });
  expect(pages).toBe(2);
  expect((answer as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(["1", "2"]);
});

test("create task opens an issue and answers it as a task", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/issues" && asked.method === "POST"
      ? json(
          {
            number: 13,
            title: "Add a logout",
            body: "Somewhere.",
            state: "open",
            user: { login: "skelcrew[bot]", type: "Bot" },
            labels: [],
            html_url: "https://github.com/simon/app/issues/13",
            created_at: "2026-11-09T12:00:00Z",
            updated_at: "2026-11-09T12:00:00Z",
          },
          201,
        )
      : world(asked);
  const task = await ask({
    ask: "create task",
    repository: "simon/app",
    title: "Add a logout",
    body: "Somewhere.",
  });
  expect(sent("/api/repos/simon/app/issues")).toEqual([
    { title: "Add a logout", body: "Somewhere." },
  ]);
  expect(task).toEqual({
    kind: "task",
    id: "13",
    title: "Add a logout",
    body: "Somewhere.",
    state: "open",
    author: { login: "skelcrew[bot]", bot: true, you: false, push: null },
    labels: [],
    link: "https://github.com/simon/app/issues/13",
    created: "2026-11-09T12:00:00Z",
    updated: "2026-11-09T12:00:00Z",
    closes: "Closes #13",
  });
});

test("open pr answers the PR already open from the branch, or opens one", async () => {
  let open: unknown[] = [];
  fake.route = (asked) => {
    if (asked.path.startsWith("/api/repos/simon/app/pulls?")) return json(open);
    if (asked.path === "/api/repos/simon/app/pulls") return json({ number: 26 }, 201);
    return world(asked);
  };
  const question = {
    ask: "open pr",
    repository: "simon/app",
    branch: "skel/12-fix-login",
    base: "main",
    title: "Fix the login",
    body: "Closes #12",
  };
  expect(await ask(question)).toEqual({ number: 26 });
  expect(
    fake.asked.some(
      (a) => a.path === "/api/repos/simon/app/pulls?state=open&head=simon%3Askel%2F12-fix-login",
    ),
  ).toBe(true);
  expect(sent("/api/repos/simon/app/pulls")).toEqual([
    { head: "skel/12-fix-login", base: "main", title: "Fix the login", body: "Closes #12" },
  ]);
  open = [{ number: 25 }];
  fake.asked = [];
  expect(await ask(question)).toEqual({ number: 25 });
  expect(sent("/api/repos/simon/app/pulls")).toEqual([]);
});

test("review posts a review that only comments, with the verdict first", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/pulls/26/reviews" ? json({ id: 777 }) : world(asked);
  const posted = await ask({
    ask: "review",
    repository: "simon/app",
    pr: 26,
    commit: "abc123",
    verdict: "changes",
    body: "Rename it.",
  });
  expect(posted).toEqual({ id: "777" });
  expect(sent("/api/repos/simon/app/pulls/26/reviews")).toEqual([
    { event: "COMMENT", commit_id: "abc123", body: "**Changes requested.**\n\nRename it." },
  ]);
});

test("status sets the skelcrew/check status check, cut to what GitHub takes", async () => {
  const commit = "a".repeat(40);
  fake.route = (asked) =>
    asked.path === `/api/repos/simon/app/statuses/${commit}`
      ? json({ state: "pending" }, 201)
      : world(asked);
  expect(
    await ask({
      ask: "status",
      repository: "simon/app",
      commit,
      state: "pending",
      description: "x".repeat(200),
    }),
  ).toBeNull();
  expect(sent(`/api/repos/simon/app/statuses/${commit}`)).toEqual([
    { state: "pending", context: "skelcrew/check", description: "x".repeat(140) },
  ]);
});

test("log answers the end of a failed job's log, without GitHub's times", async () => {
  const lines = Array.from({ length: 40 }, (_, n) => `2026-11-09T10:00:00.1234567Z line ${n}`);
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/actions/jobs/9/logs"
      ? new Response(lines.join("\n"))
      : world(asked);
  const { log } = (await ask({ ask: "log", repository: "simon/app", check: "9" })) as {
    log: string;
  };
  expect(log.split("\n")).toEqual(Array.from({ length: 30 }, (_, n) => `line ${n + 10}`));
});

test("log of a check that isn't from GitHub Actions answers its summary", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/check-runs/9"
      ? json({ output: { title: "Lint failed", summary: "3 problems", text: null } })
      : world(asked);
  expect(await ask({ ask: "log", repository: "simon/app", check: "9" })).toEqual({
    log: "Lint failed\n\n3 problems",
  });
});

test("wake and unwake ask skel's service to pass on, or stop, the repository's wake-ups", async () => {
  fake.route = (asked) =>
    asked.path === "/service/github/wake" || asked.path === "/service/github/unwake"
      ? new Response(null, { status: 204 })
      : world(asked);
  const url = "https://demo.sprites.app/github";
  expect(await ask({ ask: "wake", repository: "simon/app", url })).toBeNull();
  expect(await ask({ ask: "unwake", repository: "simon/app", url })).toBeNull();
  expect(sent("/service/github/wake")).toEqual([{ repository: "simon/app", url }]);
  expect(sent("/service/github/unwake")).toEqual([{ repository: "simon/app", url }]);
  expect(fake.asked.find((a) => a.path === "/service/github/wake")?.auth).toBe("Bearer user-token");
});

test("a question the plugin doesn't answer, or a repository that isn't one, fails plainly", async () => {
  await expect(ask({ ask: "dance", repository: "simon/app" })).rejects.toThrow(
    "the GitHub plugin doesn't answer dance",
  );
  await expect(ask({ ask: "took", repository: "../x", task: "1" })).rejects.toThrow(
    "isn't a GitHub repository's owner/name",
  );
});

// Exit code 2 tells Skelcrew the plugin needs its setup again, so its error names the command.
const again = "run sc plugin setup github to sign in again";
const took = JSON.stringify({ ask: "took", repository: "simon/app", task: "1" });

test("without setup, a call exits 2 and says to run it", async () => {
  removeSettings(join(dir, "settings.json"));
  const { code, err } = await run(fake.url, dir, ["call.ts"], took);
  expect(code).toBe(2);
  expect(err.trim()).toBe(`GitHub isn't set up: ${again}`);
});

test("a sign-in whose refresh token ran out exits 2, asking nothing", async () => {
  removeSettings(dir);
  dir = signedIn({ accessExpires: Date.now() - 1000, refreshExpires: Date.now() - 1000 });
  const { code, err } = await run(fake.url, dir, ["call.ts"], took);
  expect(code).toBe(2);
  expect(err.trim()).toBe(`your GitHub sign-in ran out: ${again}`);
  expect(fake.asked).toEqual([]);
});

test("a renewal the service refuses as unauthorized exits 2, and other failures exit 1", async () => {
  removeSettings(dir);
  dir = signedIn({ accessExpires: Date.now() - 1000 });
  fake.route = (asked) =>
    asked.path === "/service/github/renew" ? json({ error: "sign in again" }, 401) : world(asked);
  const refused = await run(fake.url, dir, ["call.ts"], took);
  expect(refused.code).toBe(2);
  expect(refused.err.trim()).toBe(`couldn't renew your GitHub sign-in: sign in again: ${again}`);
  fake.route = (asked) =>
    asked.path === "/service/github/renew" ? json({ error: "down" }, 503) : world(asked);
  const down = await run(fake.url, dir, ["call.ts"], took);
  expect(down.code).toBe(1);
  expect(down.err.trim()).toBe("couldn't renew your GitHub sign-in: down");
  const dance = await run(fake.url, dir, ["call.ts"], JSON.stringify({ ask: "dance" }));
  expect(dance.code).toBe(1);
});
