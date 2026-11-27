# aifactory gate

This repository is the itm8 AI Factory review gate: the reusable workflow customer repositories call, the engine image, the verdict policy and the setup script.
It is public, so nothing here may name an internal system, a customer, a hostname or a secret; run `npm test` before every merge.

## Security baseline (applies to every change)
- No secrets, keys, tokens or connection strings in code, config, chat, logs or tests; secrets come from Key Vault or GitHub secrets.
- Collect and keep the least data needed; log ids, never personal data or whole request bodies.
- Examples, seeds and fixtures use invented data only, never real customer data.
- Use the latest supported versions; Dependabot is on and its security updates are merged promptly. Do not add a dependency without a stated reason.
- Pin GitHub Actions to commit SHAs and container images to a version or digest.
- Identities get the least privilege; no shared keys; prefer managed identity or OIDC.
- Every public endpoint is schema-validated and rate-limited; deny by default.
- New public surface (route, webhook, link, agent tool) needs a security review before merge.
- Agents propose, people decide; nothing sensitive leaves itm8 without a person approving it.
- Data stays in the EU unless the policy says otherwise and the customer consented.
- Run the secret scan, dependency audit and the repo's tests locally before merging; no required check does it for you.
