# iPhone TestFlight builds on GitHub

`.github/workflows/ios-testflight.yml` builds the iPhone app on a GitHub-hosted Mac and, when you tick
**upload**, sends it to TestFlight. Your Mac is not needed for a build. It follows the same path as builds
102 to 117 (`docs/BUILD_114_TESTFLIGHT.md`):

- `VITE_APP_BUILD=N npm run ship:beta` under Node 24, with Xcode 26.6.
- An archive signed **Apple Development** with automatic signing.
- An export re-signed with the **cloud-managed Apple Distribution** certificate.
- The same checks the release records make on the signed app.
- One upload.

| How it starts                                      | What it does                                                                                              | Apple secrets                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| A pull request that touches the workflow or `ios/` | `ship:beta`, then an **unsigned** compile. This proves the web build, CocoaPods and the Swift all build.  | Not read                       |
| **Run workflow** (you only)                        | `ship:beta`, archive, export and **verify** the signed app. With **upload** ticked, it then uploads once. | Read only in the signing steps |

Nothing is kept as a download: no app, no archive, no key. The run's **Summary** records the commit, Xcode,
the build number, the main asset hash and the IPA hash.

## One-time setup (about 20 minutes)

### 1. An App Store Connect API key

1. Go to [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access** → **Integrations** →
   **App Store Connect API** → **Team Keys** → **+**.
2. Name it `GitHub TestFlight` and give it **Admin** access. Cloud-managed distribution signing needs it.
3. **Download** the `.p8` file. Apple lets you download it **once**.
4. Note the **Key ID** (next to the key) and the **Issuer ID** (above the list).

### 2. Your Apple Development certificate, as a file

On your Mac:

1. Open **Keychain Access** → **login** → **My Certificates**.
2. Right-click **Apple Development: Shane Stratton (…)** → **Export…**.
3. Save it as `dev.p12` and choose a password.
4. In Terminal, copy it as text: `base64 -i ~/Desktop/dev.p12 | pbcopy`.
5. Delete `dev.p12` once step 3 below is done.

This is the certificate your Mac already signs archives with. Using it stops every cloud build from
creating a new one.

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

The app's public settings (Supabase, Mapbox, Sentry, Google sign-in, version) are the **variables**
`ci.yml` already uses. The workflow refuses to build when `VITE_GOOGLE_OAUTH_CLIENT_ID` does not match the
Google URL scheme in `Info.plist`.

## Making a TestFlight build

1. **Bump the build number** in its own commit on the branch you will build: `CURRENT_PROJECT_VERSION` in all
   four configurations of `ios/App/App.xcodeproj/project.pbxproj`. Use the last uploaded number + 1, and
   **never** reuse a number that has been uploaded.
2. GitHub → **Actions** → **iOS TestFlight** → **Run workflow**:
    - **ref**: the branch, for example `b127`.
    - **build_number**: the number you committed. The run stops if they differ.
    - **upload**: leave it **unticked** the first time. That is a dry run: build, sign and verify, with no
      upload.
3. When the dry run is green, run it again with **upload** ticked. It uploads once.
4. In App Store Connect:
    - Wait for processing to finish. The **Skipper** group receives the build automatically.
    - Save the **What to Test** notes.

A build takes roughly 25–40 minutes. While the repo is public, GitHub's Mac runners cost nothing. On a
private repo they use your plan's Actions minutes, and Mac minutes count about ten times Linux ones. See
**Settings → Billing**.

## If a run fails

- **"build_number … must equal the committed CURRENT_PROJECT_VERSION"**: commit the bump first, or type the
  committed number.
- **"Secret … is not set"**: step 3 above.
- **Signing or provisioning errors in Archive or Export**: check the key has **Admin** access, and that the
  `.p12` holds the **Apple Development** certificate _with its private key_. Export from **My
  Certificates**, not **Certificates**.
- **Apple rejects the upload as a duplicate**: that number was already uploaded. Bump to the next one.
