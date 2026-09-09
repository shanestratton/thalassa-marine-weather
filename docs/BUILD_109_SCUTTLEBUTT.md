# Build 109 — Scuttlebutt composers and blocking

The production artifact below is the original Scuttlebutt build. Build 109 was
subsequently rebuilt, still unreleased, with the
[Sail Plan layout follow-up](BUILD_109_SAIL_PLAN.md); use that note for the latest
bundle identifiers. The Scuttlebutt verification recorded here remains historical
evidence for its unchanged runtime code.

## Scope

Build 108 remains the previously uploaded TestFlight build. These changes prepare
1.2.0 (109); this note is not evidence of an archive, Apple upload, processing, or
tester availability. Production build and iOS sync are complete; verification
results and artifact identifiers are recorded below.

- Channel and private-message composers reserve the same bottom-navigation and
  safe-area clearance. The native keyboard reduces the chat area; its input does
  not also ask the global form guard to scroll the surrounding page.
- Only message history scrolls. Jumping to recent messages, sending text, and
  sharing locations/tracks cannot use `scrollIntoView` to scroll hidden ancestors
  and lose the chat header/composer. Other pages retain their existing scrolling.
- Both Send controls, and the channel attachment/question buttons, have 44px
  minimum touch targets even where fluid root typography makes `w-11` smaller.
  Enter sends once, while unfinished IME input does not send.
- PM permission checks have explicit checking/error/retry states and preserve
  drafts. Only the sailor's own block offers Unblock. Removing one's own block
  does not imply the other sailor permits messaging.
- A caller-scoped database permission check sees both directions without exposing
  private block rows. A restrictive INSERT policy supplements existing identity,
  consent, payload and visibility policies. Explicit block/unblock is idempotent;
  compatibility cleanup supports build 108's direct, owner-scoped unblock.
- Blocking from the PM screen cancels that sailor's locally queued DMs, not other
  contacts' messages. The Crew List bridge updates server blocks, but does not
  immediately purge the local ChatService queue.
  Confirmed block/authorization rejection is not an offline delivery success.
  Already-committed messages are not recalled; the block RPC lock does not
  serialize every in-flight database send.

## Verification and delivery

- **24/24 source browser checks passed**, Chromium and WebKit, with no skips,
  failures or flaky results. Coverage includes 320px/390px phones, phone
  landscape, iPad and desktop split panes, long channel history, empty and
  populated DMs, both keyboard models, and block/error/retry controls.
- **12/12 packaged-app smoke executions passed**: three real-app journeys in
  Chromium and mobile WebKit, each repeated twice, with zero retries, skips or
  flaky results (47.43 seconds). They exercise Vessel → Scuttlebutt → channel,
  input/Send geometry above navigation and a modeled keyboard, and Back/reopen.
  Every run confirms intercepted channel/history reads and zero chat writes or
  failed mock requests. The production bundle was not rebuilt between checks.
- The previous smoke only checked non-empty body text. Its replacement checks
  actual controls and four-edge hit targets. Initial harness failures exposed
  incomplete mock CORS headers in WebKit and an assertion ahead of React's
  keyboard-layout commit; corrected transport mocks and a bounded wait for
  actual layout preserve the strict geometry assertions. No app change was
  required after source commit `7f31daa1`.
- Browser negative controls reproduced the original DM navigation overlap,
  extra keyboard-guard page padding, and WebKit's 72px scroll of the split frame.
  Chat's split frame now uses `overflow-clip`; other pages are unchanged.
- **178 focused blocking/service/hook tests passed** on frozen source. Final
  UI/keyboard/history subset: **17 passed**. TypeScript and changed-file ESLint
  passed. Full unit suite: **9,677 passed**, 3 existing expected failures and
  5 skips; 1,097 test files passed and 4 skipped, 198.11 seconds.
- Migration `20260910090000_chat_bilateral_block_enforcement.sql` was tested
  twice with rollback-only synthetic fixtures, then applied to
  `pcisdplnodrphauixcau` and recorded in migration history. SHA-256:
  `7106b188f6da270295892e60035724894de324b03de2aa1c4aa08f1c256a3a09`.
  Live verification confirms authenticated RPC access, anonymous denial, both
  compatibility triggers, and the restrictive block policy alongside the
  existing consent/payload policy. **Zero synthetic users remain.**
- A public-key-only API GET confirms PostgREST knows the status RPC and rejects
  anonymous execution (HTTP 401 / SQLSTATE `42501`, not a missing-function error).
  No real message, notification or customer block choice was created or removed.

### Production artifact

- Source commit: `7f31daa1` — `fix(chat): keep composers visible and enforce bilateral blocks for build 109`.
- `VITE_APP_BUILD=109 npm run ship:beta` completed successfully: Vite production
  build, local production-release checks, route audit, bundle budget, client-secret
  checks, iOS sync with all 19 Capacitor plugins, and **140 release contracts**.
- Main entry: `main-Ds4LyusS.js`, SHA-256
  `810524905cf7f9a0f96c9c01ee3de5c7403d7b74258f77c1225ac50263829cec`.
- Public logs entry: `logs-BAlJ4052.js`, SHA-256
  `ff4a57aaa0b482aa07989eaaafe3e37341b946157de6b5bc078a39606501339e`.
- Main stylesheet: `index-ZFrs0ZGH.css`. Both JavaScript entries have identical
  hashes in `dist` and the synced iOS public assets. All four Xcode build counters
  are 109, and the compiled Sentry release identifies `thalassa@1.2.0+109`.
- Total bundle: 13.31 MB; JavaScript: 9.84 MB against the existing 9.90 MB budget.
  The budget passes but has little JavaScript headroom.
- No archive, Apple validation/upload, or TestFlight distribution was performed
  for 109. Build 108's shipped artifacts remain untouched.

Evidence directory: `/private/tmp/thalassa-chat109.h2gOmw/`.
Server proof/verification: `/private/tmp/thalassa-chat-block.IPx38g/`.
Packaged-app report: `scuttlebutt-production-verified.json` in the evidence
directory; screenshots are in the adjacent `scuttlebutt-production-verified/`.

## Physical-device checks

Browser tests model Capacitor `KeyboardResize.None` (native keyboard events with
an unchanged visual viewport) and Safari's changing visual viewport. They are not
a substitute for checking the actual iPhone keyboard in the installed build.

1. Open Scuttlebutt → a busy channel. Tap Message, type, send, dismiss and reopen
   the keyboard. The input, Send button and chat header must stay visible.
2. Open an empty and a populated PM conversation; verify Send is above navigation
   with the keyboard closed and above the keyboard when typing.
3. Block and unblock a consenting test account. Verify both directions reject new
   messages while blocked, the wrong party cannot remove a block, and an
   unavailable permission check offers Retry without discarding typed text.
4. Repeat in phone landscape and iPad split view. The adjacent pane must not move.

## Separate read-only security assessment

The [PostGIS assessment](POSTGIS_CONTAINMENT_ASSESSMENT_2026_09_10.md) independently
verified Supabase's temporary containment. No PostGIS relocation, upgrade,
drop/reinstall, or support reply is part of this chat fix. Its thirteen spatial
function dependencies need a reviewed and rehearsed migration plan.
