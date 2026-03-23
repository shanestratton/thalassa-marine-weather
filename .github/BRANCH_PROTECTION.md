# Branch Protection — Recommended Settings

Configure these settings via **GitHub → Settings → Branches → Branch protection rules** for the `main` branch.

## Required Settings

| Setting                                   | Value      | Why                            |
| ----------------------------------------- | ---------- | ------------------------------ |
| **Require a pull request before merging** | ✅ Enabled | Prevents direct pushes to main |
| **Required approvals**                    | 1          | Code review before merge       |
| **Dismiss stale reviews**                 | ✅ Enabled | Re-review after new pushes     |
| **Require status checks to pass**         | ✅ Enabled | CI must succeed before merge   |

## Required Status Checks

Add these checks as required:

- `check` — Main CI job (lint, types, tests, build, E2E)
- `Analyze JavaScript/TypeScript` — CodeQL security scan
- `Lighthouse Audit` — Performance and accessibility checks

## Additional Protections

| Setting                             | Value      | Why                                                |
| ----------------------------------- | ---------- | -------------------------------------------------- |
| **Do not allow force pushes**       | ✅ Enabled | Preserves git history                              |
| **Do not allow deletions**          | ✅ Enabled | Prevents accidental branch deletion                |
| **Require conversation resolution** | ✅ Enabled | All review comments must be resolved               |
| **Require linear history**          | Optional   | Cleaner git log if your team prefers squash merges |

## Deployment Protection (Vercel)

If using Vercel's GitHub integration:

1. Go to **Vercel → Project → Settings → Git**
2. Enable **"Require preview deployment to succeed"**
3. The `preview-smoke.yml` workflow runs Playwright against preview URLs automatically
