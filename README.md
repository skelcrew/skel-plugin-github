# skel-plugin-github

skel's GitHub plugin: tasks from GitHub issues, and PRs on GitHub. It is a tracker and a forge
for [skel](https://github.com/skelcrew/skel). Everything it does on GitHub, it does as skel's
GitHub App, so every PR, review, comment, reaction and push shows as `skel[bot]`. skel never
acts on GitHub as you.

## Installing

```sh
skel plugin install skelcrew/skel-plugin-github
```

The first `skel` offers to run this for you. On a server or Sprite, install it there:
`skel --remote sprite:demo plugin install skelcrew/skel-plugin-github`.

It needs nothing else installed: it is written for Bun, which skel brings, and has no
dependencies. It reaches GitHub through its REST and GraphQL APIs.

Its setup takes three steps, and asks you to paste nothing:

1. It asks for skel's service, with `https://skel.run` filled in. Press Enter, or give the
   address of a service you run yourself.
2. It opens the page that installs skel's GitHub App, or prints it when there is no browser
   at hand, such as over SSH. Pick the repositories skel should work on, and click Install.
3. It signs you in with GitHub's device flow: a code and a link, then Authorize. That tells
   skel who you are, so it can say whether you can push to a repository, and whether a comment
   is yours.

Then, in a checkout, `skel init` names GitHub as the repository's tracker.

## What it needs

- **skel's service**, [skel-service](https://github.com/skelcrew/skel-service), at
  `https://skel.run` unless you run your own. The app's secrets live there. The plugin asks it
  for a token for each repository, which works only there, for an hour, and for your sign-in
  to be renewed when GitHub expires it. Code and issues never pass through the service: the
  plugin and git talk to GitHub directly.
- **skel's GitHub App** installed on each repository skel works on. For a repository it isn't
  installed on, skel says so, with the link that installs it.

Its settings and tokens are in the folder skel gives it, in `~/.config/skel/plugins/github/`,
readable only by you: `settings.json` holds the service's address and your sign-in,
`tokens.json` each repository's token, and `push.json` who can push, for a few minutes. Agents
never see them.

## Calls

skel runs `bun call.ts` with one JSON question on stdin, and reads one JSON answer from stdout.
A failure exits non-zero, with its reason as the last line of stderr. Each question names its
kind in `ask`. A repository is named `owner/name`, its key from `claims`.

| `ask` | Also given | Answer |
| --- | --- | --- |
| `claims` | `remote` | `{ key, name, link, clone, push, fork }`, or `null` for a remote not on GitHub |
| `changed` | `repository`, `jobs` (`tracker`, `forge`), `next` or null, `prs` (numbers) | `{ items, next }` |
| `create task` | `repository`, `title`, `body` | The new task, as an item |
| `took` | `repository`, `task` | `null`, after reacting with 👀 |
| `open pr` | `repository`, `branch`, `base`, `title`, `body` | `{ number }`, of the PR already open from the branch if there is one |
| `review` | `repository`, `pr`, `commit`, `verdict` (`approve` or `changes`), `body` | `{ id }` |
| `status` | `repository`, `commit`, `state` (`pending`, `success` or `failure`), `description` | `null`, after setting the `skel/review` check |
| `log` | `repository`, `check` | `{ log }`: the end of the failed check's log |
| `wake`, `unwake` | `repository`, `url` | `null`, after asking skel's service to start or stop passing wake-ups to the address |

**`changed`** reads one GraphQL query per repository, whatever the number of PRs skel watches.
Without `next`, it brings everything open. With it, everything updated since, closed and merged
ones too. Issues come only as the repository's tracker, and PRs only as its forge. As the forge,
the PRs in `prs` come too, whatever changed, since GitHub doesn't count a finished check as a
change to its PR. A list longer than one page is read to its end. As the tracker, the first ask
with no `next` creates the `skel` label in the repository. `next` is the newest change seen, or
null when there was none.

An **item** is a task or a PR:

```json
{
  "kind": "task", "id": "12", "title": "…", "body": "…", "state": "open",
  "author": { "login": "simon", "bot": false, "you": true, "push": null },
  "labels": ["skel"], "link": "https://github.com/simon/app/issues/12",
  "created": "2026-11-01T10:00:00Z", "updated": "2026-11-09T10:00:00Z",
  "closes": "Closes #12"
}
```

A PR has `kind: "pr"`, no `closes`, and adds `branch`, `base`, `conflicts`, `checks` (each with
`name`, `id` or null, and `state`: `running`, `passed`, `failed` or `cancelled`), `reviews` (each
with `id`, `text`, `author`, `verdict` and `lines`) and `comments` (each with `id`, `text` and
`author`). Its `state` can be `merged`.

An author's `you` says whether it is the person signed in to the plugin. `push` says whether
they can push to the repository. It is asked of GitHub only for the authors of reviews and
comments on the PRs in `prs`, as those are what skel may type into a builder. Everywhere else it
is `null`, as asking costs a request for each person.

`git_credentials` is `bun credentials.ts`, a git credential helper. Given the repository's path,
which skel has git send, it answers with that repository's token, as the user `x-access-token`.

## Working on it

```sh
bun install
bun run check    # format, lint, typecheck and tests
```

The tests run each command as skel does, with a fake GitHub and a fake service.

To try a change in skel: `skel plugin install ./skel-plugin-github` uses your folder where it
is, and `skel plugin update github` picks up your edits.

A release is a version tag, such as `v0.1.0`, matching `version` in `skel-plugin.yaml`.
