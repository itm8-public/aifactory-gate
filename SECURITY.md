# Security policy

## Report a vulnerability

Report a vulnerability in the gate (the reusable workflow, the engine image, the verdict policy, the rule pack or the setup script) privately, through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab and choose **Report a vulnerability**, or go to <https://github.com/itm8-public/aifactory-gate/security/advisories/new>.
2. Say what is affected (a file, a release tag such as `v0.6.0`, or the `v0` channel), what an attacker could do, and the steps to reproduce it.

Do not open a public issue, pull request or discussion about a vulnerability. Do not put secrets, tokens or real customer data in the report; invented values are enough to show the problem.

itm8 follows up in the private advisory and publishes it once a fixed release is out.

## Supported versions

Customers call the gate at `@v0`, so a fix ships as a new release and reaches `@v0` through the release steps in the README. Earlier `vX.Y.Z` tags are not changed; a repository that pins one moves to the fixed release.
