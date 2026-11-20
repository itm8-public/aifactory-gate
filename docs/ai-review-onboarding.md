# AI review onboarding checklist (per customer repository)

*Operational checklist for itm8 when turning the AI review on for a customer repository. Derived
from the gate's inputs ([`.github/workflows/gate.yml:28-46`](../.github/workflows/gate.yml)) and the
"AI review" section of [`README.md:18-30`](../README.md). The AI review is off until every item
here is done; a half-wired setup signs in, fails, and returns `needs-person` on every PR.*

## What the gate needs, and where each value goes

The caller workflow passes these inputs to the reusable gate. itm8 provides the values; the
customer (or itm8 with admin rights) sets them in the customer's
`.github/workflows/aifactory-gate.yml`.

| Input | Provided by | What it is |
| --- | --- | --- |
| `ai-review: true` | itm8 (flip once the rest is done) | Turns the review on ([`gate.yml:28-31`](../.github/workflows/gate.yml)). |
| `review-endpoint` | itm8 | The review Foundry's `https` origin ([`gate.yml:32-35`](../.github/workflows/gate.yml)). |
| `azure-client-id` | itm8 | Client id of the **customer's managed identity** for the review Foundry. Not a secret; used with GitHub OIDC ([`gate.yml:36-39`](../.github/workflows/gate.yml)). |
| `azure-tenant-id` | itm8 | The tenant of that identity ([`gate.yml:40-42`](../.github/workflows/gate.yml)). |
| `review-token-scope` | itm8 (default usually fine) | Entra scope of the model token. Default `https://cognitiveservices.azure.com/.default`; a Foundry **project** endpoint uses `https://ai.azure.com/.default` ([`gate.yml:43-46`](../.github/workflows/gate.yml)). |

The gate uses no stored secret: it signs in to the review Foundry with a GitHub OIDC token
([`gate.yml:85-104`](../.github/workflows/gate.yml)), which is why the federated-credential step
below is essential.

## Checklist

### 1. Consent *(do this first — it gates everything else)*
- [ ] Record the customer's agreement to the AI review. The review reads the changed code and
      sends it to itm8's review Foundry; the customer must agree to that
      ([`gate.yml:29`](../.github/workflows/gate.yml), [`README.md:5`](../README.md)).
- [ ] Confirm the data path with the customer: code under review is passed to the models as data,
      never as instructions; findings are evidence-checked and verified before they can block
      ([`README.md:20-30`](../README.md)). Models are EU Data Zone deployments
      ([`policy/models.v1.json:3`](../policy/models.v1.json)).

### 2. Managed identity (per customer)
- [ ] Ensure the customer has a **managed identity** (user-assigned) that is allowed to call the
      review Foundry deployments (`review-find`, `review-verify`, `review-explain` —
      [`policy/models.v1.json:4-6`](../policy/models.v1.json)).
- [ ] Record its **client id** and **tenant id** → these become `azure-client-id` and
      `azure-tenant-id`.

### 3. OIDC federated credential (the key step)
- [ ] On that managed identity, add a **federated credential** trusting GitHub Actions for this
      repository, so the GitHub OIDC token can exchange for an Entra token with no stored secret.
  - Issuer: `https://token.actions.githubusercontent.com`
  - Subject: scope it to the repository and the branches/events the gate runs on
    (`pull_request` and `push` to `main` — [`templates/aifactory-gate.yml:5-9`](../templates/aifactory-gate.yml)).
    Use a subject that covers both (e.g. `repo:OWNER/NAME:ref:refs/heads/main` plus a
    pull-request subject, or the environment subject if you scope by environment).
  - Audience: the default `azure/login` audience.
- [ ] Grant the identity access to the model deployments (RBAC on the Foundry resource) with the
      scope matching `review-token-scope`.

### 4. Review Foundry endpoint
- [ ] Record the review Foundry's `https` origin → `review-endpoint`.
- [ ] Decide the endpoint kind and set `review-token-scope` accordingly: account endpoint → default
      scope; Foundry **project** endpoint → `https://ai.azure.com/.default`
      ([`gate.yml:43-46`](../.github/workflows/gate.yml)).
- [ ] Confirm a token/quota budget for the three deployments.

### 5. Wire the caller workflow
- [ ] In the customer's `.github/workflows/aifactory-gate.yml`, set `ai-review: true` and fill
      `review-endpoint`, `azure-client-id`, `azure-tenant-id`, and (if needed) `review-token-scope`
      ([`templates/aifactory-gate.yml:23-27`](../templates/aifactory-gate.yml)).
- [ ] Confirm the caller grants `id-token: write` (it does in the template,
      [`templates/aifactory-gate.yml:11-13`](../templates/aifactory-gate.yml)); the reusable job
      also sets it ([`gate.yml:56-58`](../.github/workflows/gate.yml)).

### 6. Verify
- [ ] Open a test PR. In the job summary confirm the sign-in step succeeded and the summary shows an
      **"In plain words"** explanation paragraph (only written when the AI review ran and did not
      error — [`engine/src/report.mjs:19`](../engine/src/report.mjs),
      [`engine/bin/aifactory-review.mjs:130`](../engine/bin/aifactory-review.mjs)).
- [ ] Confirm a *clean* app-code PR returns `pass` (not `needs-person`). If it returns
      `needs-person` with reason "The AI review did not complete," the identity/credential wiring is
      wrong — recheck steps 2–4 ([`policy.mjs:47`](../engine/src/policy.mjs),
      [`gate.yml:83-84`](../.github/workflows/gate.yml)).

## Common failure and its signature

A missing or misconfigured federated credential → the Azure sign-in step fails (it is
`continue-on-error`, so the gate keeps going — [`gate.yml:85-88`](../.github/workflows/gate.yml)) →
the engine records the AI review as not completed → `notCompleted` → **`needs-person` on every
PR** ([`policy/policy.v1.json:73`](../policy/policy.v1.json)). If a customer reports "every PR needs
a person after we turned the AI review on," check the sign-in step first.
