# Why the gate asks for a person, and how a change gets merged

*A plain-language reference for teams using the itm8 AI Factory gate. Written for version 0.1.0;
the sections on steering, reuse, who acts and the emergency bypass describe 0.5.0.*

## The short answer

The gate never blocks a change because the AI review is switched off. It blocks a change when
the change itself falls into a category the policy reserves for a person — and **changing the
gate's own setup (the workflow files, `CODEOWNERS`, anything under `.github/`, Dockerfiles,
infrastructure) is one of those categories in every zone.**

So the first pull request in any repository — the one that *installs* the gate — and any later
pull request that edits CI, deployment, or infrastructure files will show `needs-person`. That
is by design, not a fault, and it is not caused by the AI review being off. An ordinary
application-code change, with tests passing and the scanners clean, passes on its own with no
person involved.

## The three verdicts

The gate reads facts (test result, three security scanners, the list of changed files) and a
fixed policy turns them into one of three verdicts:

| Verdict | Meaning |
| --- | --- |
| `pass` | The change can be merged. |
| `fail` | Something must be fixed first (a secret, a failed test, a high/critical finding). Push a fix and the gate re-runs. |
| `needs-person` | A human has to look before it merges. The change is not necessarily wrong — it is in a category the policy does not decide on its own. |

The verdict is the required status check named **`gate / verdict`** on the `main` branch.

## What the responsibility levels actually mean

The `level` input has exactly one effect: whether the verdict *blocks*.

| Level | Behaviour |
| --- | --- |
| **1** | Advisory. The gate runs every check and writes the same verdict, but it never blocks a merge. |
| **2** | Blocking. Anything other than `pass` blocks. |
| **3** | Blocking. Identical to level 2 in the gate. |

Two things are worth stating plainly, because the shipped template comment has misled people:

- **Level 2 does not mean "itm8 approves every change."** It means "block on anything but pass."
  Most changes never involve itm8 at all — they pass automatically.
- **Level 2 and level 3 are identical** in what the gate enforces. The engine treats `level >= 2`
  as "enforce" and makes no other distinction ([`engine/src/verdict.mjs:65`](../engine/src/verdict.mjs)).
  The words "customer changes" vs "itm8 owns CI/CD" describe an *operating intention*, not a
  behaviour the gate implements.

*(The template comment that reads `2 customer changes and itm8 approves, 3 itm8 owns CI/CD`
([`templates/aifactory-gate.yml:20`](../templates/aifactory-gate.yml)) is being corrected.)*

## The full list of what asks for a person

The policy is deterministic — same facts in, same verdict out — and lives in
[`policy/policy.v1.json`](../policy/policy.v1.json). What triggers `needs-person` depends on the
repository's **zone** (green, yellow, or red, registered for the solution):

| Fact about the change | Green | Yellow | Red |
| --- | :---: | :---: | :---: |
| A required check (including tests) did not run | person | person | person |
| A scanner produced no result | person | person | person |
| The changed files could not be read | person | person | person |
| **CI, deployment, infrastructure, or the gate's own files changed** | **person** | **person** | **person** |
| No tests configured | note | person | person |
| Identity/access code, or a database migration, changed | note | person | person |
| A dependency manifest or lock file changed | note | person | person |

"note" means it is recorded but does not block. Separately, a secret, a failed test, or a
finding at/above the zone's severity is a `fail` (fix-and-push), not `needs-person`.

The "CI, deployment, infrastructure or the gate's own files" category matches, among others:
anything under `.github/`, `infra/`, any `Dockerfile`, `docker-compose`, Azure Pipelines /
GitLab / Bitbucket pipeline files, `*.bicep` / `*.tf` / `*.tfvars`, `azure.yaml`, `CODEOWNERS`,
and anything under `.aifactory/` ([`policy/policy.v1.json:42-52`](../policy/policy.v1.json)).

### Reading it for a specific pull request

Every run writes a **"Why"** section in the pull request's job summary, listing the exact
reason(s) for the verdict ([`engine/src/report.mjs`](../engine/src/report.mjs)), with **"Who acts"**
and **"Fix it"** above it. That is the authoritative answer for any single PR — match the reason
text to the table above.

Worked example — the gate-setup PR (installing the gate):

- It adds `.github/workflows/aifactory-gate.yml` and a `CODEOWNERS` file.
- Both match the CI/infrastructure category → `needs-person`, in every zone.
- This is unavoidable with the gate as shipped today: the PR that turns the gate on is itself a
  CI change, so the very first PR always needs a person.

For a repository registered as **green**, an ordinary application-code change (no CI/infra
files, tests green, scanners clean, all tools ran) returns `pass` with no person. If PRs that
look like ordinary app changes are still asking for a person, the likely causes are: the repo is
registered as **yellow or red** (where identity, migrations, dependencies, and missing tests all
require a person), the PR touched one of the infra paths above, or a scanner/check did not run on
that run. The PR's own "Why" section says which.

## What the AI review does and does not change

The AI review is **off by default** and must be turned on per repository. Turning it off is not a
reason any change is blocked: when it is off, the policy simply does not add any AI-related
reason ([`engine/src/policy.mjs:45`](../engine/src/policy.mjs)).

When it is **on**, it can only make a verdict *stricter*, never looser:

- a confirmed critical finding → `needs-person`;
- a confirmed high finding → `fail` in green, `needs-person` in yellow/red;
- a review that cannot complete → `needs-person`.

**Turning the AI review on will not make CI/infrastructure PRs pass automatically.** The file-path
rules above are independent of the AI review. The setup PR will still need a person with the AI
review on.

### Text that tries to steer the AI review

The reason "Text in the change tries to steer the AI review (file line N)" means the change holds an
instruction to the reviewer or to a model about what to report, skip or conclude ("ignore",
"approve", "do not report", "you are now …"), or text hidden from people that a model would read
(invisible characters, an HTML comment in Markdown addressed to an AI). Hidden characters are found
without a model.

Text that only **describes** the gate or the review is not steering: a README that explains what
the gate checks and who clears `needs-person`, the `AGENTS.md` rules for coding assistants, or the
prompt an app sends to its own model. Since engine 0.5.0 (prompt version 2) the AI review is told
the difference and measured on it; see the evaluation numbers in the release notes.

## A push to main reuses the pull request's verdict

When a push to `main` holds exactly the change a pull request's gate run already judged — the same
tree on the same base tree, the same gate version and the same caller inputs — the gate takes that
verdict instead of running again. The summary says so and links the run it came from. Same change,
same verdict, and the AI review is paid for once. Anything that differs (another commit on `main`
in between, a rebase of several commits, a changed caller setting) means a normal run.

This needs `actions: read` in the caller's `permissions` (and `pull-requests: read` or `write`
to find squash merges). Without it the gate runs in full, as before.

## Who acts, and the pull request comment

Every result that is not `pass` says **who acts** (you, the contributor; itm8; or the customer
admin), **why**, and a short **Fix it** block: plain steps, and a prompt you can paste into any AI
tool (Claude, GitHub Copilot, Lovable, Cursor) or hand to a person. The prompt only names files,
lines and the gate's own rules; it never repeats a secret or text from the change.

The same text goes on the pull request as one comment, updated on every run, when the caller
grants `pull-requests: write`. Without it, the job summary has it.

## How a `needs-person` verdict is cleared today

The gate's ruleset lets one **bypass actor** merge past a `needs-person` check. Who that is
depends on how the repository is owned ([`scripts/setup-repo.mjs:37-41`](../scripts/setup-repo.mjs)):

- **Organization repository** (set up with `--team`): the bypass actor is the **itm8 review
  team**. A solo developer who is not on that team cannot clear it themselves — someone on the
  itm8 team (or a repository/organization admin using an admin override) has to merge.
- **Personal repository** (set up with `--reviewer`): the bypass actor is the **repository-admin
  role**, so the repository's own admin can clear it.

There is no self-service label, no re-run-to-clear path, and no published response time in the
gate today. This is the main friction for a solo developer on an organization repository, and the
redesign proposal addresses it directly.

## Emergency bypass

For when **the gate itself fails** — an itm8 problem, not a finding. The summary then reads "The
gate could not finish": a scanner gave no result, the AI review could not be reached, or the gate
produced no verdict at all. It is never for `fail` or for a `needs-person` about the change itself:
those are about the code, and a bypass would let a secret or a real problem into `main`.

1. **Run the job again** (the run's page, *Re-run jobs*). Most outages pass in minutes.
2. **Tell itm8**, with the link to the run. On an organization repository the itm8 review team can
   merge past the check: it is the ruleset's bypass actor. On a personal repository the repository
   admin can.
3. **Only if the change cannot wait and itm8 cannot be reached**, the customer admin (an
   organization owner, or an admin of the repository) can:
   - open the repository's *Settings → Rules → Rulesets → aifactory gate*;
   - set *Enforcement status* to *Disabled*, merge the pull request, and set it back to *Active*
     straight away;
   - tell itm8 the same day: the pull request, and why it could not wait.

   GitHub records both ruleset changes in the organization's audit log. The push to `main` after
   the merge runs the gate as usual, so the result is on record either way.

## Is `gate / verdict` a stable name to depend on?

Yes, for the `@v0` line, with one condition you control.

The required-check name is the caller's job name, a slash, and the reusable workflow's job name:

- the reusable workflow's job is named `verdict` ([`.github/workflows/gate.yml:52-53`](../.github/workflows/gate.yml)) — itm8 keeps this fixed as part of the `@v0` contract;
- your caller workflow names its job `gate` ([`templates/aifactory-gate.yml:18`](../templates/aifactory-gate.yml)), which is why the template says **"Do not rename the job `gate`."**

Together that gives `gate / verdict`, and your ruleset depends on exactly that string
([`scripts/setup-repo.mjs:16`](../scripts/setup-repo.mjs)). **As long as you do not rename your
`gate` job, `gate / verdict` is stable for `@v0`.** itm8 treats the `verdict` job name as frozen
for `@v0`; it would only change on a new major tag (`@v1`), which you would adopt deliberately.
