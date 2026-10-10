# iPhone TestFlight builds on GitHub

`.github/workflows/ios-testflight.yml` builds the iPhone app on a GitHub-hosted Mac and, when you tick
**upload**, sends it to TestFlight. Your Mac is not needed for a build. It follows the same path as builds
102 to 117 (`docs/BUILD_114_TESTFLIGHT.md`):

- `VITE_APP_BUILD=N npm run ship:beta` under Node 24, with Xcode 26.6.
- An archive signed **Apple Development** with automatic signing.
- An export re-signed with the **cloud-managed Apple Distribution** certificate.
- The same checks the release records make on the signed app.
- One upload.

| How it starts                                                                                  | What it does                                                                                              | Apple secrets                  |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| A pull request that changes the workflow, `ios/App/Podfile*`, `ios/App/Gemfile*` or `patches/` | `ship:beta`, then an **unsigned** compile. This proves the web build, CocoaPods and the Swift all build.  | Not read by this workflow      |
| **Run workflow** (only you: the workflow refuses anyone else)                                  | `ship:beta`, archive, export and **verify** the signed app. With **upload** ticked, it then uploads once. | Read only in the signing steps |

The pull-request compile is deliberately narrow, because Mac minutes are expensive on a private repo (see
**Cost**). Swift edits under `ios/App/App` and native plugin upgrades (Dependabot changes only
`package-lock.json`) are first compiled by your next build, here or on your Mac.

Nothing is kept as a download: no app, no archive, no key. The run's **Summary** records the commit, Xcode,
the build number, the main asset hash and the hash of the IPA that was verified. Xcode re-signs the upload
from the same archive, so the uploaded file's own hash differs.

## One-time setup (about 20 minutes)

The **Run workflow** button only appears once this workflow is on `master`.

### 1. An App Store Connect API key

1. Go to [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access** → **Integrations** →
   **App Store Connect API** → **Team Keys** → **+**.
2. Name it `GitHub TestFlight` and give it **Admin** access. Cloud-managed distribution signing needs it.
3. **Download** the `.p8` file. Apple lets you download it **once**.
4. Note the **Key ID** (next to the key) and the **Issuer ID** (above the list).

### 2. Your Apple Development certificate, as a file

On your Mac:

1. Open **Keychain Access** → **login** → **My Certificates** (not **Certificates**: only **My
   Certificates** includes the private key).
2. Find **Apple Development: Shane Stratton (…)**. If there are several, pick the one with the latest expiry
   date (double-click to see it) that has a key under its ▸ triangle.
3. Right-click it → **Export…** → save it to the **Desktop** as `dev.p12` and choose a password.
4. In Terminal, copy it as text: `base64 -i ~/Desktop/dev.p12 | pbcopy`.
5. Delete `dev.p12` once step 3 below is done.

This is the certificate your Mac already signs archives with. Using it stops every cloud build from
creating a new one. When it expires, or Xcode replaces it, repeat this step and update the two
`IOS_DEV_CERT_…` secrets.

### 3. Five GitHub secrets

GitHub → this repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name                      | Value                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `ASC_KEY_ID`              | the Key ID from step 1                                                                              |
| `ASC_ISSUER_ID`           | the Issuer ID from step 1                                                                           |
| `ASC_KEY_P8`              | the whole text of the `.p8` file, from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----` |
| `IOS_DEV_CERT_P12_BASE64` | what step 2 copied                                                                                  |
| `IOS_DEV_CERT_PASSWORD`   | the password from step 2                                                                            |

Never name one of these `VITE_…`: every `VITE_` value is built into the app itself.

The app's public settings (Supabase, Mapbox, Sentry, Google sign-in, version) are the repository
**variables** that `ci.yml` already uses; CI's "Public beta release configuration" check passes with them,
so they are set. If you change the version in `package.json`, change the `VITE_APP_VERSION` variable to
match **before** building. The workflow also refuses to build when `VITE_GOOGLE_OAUTH_CLIENT_ID` does not
match the Google URL scheme in `Info.plist`.

## Who can reach the keys, plainly

- The workflow only signs for you, and only in its signing steps. That protects against mistakes, not
  against someone with write access: **anyone who can push to this repo can read its secrets** by pushing
  a workflow of their own. Today that is you and the Claude sessions you run. Keep it that way. (GitHub's
  "environments", which could fence the keys off further, are not available for private repos on the Free
  plan.)
- The build runs npm, CocoaPods and Xcode, which run code from the app's dependencies on the same machine
  as the keys, exactly as they do on your Mac. The certificate is imported so it can sign but cannot be
  copied out, and everything is deleted when the run ends, but a malicious dependency could still _use_
  the App Store Connect key during a run.
- **If you ever suspect a key has leaked:** App Store Connect → **Users and Access** → **Integrations** →
  **App Store Connect API** → **Revoke** the `GitHub TestFlight` key, then make a new one (step 1). For the
  certificate: [developer.apple.com](https://developer.apple.com/account/resources/certificates/list) →
  **Certificates** → revoke it; Xcode makes a new one the next time you build on your Mac.

## Making a TestFlight build

1. **Bump the build number** on the branch you will build: `CURRENT_PROJECT_VERSION` in all four
   configurations of `ios/App/App.xcodeproj/project.pbxproj`. Use the last uploaded number + 1, and
   **never** reuse a number that has been uploaded. **Commit and push** it.
2. GitHub → **Actions** → **iOS TestFlight** → **Run workflow**:
    - **Use workflow from**: leave it on `master`.
    - **ref**: the branch to build, for example `b127`. To build an exact commit instead, paste its full
      commit ID.
    - **build_number**: the number you committed. The run stops if they differ.
    - **upload**: the **very first time only**, leave it unticked. That dry run proves your secrets and
      signing work without spending a build number. After that, tick it: every run checks the signed app
      before it uploads, so another dry run only costs time and money.
3. In App Store Connect:
    - Wait for processing to finish. The **Skipper** group receives the build automatically.
    - Save the **What to Test** notes.

A run builds the branch as it is **when the run starts**, so don't push to that branch mid-run. The
Summary's **Commit** line says exactly what was built.

## Cost

A build takes roughly 25–40 minutes.

- **Public repo:** free.
- **Private repo, GitHub Free:** 2,000 included Actions minutes a month, and a Mac minute uses about ten of
  them, so one build eats 250–400. Normal CI uses most of the 2,000, so expect to pay for Mac builds: at
  GitHub's Mac rate (about US$0.062 a minute) that is **about US$2–2.50 a build**. Set a spending budget in
  **Settings → Billing** so a runaway job cannot surprise you.

## If a run fails

- **"build_number … must equal the committed CURRENT_PROJECT_VERSION"**: the message names the ref and
  commit it read. Commit **and push** the bump to that branch, or fix the ref or the number.
- **"Secret … is not set"** or **"ASC_KEY_P8 is not the text of the .p8 file"**: setup step 3.
- **"release environment version matches package.json"**: update the `VITE_APP_VERSION` variable.
- **"Xcode 26.6 is no longer on GitHub's macos-26 image"**: GitHub retired that Xcode. Ask Claude before
  changing it; a new Xcode needs a test build first.
- **Signing or provisioning errors in Archive or Export**: check the key has **Admin** access, and that the
  `.p12` holds the current **Apple Development** certificate _with its private key_ (setup step 2).
- **Upload failed, or Apple says the build is a duplicate**: first look in App Store Connect →
  **TestFlight**. If build N is listed (processing or ready), it arrived: you are done, do **not** run it
  again. Only if it is not there, bump to the next number and run again.
