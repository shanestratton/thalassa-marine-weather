# Making the app repository private

Owner decision, 2026-10-10: make `thalassa-marine-weather` private so nobody can copy the code. The ocean data the app
shows moves to a separate **public** repository, `shanestratton/thalassa-ocean-data`, because the app's server downloads
it from GitHub without logging in, and a private repository would answer "not found".

**The order matters.** If the repository goes private before the live site reads ocean data from the new repository,
every currents, sea-temperature, chlorophyll and protected-area layer stops at once, on the web and on phones.

## Already done

- `thalassa-ocean-data` holds the seven ocean-data publishers with their tests, its own checks and a keepalive.
  GitHub switches schedules off after 60 quiet days in a public repository; the keepalive runs on the 1st and 15th.
- This repository:
    - reads ocean data from there (`MARINE_RELEASE_REPOSITORY`);
    - no longer contains the publishers;
    - runs a slimmer CI (below);
    - no longer has CodeQL or the duplicate Lighthouse workflow;
    - downloads Pi code with a token.

## Your steps, in this order

Claude can't reach the live site from its sandbox, so the checks below are yours. Paste the output back to Claude if
anything looks wrong.

1. **Turn on the ocean-data publishers.**
    - In `thalassa-ocean-data`, add the `COPERNICUS_MARINE_USERNAME` and `COPERNICUS_MARINE_PASSWORD` secrets
      (**Settings → Secrets and variables → Actions**). If you reset the password to do this, update the same secret in
      this repository straight away, or the live layers go stale before the switch.
    - Under **Actions**, run each of the seven pipelines once (**Run workflow**).
    - **Check:** the repository's **Releases** page lists seven `…-latest` releases, each with `manifest-v2-a.json` and
      `manifest-v2-b.json`.
    - Ask Claude to compare the new manifests with the old ones (source dates, protected-area count) before step 2. A
      first publish has nothing of its own to compare against.
2. **Switch the app over.** Merge the go-private pull request (or ask Claude to). Vercel deploys it in a few minutes.
    - **Check the deploy:** Vercel → the project → **Deployments**: the newest **Production** deployment is _Ready_ and
      shows the merge commit. (A failed deploy leaves the old code running, and it still reads the old repository.)
    - **Check the layer:** run
      `curl -sS -D - -o /dev/null https://www.thalassawx.app/api/currents/manifest-v2.json | grep -i -E '^(HTTP|x-thalassa)'`.
      It must show `HTTP/2 200` and `x-thalassa-valid-manifest-slots: 2`. Repeat with `sst`, `chl` and `mpa` in place of
      `currents`.
    - **Check where it came from:** run
      `curl -sS https://www.thalassawx.app/api/currents/manifest-v2.json | grep -o '"commit":"[0-9a-f]*"'`, then open
      `https://github.com/shanestratton/thalassa-ocean-data/commit/<that commit>`. It must open a page. A 404 means the
      site is still serving the old repository.
    - **Check:** the **Hosted Deploy Smoke Test** for the merge commit is green.
    - **If anything is red at this step:** revert the merge (Claude can). The repository is still public, so the old
      publishers and the old address come back together.
3. **Vercel's smoke-test secret.** Private repositories on GitHub Free ignore "environment" secrets. If
   `VERCEL_AUTOMATION_BYPASS_SECRET` is listed under **Settings → Environments → Preview**, also add it under **Settings
   → Secrets and variables → Actions → Repository secrets**.
4. **Set an Actions budget:** **Settings → Billing and licensing → Budgets and alerts**, Actions, about US$40 a month
   with an email alert at 75%. See **What it costs** below.
    - **Old artifacts:** this repository has about 5.4 GB of saved test reports, expiring by 10 November. A private
      repository on Free includes 500 MB of storage. With a budget set, the extra costs about US$1 and shrinks as they
      expire. Without one, new uploads fail and CI turns red.
5. **Make it private:** **Settings → General → Danger Zone → Change repository visibility → Make private.**
6. **Afterwards:**
    - Run the step 2 layer and source checks again.
    - Push something small and confirm Vercel still deploys.
    - Start one Claude session to confirm it can still open the repository.
    - Give each machine that pulls the code its token (next section). While the repository was public, `git pull` never
      asked for one, so this is the first time it can be tested.
    - **If a layer breaks now:** do **not** revert. Make the repository **public again** first: that restores whatever
      the site was reading. Then ask Claude to investigate.
7. **Optional, free:** **Settings → Code security → Dependabot security updates → Enable.** It is off today. It raises
   a pull request as soon as a dependency has a known vulnerability, separately from the monthly version updates.

**Rewriting history:** wait until step 2 has passed. Deleting or moving the old release tags in this repository before
then would break the layers immediately. After step 2, nothing reads those old releases.

**What going private cannot undo:** copies already made stay out there, including forks and clones. Any key that was
ever committed must be changed at its provider, not just hidden. **Insights → Forks** shows the existing forks.

## Pis and other machines that pull the code

**Only your own machines get a token.** A token reads the whole private repository, which is exactly what going private
protects, so never put one on a Pi you don't control. If invited testers ever need the Pi cache, ship it to them as a
packaged release instead.

Each machine gets its own **fine-grained token**, so a lost one can be revoked without touching the others:

1. GitHub → your picture → **Settings → Developer settings → Fine-grained tokens → Generate new token**.
2. Fill it in:
    - **Repository access:** _Only select repositories_ → `thalassa-marine-weather`.
    - **Permissions:** _Contents: Read-only_. Nothing else.
    - **Expiration:** up to a year. Note the date: when it expires, the machine stops updating, though it keeps running.

Using it:

- **A Pi installed with `install.sh`:**
    - **First update after this change.** That Pi still has the old installer, which knows nothing about tokens, so
      copy the new one over from your Mac (from this repository's folder):
      `scp pi-cache/install.sh <user>@<pi>:/tmp/ && ssh -t <user>@<pi> sudo bash /tmp/install.sh`
    - It asks for the token once and keeps it in a root-only file, `/etc/thalassa/github-token`.
    - Every later update is `sudo thalassa-pi-cache-install`, a root-owned copy of the installer.
    - `pi-cache/README.md` has the rest.
- **The boat Pi's full checkout** (`~/thalassa-marine-weather`, updated with `git pull` then `pi-cache/redeploy.sh`),
  and the **pi5 AIS bridge** checkout:
    1. Run once on that machine, as its login user. Copy both lines exactly: git does not understand `~` in this
       setting, and it cannot create the folder itself.
       `mkdir -p -m 700 ~/.config/thalassa`
       `git -C ~/thalassa-marine-weather config credential.helper "store --file=$HOME/.config/thalassa/git-credentials"`
    2. Then `git pull`. When asked, the username is `x-access-token` and the password is the token. Git keeps it in that
       file, readable only by that user.

**What protects a token on a Pi, honestly:**

- The installer's file is root-only, so the cache service can't read it.
- On Raspberry Pi OS the login user normally has passwordless sudo, so anything running as that user could get root,
  and with it the file. The checkout's token sits in that user's own file.
- What limits the damage is the token itself: it is read-only, covers one repository, expires, and is revoked in one
  click.

Nothing on a Pi fetches from GitHub while it runs. Until it has a token, a Pi keeps working; it just cannot update.

## What it costs once private

Private repositories on GitHub Free get 2,000 Actions minutes a month. Their Linux runners have 2 cores instead of 4,
so every job takes roughly twice as long. After the free minutes, Linux costs about US$0.006 a minute and a Mac about
US$0.062.

| Workflow                      | When                                                                           | Minutes a month             |
| ----------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| CI (quick checks)             | every push and pull request to master, except documentation-only               | ~150 runs × ~11 min ≈ 1,650 |
| Full checks: unit tests       | nightly, only if master changed that day                                       | ~20 × ~35 min ≈ 700         |
| Full checks: everything       | Sunday night (skipped after a quiet week)                                      | ~4 × ~300 min ≈ 1,200       |
| Packages                      | when `pi-cache/`, `workers/ais-ingest/` or `cloudflare-worker/` change; weekly | ~50                         |
| Hosted Deploy Smoke Test      | after each Vercel deployment of master                                         | ~350                        |
| LINZ notices                  | every 6 hours                                                                  | ~150–250                    |
| **Base**                      |                                                                                | **~4,100 ≈ US$12–15**       |
| Full checks, **Run workflow** | each time you run it                                                           | ~300 min ≈ US$1.80 each     |
| iOS TestFlight (Mac)          | each build                                                                     | ~US$0.60–1 each             |

**Example month:** 8 TestFlight uploads, each after its own Full checks run, comes to about US$15 + 8 × US$1.80 + 8 ×
US$1, roughly **US$35**. Running Full checks once a week rather than before every upload saves most of the middle term.
Before an upload, it is worth running when the screens or routing changed since the last green run.

These are estimates scaled from the public repository's run times. Check **Settings → Billing** after the first week.
Other levers:

- run the Sunday browser suites every second week;
- run the nightly unit tests three nights a week.

GitHub Free private repositories also lose:

- branch protection and required checks (`.github/BRANCH_PROTECTION.md`);
- CodeQL code scanning;
- GitHub's secret scanning and push protection. The repository's own client-secret scan in every build still runs.
