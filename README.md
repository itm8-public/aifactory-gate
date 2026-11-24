# aifactory gate

The itm8 AI Factory review gate for repositories where customers build with AI coding tools. Every pull request runs the project's tests and three scanners, and a deterministic policy decides `pass`, `fail` or `needs-person`. At responsibility level 2 the result is a required check: nothing reaches `main` or production without it.

Status: 0.1.0. Facts (tests, secrets, code security, dependencies) are live-tested on GitHub. The AI review is built and unit-tested but off by default; it needs itm8's review Foundry and the customer's consent, then one input in the caller (`ai-review: true`).

## How it works

1. The customer repository holds a short caller workflow (`templates/aifactory-gate.yml`) that calls `.github/workflows/gate.yml` at a release tag.
2. The gate runs the project's test command, then the engine image:
   - **gitleaks**: secrets (redacted; values never leave the scanner),
   - **Opengrep** with the itm8 rule pack in `rules/opengrep`: code security,
   - **OSV-Scanner**: known vulnerabilities in dependencies (sends package names and versions, not code, to osv.dev).
3. The engine reads the results and the changed paths and applies `policy/policy.v1.json`.
4. The verdict, the reasons and the versions go to the job summary and a `verdict.json` artifact (kept 90 days).
5. The ruleset on `main` requires the check `gate / verdict`. A `needs-person` verdict is cleared by the itm8 review team, the ruleset's bypass actor, which GitHub records in the audit log.

## AI review (off by default)

When the caller sets `ai-review: true`, the gate signs in to itm8's review Foundry with GitHub OIDC (no stored secret) and runs, after the scanners. The review identity lives in itm8's tenant, and its values come from the customer's page in the AI Factory Management App once the customer's consent is recorded there. `setup-repo.mjs --ai-review` writes them; see [`docs/ai-review-onboarding.md`](docs/ai-review-onboarding.md). If `ai-review` is true but a value is empty, the gate does not try to sign in. The verdict is `needs-person` with the names of the missing values.

| Step              | Who                      | What                                                                                              |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| 1. Find           | Model A                  | Reads the change and reports problems with file, line, an exact quote and a rule id               |
| 2. Evidence check | Code                     | Drops any finding whose quote is not at that line, whose file is not in the change, or whose rule is unknown |
| 3. Verify         | Model B (another family) | Tries to disprove each remaining finding; only confirmed findings can block                       |
| 4. Decide         | The policy               | Same input, same verdict                                                                           |
| 5. Explain        | Model C (cheapest)       | Writes the plain-language paragraph; it sees the result, never the code, and cannot change it    |

Code under review is passed as data, never as instructions; text in the change that addresses the reviewer is itself a finding (`reviewer-steering`). A model can only make the verdict stricter, and a review that does not complete is `needs-person`. Deployments per role are in `policy/models.v1.json`.

Before a model, prompt or policy change is released, run the evaluation set (kept private) with `node scripts/eval.mjs CASES_DIR --max-missed N --max-false N`; it reports found, missed and false flags per case.

## Verdict policy (v1.1)

| Fact                                                   | Green        | Yellow       | Red          |
| ------------------------------------------------------ | ------------ | ------------ | ------------ |
| A secret                                               | fail         | fail         | fail         |
| Finding at or above the zone's severity                | high: fail   | high: fail   | medium: fail |
| Tests failed                                           | fail         | fail         | fail         |
| Tests did not run                                      | needs-person | needs-person | needs-person |
| No tests configured                                    | note         | needs-person | needs-person |
| A scanner produced no result                           | needs-person | needs-person | needs-person |
| CI, deployment, infrastructure or the gate files changed | needs-person | needs-person | needs-person |
| Identity or access, or a database migration changed    | note         | needs-person | needs-person |
| Dependency manifest or lock file changed               | note         | note         | needs-person |

`fail` beats `needs-person`, which beats `pass`. A missing fact never passes. The path rules come from the AI Factory web template's pull request verdict.

With the AI review on: a confirmed critical finding needs a person; a confirmed high finding fails in green and needs a person in yellow and red; a finding the verifier could not confirm is listed as low and cannot block.

Level 1 runs the same checks but never blocks. Levels 2 and 3 block on anything but `pass`.

## Install in a repository

1. Copy `templates/aifactory-gate.yml` to `.github/workflows/` and set `zone`, `level` and `test-command`.
2. Copy `templates/CODEOWNERS` and set the review team or account.
3. Run the setup script (needs the GitHub CLI with admin rights on the repository). It prints every change; nothing happens without `--apply`:

   ```bash
   node scripts/setup-repo.mjs --repo OWNER/NAME --team aifactory-review          # organization repository
   node scripts/setup-repo.mjs --repo OWNER/NAME --reviewer LOGIN                 # repository owned by a person
   node scripts/setup-repo.mjs --repo OWNER/NAME --team aifactory-review --apply
   ```

   It creates the ruleset `aifactory gate` (pull request, code owner review, required check `gate / verdict`, no force push or deletion) and the environments `dev` and `prod` (deploys from `main` only; `prod` needs the itm8 reviewer).
4. Open a test pull request with a fake secret and check that the gate blocks it.

Rulesets on private repositories need GitHub Team (organizations) or Pro (personal accounts).

### Solo (self-service) profile

A customer who builds solo — one developer, no second reviewer — would otherwise be blocked by the
gate's own design: the first pull request (the gate setup) and every later CI/infrastructure change
route to `needs-person`, and on an organization repository only the itm8 review team can clear that.
The opt-in `solo` profile lets such a customer self-serve ordinary **green-zone** CI/infrastructure
changes, while everything that genuinely needs itm8 still blocks — any secret, the red zone, a
confirmed critical/high AI finding, and yellow/red-zone infrastructure.

Turn it on in two places:

```bash
node scripts/setup-repo.mjs --repo OWNER/NAME --team aifactory-review --profile solo --apply
```

and set `profile: solo` in the caller (`templates/aifactory-gate.yml`). With the profile on, a
green-zone CI/infra change gets a `pass` and the customer merges it themselves; the gate check still
fails (and only the itm8 team / repo admin can bypass) for the serious cases above. It is opt-in: a
repository set up without `--profile solo` keeps the standard, code-owner-reviewed behaviour. See
[`docs/solo-developer-redesign.md`](docs/solo-developer-redesign.md) for the trust model and the
security rationale.

### Turning on the AI review

After the customer's consent is recorded, their page in the AI Factory Management App shows the values and the command. The command opens a pull request in the repository that sets the AI review lines of the caller. It is a dry run until `--apply`, and it refuses empty or malformed values:

```bash
node scripts/setup-repo.mjs --repo OWNER/NAME --ai-review --review-endpoint https://NAME.openai.azure.com \
  --azure-client-id GUID --azure-tenant-id GUID [--review-token-scope https://ai.azure.com/.default] --apply
node scripts/setup-repo.mjs --repo OWNER/NAME --print-oidc   # the OIDC subject prefix for the review identity
```

See [`docs/ai-review-onboarding.md`](docs/ai-review-onboarding.md).

## Develop

```bash
npm test                                   # engine and setup script tests (Node 22 or later, no dependencies)
node scripts/build-image.mjs               # engine image, every version and checksum from pins.json
node engine/bin/aifactory-review.mjs verdict --repo . --out ./out --zone green --level 1 --check tests=success
```

## Release

A release goes out in two stages, so a version can be soaked before it reaches every customer.

- **`@v0`** — the **stable** channel. The caller template pins `@v0`; this is what customers run by default. It only moves on an explicit promote.
- **`@v0-next`** — the **prerelease** channel. Each release publishes here first. A customer can soak a new version by pinning `uses: …/gate.yml@v0-next` in their caller.

Run the `Release` workflow with the version in `package.json`. It tests, builds the image from `pins.json` and pushes it to GitHub Container Registry with a provenance attestation, then prints the digest and the two-stage commands:

1. **Publish to `@v0-next`** — a maintainer writes the digest into `GATE_IMAGE` in `gate.yml` on a release commit, tags `vX.Y.Z` and moves `@v0-next` (the stable `@v0` is untouched, so default customers are unaffected). The workflow token cannot do this, because GitHub does not let it push a commit that changes a workflow file.
2. **Promote to `@v0`** — after soaking on `@v0-next`, move `@v0` to the same commit: `git tag -f v0 v0-next && git push -f origin v0`. This is the step that rolls the version out to all stable customers.

Make the image package public once, by hand, so customer repositories can pull it. Protect the tags so only maintainers can move them. (`v0`/`v0-next` are shown for the current `0.x` line; a future `1.0` uses `v1`/`v1-next`.)

## Licence

MIT, see `LICENSE`. The scanners, rules and workflow are free to use. The AI review and the person review are services for itm8 customers: they need an identity that itm8 sets up for the customer's GitHub organization, so nothing in this repository grants them.
