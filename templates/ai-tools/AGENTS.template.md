# How to work in this repository

This repository is protected by the itm8 AI Factory gate. These rules are the same whichever AI tool is used: Claude, GitHub Copilot, Lovable, Cursor or another. They are written in plain words on purpose. If you are an AI assistant, follow them, and explain what you are doing to the person you work for in plain words, without jargon.

## How a change gets in

1. Start a new branch for the change. Never work on `main` directly.
2. Make the change on that branch.
3. Open a pull request into `main`.
4. Wait for the check named `gate / verdict` on the pull request. It runs the tests and the security checks.
5. When the check is green, merge the pull request. If it asks for a fix, fix it on the same branch and push again. The check runs again by itself.
6. After the merge, the change goes to `dev`.

## Rules that never change

- Work through pull requests only. Never push to `main`, and never try to get around the protection on it.
- Never put secrets in code. That means passwords, API keys, tokens, connection strings and certificates. If a secret is needed, tell the person; it belongs in the secret settings of GitHub or of the hosting service, not in a file. If you find a secret already in the code, say so and stop.

## When the check says `needs-person`

`needs-person` means a person at itm8 has to look at the change before it can be merged. It does not mean the change is wrong. Some kinds of change are always looked at by a person, for example changes to how the project is built and released, to where it runs, or to who can get access.

When you see it: leave the pull request open, tell the person that it is waiting for someone at itm8, and carry on with other work. Do not split the change up or rename files to avoid it, and do not turn the check off.

## Zone and level

Every repository has a zone (green, yellow or red) and a level (1, 2 or 3). itm8 decides both and sets them in `.github/workflows/aifactory-gate.yml`. They are not yours or the person's to choose: never ask the person which zone or level to use, never guess them, and never edit those two lines. If you need to know them, read that file.

## Opening the pull request

If the helper is installed, use it. In Claude Code, run `/aifactory-code:submit`. Otherwise open a normal pull request into `main` on GitHub, or with `gh pr create`.
