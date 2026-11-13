# skelcrew-github

Skelcrew's GitHub plugin: work with issues, pull requests and CI on your repositories. It is a tracker and a
forge for [Skelcrew](https://github.com/skelcrew/skelcrew). Everything it does on GitHub, it does
as Skelcrew's GitHub App, so every PR, review, comment, reaction and push shows as
`skelcrew[bot]`. Skelcrew never acts on GitHub as you.

## Installing

```sh
sc plugin install skelcrew/skelcrew-github
```

`sc` in a checkout of a GitHub repository offers to install it for you. On a server or Sprite, install it there:
`sc --remote sprite:demo plugin install skelcrew/skelcrew-github`.

It needs nothing else installed: it is written for Bun, which Skelcrew brings, and has no
dependencies. It reaches GitHub through its REST and GraphQL APIs.

Its setup takes two steps, and asks you to paste nothing. Each is skipped when it is done
already, so a sign-in that still works isn't asked for again:

1. It signs you in with GitHub's device flow: it shows a code, and Enter opens GitHub's page,
   where you enter it and click Authorize. That tells Skelcrew who you are, so it can say whether
   you can push to a repository, and whether a comment is yours.
2. It makes sure Skelcrew's GitHub App is installed on the repository you ran `sc` in. If not,
   Enter opens the install page. For a public repository, your account and the repository are
   picked already. For a private one you pick it, as GitHub picks a repository only by an ID
   that can't be read before the app is there. Where the app is on your account already, the
   page is that install's own, where you add the repository. Click Install, and setup sees it
   by itself. Outside a checkout, setup waits until the app is installed anywhere.

Over SSH, where there is no browser at hand, it prints each link instead of opening it.

Then, in a checkout, `sc init` names GitHub as the repository's tracker.

## What it needs

- **Skelcrew's service**, [skelcrew-service](https://github.com/skelcrew/skelcrew-service), at
  `https://skelcrew.dev`. To use one you run yourself, write its address in a file named
  `service` in the plugin's settings folder, then run `sc plugin setup github`. The app's secrets live there. The plugin asks
  it for a token for each repository, which works only there, for an hour, and for your sign-in
  to be renewed when GitHub expires it. Code and issues never pass through the service: the
  plugin and git talk to GitHub directly.
- **Skelcrew's GitHub App** installed on each repository Skelcrew works on. Where it isn't,
  `sc` in a checkout of the repository runs the setup, which goes straight to installing it.

Its settings and tokens are in the folder Skelcrew gives it, in
`~/.config/skelcrew/plugins/github/`, readable only by you: `settings.json` holds the service's
address and your sign-in, `tokens.json` each repository's token, and `push.json` who can push,
for a few minutes. Agents never see them.

## Calls

Skelcrew runs `bun call.ts` with one JSON question on stdin, and reads one JSON answer from
stdout. A failure exits non-zero, with its reason as the last line of stderr. It exits 2
when only the setup fixes it: there is no sign-in yet, its refresh token ran out, the service
refused to renew it, or the app isn't installed on the repository. From your terminal,
Skelcrew then runs the setup, and elsewhere names `sc plugin setup github`. Every other
failure exits 1. The git credential helper exits the same way.
Each question names its kind in `ask`. A repository is named `owner/name`, its key from `claims`.

| `ask` | Also given | Answer |
| --- | --- | --- |
| `claims` | `remote`, or a repository's full name, such as `simon/app` | `{ key, name, link, clone, push, fork, author }`, or `null` for a remote not on GitHub. `author` is the app's bot, `{ name, email }`, which skel makes the author of a thread's commits, with you as co-author |
| `changed` | `repository`, `jobs` (`tracker`, `forge`), `next` or null, `prs` (numbers) | `{ items, next }` |
| `create task` | `repository`, `title`, `body` | The new task, as an item |
| `took` | `repository`, `task` | `{ took }`, after reacting with 👀: `true` if this call added the reaction, `false` if the app's was there already, as when Skelcrew on another machine took the issue first |
| `open pr` | `repository`, `branch`, `base`, `title`, `body` | `{ number }`, of the PR already open from the branch if there is one |
| `close pr` | `repository`, `pr`, `branch`, `comment` or null | `null`, after posting the comment if there is one, closing the PR and deleting the branch |
| `review` | `repository`, `pr`, `commit`, `verdict` (`approve` or `changes`), `body` | `{ id }` |
| `status` | `repository`, `commit`, `state` (`pending`, `success` or `failure`), `description` | `null`, after setting the `skelcrew/check` status check |
| `seen` | `repository`, `pr`, `kind` (`comment` or `review`), `id` | `null`, after reacting with 👀 to a person's comment or review that skel typed into the builder. A review is reacted to itself, not its line comments, through GitHub's GraphQL API, as its REST API has no reactions on a review |
| `log` | `repository`, `check` | `{ log }`: the end of the failed check's log |
| `wake`, `unwake` | `repository`, `url` | `null`, after asking Skelcrew's service to start or stop passing wake-ups to the address |

**`changed`** reads one GraphQL query per repository, whatever the number of PRs Skelcrew
watches. Without `next`, it brings everything open. With it, everything updated since, closed
and merged ones too. Issues come only as the repository's tracker, and PRs only as its forge.
As the forge, the PRs in `prs` come too, whatever changed, since GitHub doesn't count a
finished check as a change to its PR. A list longer than one page is read to its end. As the
tracker, the first ask with no `next` creates the `skelcrew` label in the repository. `next` is
the newest change seen, or null when there was none.

An **item** is a task or a PR:

```json
{
  "kind": "task", "id": "12", "title": "…", "body": "…", "state": "open",
  "author": { "login": "simon", "bot": false, "you": true, "push": null },
  "labels": ["skelcrew"], "link": "https://github.com/simon/app/issues/12",
  "created": "2026-11-01T10:00:00Z", "updated": "2026-11-09T10:00:00Z",
  "closes": "Closes #12"
}
```

A PR has `kind: "pr"`, no `closes`, and adds `branch`, `base`, `conflicts`, `checks` (each with
`name`, `id` or null, and `state`: `running`, `passed`, `failed` or `cancelled`), `reviews`
(each with `id`, `text`, `author`, `verdict` and `lines`) and `comments` (each with `id`,
`text` and `author`). Its `state` can be `merged`.

An author's `you` says whether it is the person signed in to the plugin. `push` says whether
they can push to the repository. It is asked of GitHub only for the authors of reviews and
comments on the PRs in `prs`, as those are what Skelcrew may type into a builder. Everywhere
else it is `null`, as asking costs a request for each person.

`git_credentials` is `bun credentials.ts`, a git credential helper. Given the repository's
path, which Skelcrew has git send, it answers with that repository's token, as the user
`x-access-token`.

## Working on it

```sh
bun install
bun run check    # format, lint, typecheck and tests
```

The tests run each command as Skelcrew does, with a fake GitHub and a fake service.

To try a change in Skelcrew: `sc plugin install ./skelcrew-github` uses your folder where
it is, and `sc plugin update github` picks up your edits.

A release is a version tag, such as `v0.1.0`, matching `version` in `skelcrew-plugin.yaml`.
