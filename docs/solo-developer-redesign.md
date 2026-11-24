# Solo / self-service redesign proposal

*Design note for the itm8 AI Factory gate. Audience: the gate owner and maintainers.
It states the problem precisely, proposes a redesign with recommended defaults, and names the
exact change points. It does not change any customer repository. Companion to
[`gate-verdicts-explained.md`](gate-verdicts-explained.md).*

## Implemented in v0.3.0 (opt-in `solo` profile)

Items (iii) scanner retry and (iv) reason-first summary shipped in 0.2.0. Items (i), (ii) and (vi)
are implemented as an **opt-in `solo` profile** that activates only when a caller sets `profile: solo`
and a repository is onboarded with `setup-repo.mjs --profile solo`. The default behaviour is
unchanged.

A security finding changed the mechanism for item (i). The original note suggested doing the unblock
purely in the ruleset/bypass-actor layer. That cannot be done safely: GitHub ruleset **bypass is
all-or-nothing**, so making the customer's lead a bypass actor would also let them bypass a secret
(`fail`), the red zone, or a confirmed critical finding — the ruleset cannot see *why* the check
failed. And a *genuinely* solo developer can never satisfy `require_code_owner_review` (GitHub does
not let an author approve their own PR). So the unblock is done where it can be precise:

- **The gate stops *blocking* green-zone-infra-only cases** for the solo profile, via a separate
  [`policy/policy.solo.v1.json`](../policy/policy.solo.v1.json) that differs from
  [`policy/policy.v1.json`](../policy/policy.v1.json) in exactly one field (green `ci-infra` →
  `none`). A test asserts that one-field difference, so the two policies cannot silently drift.
  Everything that needs itm8 — any secret, the red zone, confirmed critical/high AI findings,
  yellow/red-zone infra, a missing scanner, a check that did not run — still blocks.
- **A new optional caller input `profile`** ([`.github/workflows/gate.yml`](../.github/workflows/gate.yml))
  selects it; empty keeps the standard policy, so existing callers are byte-for-byte unaffected. The
  engine ([`engine/bin/aifactory-review.mjs`](../engine/bin/aifactory-review.mjs)) maps `profile: solo`
  to the solo policy.
- **`setup-repo.mjs --profile solo`** sets the ruleset to not require a code-owner review (a solo
  customer has no second reviewer); the gate check and the itm8/repo-admin bypass actor are unchanged,
  so the serious cases the gate still blocks remain itm8's to clear.
- **AI review:** the solo caller template documents turning the review on only when itm8 has
  provisioned the identity and supplied the inputs (see [`ai-review-onboarding.md`](ai-review-onboarding.md)).
  Fully automating the managed-identity / OIDC / consent setup is **not** done here — it remains the
  manual onboarding step, flagged for a later change. *Update (0.4.0): done. The review identity lives
  in itm8's tenant and is provisioned from the Management App after consent; `setup-repo.mjs
  --ai-review` writes the values and refuses empty ones. See
  [`ai-review-onboarding.md`](ai-review-onboarding.md).*

The deliberate trade-off, accepted by the owner: on the solo profile, ordinary green-zone CI/infra
changes are self-served by the customer with only automated assurance (scanners, tests, and the AI
review when on) and **no human review**, because a genuinely solo customer has no second person.
This activates only on a new release (owner-gated) and only for repositories that opt in.

## The problem, precisely

Many customers will build solo and self-service (one developer, no second reviewer on hand).
The gate as shipped has three traps for them. None is a bug — each is a reasonable default that
assumes an itm8 reviewer is nearby. For a solo developer in an organization repository, that
assumption fails.

1. **Every repository's first PR, and every later infra/CI PR, routes to a person who may not be
   reachable.** The gate-setup PR adds `.github/` and `CODEOWNERS`, which match the `ci-infra`
   category → `needs-person` in all zones ([`policy/policy.v1.json:42-52`](../policy/policy.v1.json)).
   The only actor who can clear it is the ruleset's single bypass actor: for an org repo set up
   with `--team`, that is the itm8 review team ([`scripts/setup-repo.mjs:37-41`](../scripts/setup-repo.mjs)).
   A solo developer not on that team is blocked with no self-service path and no published SLA.
   Without someone from that team, the only way through is an admin override.

2. **A transient scanner or AI-review failure becomes `needs-person` with no retry.** A scanner
   runs once ([`engine/src/scan.mjs:32-48`](../engine/src/scan.mjs)); if it fails to run, the tool
   is recorded as not-run → `missingTool` → `needs-person`. A flaky network call or a cold image
   pull turns into a human gate with no automatic retry.

3. **The AI review's day-one value is not delivered.** The gate promises "AI reviews and passes
   most changes," but the AI review is off by default and needs itm8's review Foundry endpoint,
   the customer's managed identity wired to GitHub OIDC (a federated credential), the customer's
   consent, and a token budget — none of it automated ([`.github/workflows/gate.yml:28-46`](../.github/workflows/gate.yml),
   [`README.md:85`](../README.md)). So the first experience of the gate is "it blocks me," not
   "it reviews and passes me."

## The core design principle

The policy engine is **deterministic and cannot see approvals** — it decides from facts and file
paths alone ([`engine/src/policy.mjs`](../engine/src/policy.mjs)). So the question "has an
appropriate human approved this?" cannot be answered inside `policy.v1.json`. It belongs one
layer up, in the **ruleset / CODEOWNERS / bypass-actor** configuration that `setup-repo.mjs`
writes.

That lets us split today's single `needs-person` into two distinct needs:

- **"needs itm8"** — secrets, red zone, confirmed critical/high AI findings. These stay gated on
  the itm8 team.
- **"needs a human, who may be the customer's own lead"** — ordinary green-zone infra/CI changes
  (the setup PR, a Dockerfile tweak, a workflow edit). These are already covered by **code-owner
  review** in the ruleset; they do not need itm8 specifically, only *a* reviewer, which can be the
  customer's own code owner.

The engine keeps emitting one deterministic verdict. What changes is *who can satisfy it*, which
is a setup-layer decision, plus clearer reporting and retries in the engine.

## Recommended defaults (the "solo" profile)

Introduce an onboarding profile — call it **`solo`** — that `setup-repo.mjs` applies, with these
defaults. Each is justified and reversible:

| Setting | Today | Recommended for `solo` | Why |
| --- | --- | --- | --- |
| Green-zone infra/CI bypass actor | itm8 team only | **the customer's own code owner** (via CODEOWNERS + a second bypass actor, or code-owner review satisfying the check) | A solo dev can self-approve their own setup/infra PRs; itm8 stays on secrets/red/critical. |
| AI review | off | **on**, with identity + consent automated at onboarding | Delivers the promised "review and pass" on day one. |
| Transient scanner / AI-review failure | `needs-person`, no retry | **retry once, then `needs-person`** | Removes flaky-run human gates. |
| Summary | reason list | **leads with the one concrete reason + the exact next step** | The solo dev knows immediately what to do. |
| Clearing path | undocumented | **documented: who, how, and SLA** | No more "stuck with no way forward." |

Keep the stricter behaviour for **yellow/red** zones and for secrets/critical findings: those
still need itm8. The split is the whole point — don't loosen what genuinely needs itm8.

## Change points

Each item: what it is, the file(s), whether it is an **engine**, **setup/ruleset**, or **docs**
change, and the recommendation.

### (i) Split "needs itm8" from "needs a human" — **setup/ruleset change** *(highest impact)*

Do **not** touch `policy.v1.json` for this. The deterministic engine should keep emitting
`needs-person` for green-zone infra. Instead, change who can clear it:

- **File:** [`scripts/setup-repo.mjs:37-85`](../scripts/setup-repo.mjs) (the `plan()` function),
  [`templates/CODEOWNERS`](../templates/CODEOWNERS).
- For the `solo` profile, add the customer's code-owner (team or the developer's account) as a
  **second bypass actor** on the ruleset, or rely on the existing `require_code_owner_review`
  rule so that a code-owner approval satisfies the PR rule while the itm8 team remains the bypass
  actor for the status check. Keep the itm8 team as bypass actor for repositories that genuinely
  want itm8 to hold the keys.
- The ruleset already requires code-owner review ([`setup-repo.mjs:51-60`](../scripts/setup-repo.mjs)),
  so the CODEOWNERS layer is the natural home for "a human approved this."
- **Recommendation: adopt.** This is the one change that actually unblocks solo developers, and
  it stays within the `@v0` contract (it changes setup, not the reusable workflow or the check
  name).

### (ii) AI review on by default, with identity + consent automated — **setup + docs**

- **Files:** [`scripts/setup-repo.mjs`](../scripts/setup-repo.mjs) (extend to create the OIDC
  federated credential on the customer's managed identity and to write the `ai-review` inputs into
  the caller), [`templates/aifactory-gate.yml:23-27`](../templates/aifactory-gate.yml) (flip the
  default once identity is wired), the onboarding checklist in
  [`ai-review-onboarding.md`](ai-review-onboarding.md).
- Gate flipping the default on the identity being provisioned — never ship `ai-review: true` with
  empty endpoint/client-id, or every run signs in, fails, and returns `needs-person`
  ([`gate.yml:85-104`](../.github/workflows/gate.yml), `notCompleted` → `needs-person`).
- *Update (0.4.0): the identity is not created in the customer's tenant; it lives in itm8's tenant
  and the Management App provisions it. `setup-repo.mjs --ai-review` writes the inputs and refuses
  empty ones, and the gate names missing values instead of trying to sign in. See
  [`ai-review-onboarding.md`](ai-review-onboarding.md).*
- **Recommendation: adopt, but sequence it after (i) and (iii).** The value is real, but it
  depends on the identity automation existing first.

### (iii) Retry transient scanner / AI-review failures before `needs-person` — **engine change**

- **Files:** [`engine/src/scan.mjs:32-48`](../engine/src/scan.mjs) (wrap `spawnSync` in a
  retry-once-on-failure), optionally [`engine/bin/aifactory-review.mjs:80-94`](../engine/bin/aifactory-review.mjs)
  for the AI-review path.
- Retry once (or twice with backoff) on a non-`ok` exit or spawn error before recording
  `ran: false`. Distinguish "ran, found nothing" from "could not run."
- **Recommendation: adopt.** Low-risk, purely internal to the engine image, no `@v0` surface
  change, removes a whole class of spurious human gates.

### (iv) Summary leads with the concrete reason + exact next step — **engine change**

- **File:** [`engine/src/report.mjs`](../engine/src/report.mjs).
- Today the `needs-person` headline is hard-coded to "Waiting for the itm8 review team"
  ([`report.mjs:7`](../engine/src/report.mjs)) even for personal repos (where the clearer is the
  repo admin) and for green-zone infra (which a customer code owner can clear). Make the headline
  and first line depend on the reason and the clearing path: e.g. "This PR changes CI/infra files,
  so a code owner must approve it — ask @…" vs "A secret was found — the itm8 review team will
  look." The `reasons[]` already carry the facts ([`policy.mjs:21-22,65-67`](../engine/src/policy.mjs)).
- **Recommendation: adopt.** Low-risk; it is the cheapest large improvement to the solo-dev
  experience and corrects a factually wrong headline.

### (v) Documented self-service clearing path — **docs + setup**

- **Files:** [`README.md`](../README.md) (a "How a needs-person clears" section naming who, how,
  and the response-time commitment), and the bypass-actor wiring from (i).
- State the mechanism (code-owner approval / bypass actor / re-run for transient failures), who
  holds it per ownership model, and the SLA when itm8 is the clearer.
- **Recommendation: adopt.** No code risk; it closes the "stuck with no way forward" gap even
  before (i) ships.

### (vi) A `solo` onboarding profile encoding all of the above — **setup change**

- **File:** [`scripts/setup-repo.mjs`](../scripts/setup-repo.mjs) (add a `--profile solo` that sets
  the bypass actors, enables AI review inputs, and picks the green defaults).
- **Recommendation: adopt last, as the packaging of (i)–(v).** It is convenience, not new
  behaviour; build it once (i)–(v) are settled so it does not encode a moving target.

## Delivery / promotion view *(secondary)*

Related delivery questions come up alongside this: a prod environment, build-once/promote-the-SHA
image, post-deploy agent tests, and a short (1–2h) prod window via cron or dispatch with a concurrency lock.

itm8's view:

- **Build-once, promote-the-SHA-image is the right shape** and the gate already fits it. The
  release flow builds one image and pins it by digest ([`README.md:80-81`](../README.md)); the same
  discipline should apply to the customer's app image — build on the merge to `main`, then promote
  that exact digest to prod. The gate's `verdict.json` artifact (kept 90 days,
  [`gate.yml:130-137`](../.github/workflows/gate.yml)) is the natural evidence to attach to the
  promoted release.
- **Should the gate be the required check before prod promotion too?** Yes, in principle, but
  reuse the existing control rather than inventing a second gate: the `prod` environment created by
  [`setup-repo.mjs:77-83`](../scripts/setup-repo.mjs) already requires a reviewer and deploys from
  `main` only. The gate's verdict on the merge commit is the pre-prod signal; the prod environment
  approval is the promotion signal. Attach the AI-review verdict (from `verdict.json`) to the
  release/deployment so the promoter sees what the gate concluded. Don't add a separate
  "gate before prod" status check — it would duplicate the `main` check and complicate the `@v0`
  contract.
- **Post-deploy agent tests** belong in the `prod` deployment job after promotion, not in the
  gate. Keep the gate's job (`verdict`) single-purpose so the `gate / verdict` check name stays
  stable.
- **The 1–2h prod window (cron or dispatch + concurrency lock)** is a deployment-pipeline concern,
  not a gate concern. A `concurrency` group on the promotion workflow plus a scheduled or manual
  dispatch is the right tool; the gate does not need to know about it.

Keep this secondary: it is additive and does not block the solo-dev fix.

## Recommendation: hold for owner approval

**Hold. Do not ship the redesign as a gate-repo PR yet.** The redesign changes the trust model
for *all* customers — specifically who can clear a `needs-person` verdict (item i) and whether the
AI review is on by default (item ii). That is the owner's call, not a maintainer's, and it should
be made deliberately per customer profile rather than flipped globally.

What can safely ship now, independently, because each is low-risk and inside the `@v0` contract:

- **(iii) scanner retry** and **(iv) summary-first-reason** — pure engine-image changes, no
  surface change, strictly fewer spurious human gates and clearer messaging.
- **(v) documented clearing path** and the **template comment correction** (the misleading
  `level: 2` comment at [`templates/aifactory-gate.yml:20`](../templates/aifactory-gate.yml)) —
  docs only.

The model-changing items **(i), (ii), (vi)** wait for the owner's go-ahead. If the owner approves,
ship them behind the `--profile solo` flag (vi) so existing customers are unchanged until opted in.
