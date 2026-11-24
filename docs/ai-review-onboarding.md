# Turning on the AI review for a customer repository

The AI review is off until a repository's caller workflow (`.github/workflows/aifactory-gate.yml`)
sets `ai-review: true` together with three values. This page is how those values are made and how
they get there. It is self-serve for every customer repository:

- **The review identity lives in itm8's tenant.** The customer does nothing in Azure, and nobody
  needs admin rights in any Azure portal for a new customer.
- **The values come from the customer's page in the AI Factory Management App.** The customer's
  consent is recorded there first; only then does the page show the values.
- **`setup-repo.mjs --ai-review` writes them.** It refuses an empty or malformed value, so a
  repository never gets `ai-review: true` with a blank, and it opens a pull request instead of
  pushing.

## What the gate needs

| Caller input | Value | Where it comes from |
| --- | --- | --- |
| `ai-review` | `true` | Written by `setup-repo.mjs --ai-review` |
| `review-endpoint` | The https origin of itm8's review Foundry | The customer's page in the Management App |
| `azure-client-id` | Client id of the customer's review identity (in itm8's tenant) | The customer's page |
| `azure-tenant-id` | itm8's tenant id | The customer's page |
| `review-token-scope` | `https://cognitiveservices.azure.com/.default` for an account endpoint; `https://ai.azure.com/.default` for a Foundry project endpoint | The customer's page (the default suits an account endpoint) |

None of these is a secret. The gate signs in with the GitHub OIDC token of the run, so there is no
stored key anywhere ([`gate.yml`](../.github/workflows/gate.yml), steps *AI review values*,
*Sign in to the review Foundry* and *Model token*).

## 1. Consent (Management App)

Record the customer's consent on their page in the Management App. Nothing else starts before it.
What the customer agrees to: the review reads the changed code and sends it to itm8's review
Foundry, on EU Data Zone deployments ([`policy/models.v1.json`](../policy/models.v1.json)). Code
under review is passed to the models as data, never as instructions, and a finding must pass an
evidence check and a second model before it can block ([`README.md`](../README.md), *AI review*).

## 2. The review identity (Management App, itm8's tenant)

After consent, the Management App provisions the customer's review identity in itm8's tenant. It is
allowed to call the review deployments on itm8's review Foundry and nothing else. The identity
trusts the customer's repository through two federated credentials:

| The gate runs on | Subject |
| --- | --- |
| A pull request | `PREFIX:pull_request` |
| A push to `main` | `PREFIX:ref:refs/heads/main` |

Issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange` (the
`azure/login` default).

**The prefix.** A repository can use GitHub's immutable subjects, which carry the organization and
repository ids:

```text
repo:ORG@ORGID/REPO@REPOID:pull_request
repo:ORG@ORGID/REPO@REPOID:ref:refs/heads/main
```

When a repository uses this form, a credential written in the plain form `repo:ORG/REPO:…` does not
match, and Entra rejects the sign-in. So the prefix is always read from GitHub, never typed. It
comes from `GET repos/OWNER/NAME/actions/oidc/customization/sub`: `sub_claim_prefix` when
`use_immutable_subject` is true, otherwise `repo:OWNER/NAME`. The Management App reads it itself.
When it cannot (a private repository it has no access to), an itm8 person runs this and pastes the
first line it prints into the customer's page:

```bash
node scripts/setup-repo.mjs --repo OWNER/NAME --print-oidc
```

It only reads. It also lists the two subjects. It refuses a repository with a custom subject
template (`use_default: false`), whose subjects have another shape; write those credentials by hand.

**No environment subject.** The gate job runs without a GitHub environment, so its token never
carries `…:environment:NAME`. A credential for an environment subject is never used.

**Endpoint and scope.** An account endpoint (`https://NAME.openai.azure.com`) uses the default
scope `https://cognitiveservices.azure.com/.default`. A Foundry project endpoint
(`https://NAME.services.ai.azure.com/api/projects/PROJECT`) uses `https://ai.azure.com/.default`.

## 3. Turn it on in the repository (setup-repo)

The customer's page shows the command with the values filled in. Run it from a clone of this
repository with the GitHub CLI signed in. It is a dry run until `--apply`:

```bash
node scripts/setup-repo.mjs --repo OWNER/NAME --ai-review \
  --review-endpoint https://NAME.openai.azure.com \
  --azure-client-id 00000000-0000-0000-0000-000000000000 \
  --azure-tenant-id 00000000-0000-0000-0000-000000000000 \
  --apply
```

For a Foundry project endpoint, add `--review-token-scope https://ai.azure.com/.default`. To set
up the ruleset in the same run, add `--team SLUG` or `--reviewer LOGIN` (see
[`README.md`](../README.md), *Install in a repository*).

What it does: it reads the repository's caller workflow on the default branch and sets the five AI
review lines in the gate job's `with:` block (`ai-review`, `review-endpoint`, `azure-client-id`,
`azure-tenant-id`, `review-token-scope`). No other line changes. It commits the file to the branch
`aifactory/ai-review` and opens a pull request. Running it again resets that branch and updates the
same pull request. It needs write access to the repository, and a GitHub CLI token with the
`workflow` scope (`gh auth refresh -s workflow`).

It refuses, exits non-zero and changes nothing, when:

- a value is empty,
- the endpoint is not an https origin (a project endpoint may add `/api/projects/NAME`),
- the client id or tenant id is not a GUID,
- the scope does not end in `/.default`, or a project endpoint comes without the
  `https://ai.azure.com/.default` scope,
- the caller workflow is missing, does not grant `id-token: write`, or does not call the gate
  exactly once.

Do not set `ai-review: true` by hand.

Merge the pull request. It changes a file under `.github/`, so with the standard profile the gate
asks for a person (the itm8 review team clears it). With `profile: solo` in the green zone, the
customer merges it themselves.

## 4. Check

On the next pull request, the job's *Sign in to the review Foundry* step succeeds, and the summary
has an **In plain words** paragraph, which is written only when the review ran. A clean change to
application code gets `pass`.

## When the summary says the AI review needs a person

Each of these is `needs-person` (the policy's `aiReview.notCompleted`), never a hard fail:

| The summary says | Cause | What to do |
| --- | --- | --- |
| *AI review is on, but its values … are missing in .github/workflows/aifactory-gate.yml* | `ai-review: true` with an empty value. The gate does not try to sign in. | Run `setup-repo.mjs --ai-review` with the values from the customer's page, or set `ai-review: false` until they are there. |
| *The AI review did not complete (model token is missing)* | The sign-in failed. In the job log, *Sign in to the review Foundry* shows the Entra error; *No matching federated identity record found* names the subject that GitHub presented. | Compare the identity's credentials with the output of `--print-oidc` (immutable or plain form), then the client id and tenant id. |
| *The AI review did not complete (review-find: HTTP 401)* or *(… HTTP 403)* | The token was issued for the wrong scope, or the identity may not call the deployments. | Match `review-token-scope` to the endpoint kind. Check the identity's access on the review Foundry. |
| *The AI review did not complete (review-find: HTTP 404)* | The endpoint is wrong, or the deployments named in `policy/models.v1.json` do not exist there. | Check the endpoint on the customer's page. |

Gate versions before 0.4.0 do not have the first row. There, empty values also show as *The AI
review did not complete (…)*.
