# Making the app repository private

Owner decision, 2026-10-10: make `thalassa-marine-weather` private so nobody can copy the code. The ocean data the app
shows moves to a separate **public** repository, `shanestratton/thalassa-ocean-data`, because the app's server downloads
it from GitHub without logging in, and a private repository would answer "not found".

**The order matters.** If the repository goes private before the app reads ocean data from the new repository, every
currents, sea-temperature, chlorophyll and protected-area layer stops at once, on the web and on phones.

## Already done

- `thalassa-ocean-data` holds the seven ocean-data publishers with their tests, its own checks and a monthly keepalive
  (GitHub switches schedules off after 60 quiet days in a public repository).
- This repository:
    - reads ocean data from there (`MARINE_RELEASE_REPOSITORY`);
    - no longer contains the publishers;
    - runs a slimmer CI (below);
    - no longer has CodeQL or the duplicate Lighthouse workflow;
    - downloads Pi code with a token.

## Your steps, in this order

1. **Turn on the ocean-data publishers.**
    - In `thalassa-ocean-data`, add the `COPERNICUS_MARINE_USERNAME` and `COPERNICUS_MARINE_PASSWORD` secrets
      (**Settings → Secrets and variables → Actions**).
    - Under **Actions**, run each of the seven pipelines once (**Run workflow**).
    - **Check:** the repository's **Releases** page lists seven `…-latest` releases, each with `manifest-v2-a.json` and
      `manifest-v2-b.json`.
2. **Switch the app over.** Merge the go-private pull request (or ask Claude to). Vercel deploys it in a few minutes.
    - **Check:** run `curl -sSI https://www.thalassawx.app/api/currents/manifest-v2.json`. The answer must show
      `HTTP/2 200` and `x-thalassa-valid-manifest-slots: 2`. Repeat with `sst`, `chl` and `mpa` in place of `currents`.
    - **Check:** the **Hosted Deploy Smoke Test** for that commit is green.
    - **If anything is red:** revert the merge. That brings back the old publishers and the old address together.
3. **Vercel's smoke-test secret.** Private repositories on GitHub Free ignore "environment" secrets. If
   `VERCEL_AUTOMATION_BYPASS_SECRET` is listed under **Settings → Environments → Preview**, also add it under **Settings
   → Secrets and variables → Actions → Repository secrets**.
4. **Tokens for the machines that pull the code** (next section).
5. **Set an Actions budget:** **Settings → Billing and licensing → Budgets and alerts**, Actions, about US$30 a month with
   an email alert. See **What CI costs** below.
6. **Make it private:** **Settings → General → Danger Zone → Change repository visibility → Make private.**
7. **Afterwards:**
    - Run the step 2 checks again.
    - Push something small and confirm Vercel still deploys.
    - Start one Claude session to confirm it can still open the repository.

**Rewriting history:** wait until step 2 has passed. Deleting or moving the old release tags in this repository before
then would break the layers immediately. After step 2, nothing reads those old releases.

**What going private cannot undo:** copies already made stay out there, including forks and clones. Any key that was
ever committed must be changed at its provider, not just hidden. **Insights → Forks** shows the existing forks.

## Pis and other machines that pull the code

Each machine needs its own **fine-grained token**, so a lost Pi can be revoked without touching the others. To make one:

1. GitHub → your picture → **Settings → Developer settings → Fine-grained tokens → Generate new token**.
2. Fill it in:
    - **Repository access:** _Only select repositories_ → `thalassa-marine-weather`.
    - **Permissions:** _Contents: Read-only_. Nothing else.
    - **Expiration:** up to a year. Note the date: when it expires, the Pi stops updating, though it keeps running.

Using it:

- **Pi installed with `install.sh`:** `sudo bash /opt/thalassa-pi-cache/install.sh --update` asks for the token once
  and keeps it root-only in `/etc/thalassa/github-token`. (`pi-cache/README.md` has first install and fixes.)
- **The boat Pi's full checkout** (`~/thalassa-marine-weather`, updated with `git pull` then `pi-cache/redeploy.sh`),
  and the **pi5 AIS bridge** checkout:
    1. Run once on that machine, as its login user. Copy both lines exactly: git does not understand `~` in this
       setting, and it cannot create the folder itself.
       `mkdir -p -m 700 ~/.config/thalassa`
       `git -C ~/thalassa-marine-weather config credential.helper "store --file=$HOME/.config/thalassa/git-credentials"`
    2. Then `git pull`. When asked, the username is `x-access-token` and the password is the token. Git keeps it in that
       file, readable only by that user.
    3. That user is the same one the Pi service runs as. It can already read the code in the checkout, so the read-only
       token adds little exposure.

Nothing on a Pi fetches from GitHub while it runs. Until it has a token, a Pi keeps working; it just cannot update.

## What CI costs once private

Private repositories on GitHub Free get 2,000 Actions minutes a month. Their Linux runners have 2 cores instead of 4,
so every job takes roughly twice as long. After the free minutes, Linux costs about US$0.006 a minute.

| Workflow                       | When                                                                                       | Estimate a month            |
| ------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------- |
| CI (quick checks)              | every push to master, except documentation-only                                            | ~150 runs × ~11 min ≈ 1,650 |
| Full checks: unit tests        | nightly, only if master changed that day                                                   | ~20 × ~35 min ≈ 700         |
| Full checks: E2E and browser   | Sunday night (skipped after a quiet week), and **Run workflow** before a TestFlight upload | ~4 × ~300 min ≈ 1,200       |
| Packages                       | when `pi-cache/`, `workers/ais-ingest/` or `cloudflare-worker/` change; weekly             | ~50                         |
| Hosted Deploy Smoke Test       | after each Vercel deployment of master                                                     | ~350                        |
| LINZ notices                   | every 6 hours                                                                              | ~150–250                    |
| **Total**                      |                                                                                            | **~4,100–4,200 ≈ US$12–15** |
| iOS TestFlight (Mac, separate) | when you run it                                                                            | ~US$0.60–1 a build          |

These are estimates scaled from the public repository's run times. Check **Settings → Billing** after the first week.
The two biggest levers:

- run the Sunday browser suites every second week;
- run the nightly unit tests three nights a week.

GitHub Free private repositories also lose:

- branch protection and required checks (`.github/BRANCH_PROTECTION.md`);
- CodeQL code scanning;
- GitHub's secret scanning and push protection. The repository's own client-secret scan in every build still runs.
