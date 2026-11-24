# Any AI tool, the same rules

Customers write code with Claude, GitHub Copilot, Lovable, Cursor and other tools. itm8 does not
tie a customer to one of them. Every repository carries the same tool-neutral instructions
(`AGENTS.md`) and thin per-tool adapters, and the security is the same whichever tool wrote the
change, because the gate runs on GitHub, not in the tool. A change from Lovable, from Copilot and
from a person at a keyboard all meet the same pull request and the same check, `gate / verdict`.

`setup-repo.mjs` puts these files in a customer repository, in one pull request.

## What setup adds

| File | Read by | What it is |
| --- | --- | --- |
| `AGENTS.md` | Copilot, Cursor, Claude Code (through `CLAUDE.md`) and other tools that read it | The shared instructions, in plain words for non-developers: the change flow (branch, pull request, `gate / verdict`, merge, `dev`), pull requests only and never a push to `main`, no secrets in code, what `needs-person` means, that itm8 decides the zone and level, and how to open the pull request |
| `.claude/settings.json` | Claude Code | Adds the itm8 marketplace (`extraKnownMarketplaces`, `itm8-public/aifactory-code`) and turns the plugin on (`enabledPlugins`, `aifactory-code@itm8-aifactory-code`). Merged into an existing file |
| `CLAUDE.md` | Claude Code | One line, `@AGENTS.md`, that imports the shared instructions. Created only if the repository has no `CLAUDE.md` |
| `.github/copilot-instructions.md` | GitHub Copilot | A short pointer to `AGENTS.md`. Copilot also reads `AGENTS.md` directly |
| *(no file)* | Lovable | See [Lovable](#lovable) |

The file texts are in [`templates/ai-tools/`](../templates/ai-tools). They are the only place to
change them.

Claude Code reads `AGENTS.md` by itself only when the repository has no `CLAUDE.md`. As soon as a
`CLAUDE.md` exists it reads that file instead, so the adapter imports `AGENTS.md` with a line
`@AGENTS.md`. That is why the Claude adapter is not optional once there is a `CLAUDE.md`.

## Run it

It is part of the standard setup: every run with `--team` or `--reviewer` also prepares this pull
request. Like everything else in the script, it is a dry run until `--apply`.

```bash
node scripts/setup-repo.mjs --repo OWNER/NAME --team aifactory-review                  # ruleset, environments, AI tool files
node scripts/setup-repo.mjs --repo OWNER/NAME --tools claude,copilot                   # only the AI tool files
node scripts/setup-repo.mjs --repo OWNER/NAME --tools claude,copilot --apply           # open the pull request
```

| `--tools` | Adds |
| --- | --- |
| `claude,copilot` (the default) | `AGENTS.md` and both adapters |
| `claude` | `AGENTS.md`, `.claude/settings.json`, `CLAUDE.md` |
| `copilot` | `AGENTS.md`, `.github/copilot-instructions.md` |
| `none` | `AGENTS.md` only (a customer that uses Lovable or Cursor only) |

`AGENTS.md` is always part of it. A run that only turns the AI review on (`--ai-review` without
`--team` or `--reviewer`) does not open this pull request, unless `--tools` is given too. Write
access to the repository is enough; admin rights are only needed for the ruleset and environments.

The files go on the branch `aifactory/ai-tools` as one pull request into the default branch. Running
it again resets that branch and updates the pull request.

### Existing files are never overwritten

The script reads the default branch first and reports what it kept, in the output and in the pull
request:

- **`AGENTS.md`, `CLAUDE.md` (also `.claude/CLAUDE.md`), `.github/copilot-instructions.md`:** kept as they are. If a
  `CLAUDE.md` does not import `AGENTS.md`, the output says so and what line to add; Claude Code will
  not see the shared instructions until it is added.
- **`.claude/settings.json`:** merged. The two entries are added and every other setting stays. A
  value that is already there is not changed: a plugin the customer switched off stays off, and
  the output says so. A file that is not valid JSON, or whose `extraKnownMarketplaces` or
  `enabledPlugins` is not an object, is left untouched and the output says what to add by hand.

Nothing to add means no pull request: the output ends with `Nothing to change.`

## Lovable

Lovable needs no file. When the default branch is protected, as the gate's ruleset makes `main`,
Lovable cannot push to it and pushes to a branch called `lovable-sync` instead. That branch goes
through the same route as any other change: open a pull request from `lovable-sync` into `main`,
let `gate / verdict` run, and merge when it is green. Nothing in the gate is specific to Lovable.

Cursor and other tools that read `AGENTS.md` need no adapter either.

## The pull request and the gate

The gate asks a person at itm8 to look at any change under `.github/`, in every zone (the `ci-infra`
rule in [`policy/policy.v1.json`](../policy/policy.v1.json)). So a pull request that adds
`.github/copilot-instructions.md` shows `needs-person`, the same as the pull request that installs
the gate; see [why the gate asks for a person](gate-verdicts-explained.md). It is not a fault, and
the pull request says so. Later edits to that file are the same. `AGENTS.md`, `CLAUDE.md` and
`.claude/settings.json` are not under `.github/`, so `--tools claude` or `--tools none` gives a
pull request that does not meet that rule.

## Keep the instructions plain

`AGENTS.md` is written for people who are not developers, and for the AI tools they work with. It
says what to do and what never to do. It must never describe how the AI review decides, or speak
to a reviewer: the gate flags text in a change that addresses the reviewer or tries to change how
the change is reviewed (`reviewer-steering`), and a rulebook that describes the review would
trigger that on its own pull request. A test in `tests/setup-repo.test.mjs` fails if a template
mentions the review.
