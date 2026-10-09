# Shore Watch reliability rollout

## Rollout checkpoint — 23 September 2026

- App changes passed targeted tests, TypeScript and ESLint. Production web
  build, Capacitor sync and artifact secret checks passed. Not installed on
  the phone or uploaded to TestFlight in this task.
- Database migration applied and `anchor-relay` / `send-anchor-alarm` deployed.
  Existing Pi reports remain compatible (omitted `action` and GPS timestamp
  inside `vessel`); fresh cloud heartbeats were verified after deployment.
- The existing `retry-pending-anchor-alarm` job was already active and was not
  altered. The new `shore-watch-health` job (26) is enabled once per minute.
  Both jobs have successful production runs. Unrelated holiday-paused jobs
  were not resumed.
- Pi changes passed all 261 tests and compiled. Only the two changed modules
  and the new assignment store were staged, alongside matching source/maps.
  These three runtime modules were installed and only `thalassa-cache` restarted
  at 17:58:51 AEST. The watch resumed in under two seconds. At 68 seconds,
  health/telemetry/recording were verified; environment and all identity files
  were unchanged, and Signal K was not restarted.
- The user confirmed the approximately 20.7 km alarm was an obsolete mark.
  Before installation a newly created, valid, holding watch was detected.
  Deployment preserved that new assignment and its exact hard expiry, not the
  obsolete mark. No watch was deleted or newly armed by the deployment.
- Existing alarm events show failed APNs delivery. The sender now records
  sanitized Apple rejection codes and transport/signing failures, without
  tokens or credentials. The **HTTP 403 InvalidProviderToken** cause was a
  configured Team ID that did not match Apple Developer. The verified Team ID
  was installed; key ID and bundle ID matched. Credential-aware 45-minute JWT
  caching and ID validation were deployed.
- The owner authorised one clearly labelled test notification. Production
  rejected the registered phone with **400 BadDeviceToken**. The user confirmed
  this is an older Xcode Debug install (development APNs). A sandbox attempt
  with the existing production-only key returned **403 BadEnvironmentKeyInToken**.
  Neither initial attempt delivered a test notification. The global production
  endpoint was not switched, preserving TestFlight delivery.
- The sender now supports dedicated `APNS_SANDBOX_KEY_ID`,
  `APNS_SANDBOX_KEY_P8`, and optional `APNS_SANDBOX_TEAM_ID`. For old Xcode
  registrations without environment metadata, only a production rejection
  `400 BadDeviceToken` permits one sandbox attempt. Accepted pushes, auth
  failures, timeouts, throttling and server failures never trigger fallback.
  This sender update is deployed; 30 focused local tests passed after review.
- The first development-only key `69A32QFG65` could not be located after its
  in-app-browser download. It remains unused and was not revoked.
- The owner created replacement sandbox key `9952KS2MT8` in Chrome. Its
  downloaded PKCS#8 P-256 file was found, restricted to local mode `0600`, and
  installed in the three dedicated sandbox secrets. Server secret digests were
  verified without displaying key material. The alarm sender was redeployed.
- One authorised, ordinary **Shore Watch test** push to the owner's exact
  registered shore phone returned **APNs HTTP 200**. It used the sandbox key,
  a 60-second delivery window, default sound and `shore_watch_test` type—no
  alarm event, critical sound, coordinates, or alarm-router activation. The
  temporary admin-only test function was removed after the request. Device
  appearance/sound and locked/closed-app alarm acceptance still need confirmation.
- Final cloud check: active lease, fresh heartbeat and GPS, no drag reported.
- After the owner installed the updated Xcode app and confirmed the phone was
  locked, a second expressly requested ordinary test push returned APNs HTTP 200. The temporary test function was removed again. The owner confirmed
  receipt on the locked phone. This verifies appearance/delivery, not yet the
  new siren or a complete end-to-end anchor-alarm acceptance test.
- No deliberate alarm, simulated movement, GPS interruption or internet
  interruption was triggered. No Critical Alerts entitlement was added.

Connection: the verified boat is `shanes@100.86.90.84` (`calypso`). The old
`skipper@calypso.local` alias showed a host-key mismatch and was not changed
or bypassed. Limited service restart is available through existing sudo rules.

Pi staging:
`/home/shanes/thalassa-shore-stage.AHDPto/`; reserved software-backup directory:
`/home/shanes/thalassa-shore-backup.WjnPDz/`. The installer verified exact
old source hashes, preserved software originals, and checked the resumed watch
before accepting the restart. Rollout evidence was generated under
`/tmp/thalassa-shore-rollout.2yOYRd/` (temporary; the Pi backup is authoritative).

The in-app Shore Watch status indicator is not a Live Activity/Dynamic Island.

## Repeat reminders and connection indicator — 24 September 2026

The owner confirmed the locked-phone **SIREN TEST** sounded only two rings. It
was a single notification, not an ongoing anchor incident. Do not infer that a
phone will play every second of the bundled file, or describe repeat pushes as
continuous background audio.

The updated app moves routine Shore Watch status into the top information
panel. Its FAB pulses blue only with fresh vessel position data, amber while
waiting/stale, and red for lost contact/GPS or drag. Notification registration
is reported separately; blue does not promise locked-phone delivery. Real
unmuted alarms still take over the screen, and muted alarms retain a visible
check-vessel warning. Reduced-motion settings are respected.

Reminder rollout:

- `20260924090000_shore_watch_alarm_reminders.sql` adds stable incident identity
  and per-phone delivery/acknowledgement state. Existing registrations default
  to `supports_reminders = false`; only a new app registration opts in.
- Original sends, retries and reminders share an atomic per-phone claim. An
  unresolved legacy ten-minute drag event keeps the same incident, so it cannot
  bypass that phone's acknowledgement. Recovery starts a new incident next time.
- The watchdog calls `queue_anchor_alarm_reminders()` after the health sweep.
  With a minute watchdog and a minimum
  60-second gap after delivery, expect roughly one-to-two-minute bursts, not an
  exact cadence. APNs/phone settings can delay, drop or silence them.
- Recheck the live Pi condition, relay, unexpired lease/session, membership and
  device claim before every send. Expiry remains a one-shot notification.
- “Silence this phone” stops its in-app audio and separately acknowledges only
  its matching server incidents existing at the button press. It never stops
  the vessel or other phones. Failed/offline acknowledgement remains visible
  with a retry action in the information panel; retries retain the original
  cutoff and cannot silence a newer incident.
- Do not activate reminder scheduling for old installations or alter any
  unrelated holiday-paused jobs. Do not trigger a real alarm to test delivery.

The ordinary notification limitations above still apply. Critical Alerts have
not been approved or enabled; this change cannot guarantee an uninterrupted
siren while the app is locked or closed.

Deployment checkpoint: the specific reminder migration was applied atomically
with a five-second DDL lock timeout and recorded in migration history. The
sender is deployed as version 25, retaining its service-role request check and
the existing gateway setting. An initial Supabase deployment returned a server
500; a single retry succeeded. The existing `shore-watch-health` job (26) was
updated, with its name/old command verified first, to run:

```sql
SELECT public.check_pi_anchor_watch_health();
SELECT public.queue_anchor_alarm_reminders();
```

No other job was changed. All three existing device registrations remained
opted out; zero reminder delivery rows existed at deployment. The existing
boat watch identity and hard expiry matched before/after, with fresh GPS and
no drag. The first updated watchdog run succeeded at 07:48 AEST, and the deployed
sender rejected an unauthenticated POST with HTTP 401 without sending a push.
No Pi restart, new phone installation, deliberate alarm or push test
was performed. The downloaded previous sender is retained in
`/tmp/thalassa-shore-reminders-rollout.ijMEbc` for rollback; leave additive schema
in place and restore only job 26's prior health-only command if needed.

Verification: 292 targeted app/backend/native-contract tests, 36 isolated
PostgreSQL assertions, TypeScript, scoped ESLint and Deno checking passed.
Production web build, Capacitor sync and client-artifact secret checks passed.
The new build is ready to install from Xcode; physical locked-phone repeated
delivery, acknowledgement and recovery remain acceptance checks with the
owner present. Phone time significantly ahead of server time fails server
acknowledgement conservatively; the UI reports that failure and does not claim
notifications have stopped. APNs already accepted in the final acknowledgement
or recovery race cannot be recalled.

## Distinctive notification siren — 23 September 2026

The updated iOS app bundles `thalassa-anchor-alarm.wav`: 24 seconds of repeating
880/1320 Hz two-tone sound, mono 16-bit linear PCM. It is an ordinary custom
notification sound, below Apple's 30-second limit, not a Critical Alert or an
unlimited background audio loop. The Xcode target must copy it to the app bundle
root; Capacitor web sync alone does not install this native asset on a phone.

Remote `drag`, `gps_lost` and `contact_lost` notifications request this sound.
`session_expiring` reminders retain the default system sound and time-sensitive
interruption level, even if Critical Alerts are approved later. The existing
foreground continuous siren and native local fallback scheduling are separate;
this change does not add rapid server-side repeating pushes or change event
throttling, expiry, recovery, authentication or retry behaviour.

Older app installs without the asset use iOS's default sound. Rebuild/install
from Xcode, then perform a clearly labelled, owner-approved locked-phone siren
test. That test must use `shore_watch_test`, not create an anchor alarm event,
and must leave the boat's current watch untouched.

`APNS_CRITICAL_ALERTS_ENABLED` remains off. Apple approval, updated signed
entitlements and explicit device permission are all required before a Critical
Alert rollout. See [the owner-approval draft](APPLE_CRITICAL_ALERTS_REQUEST.md).
Silent mode, Focus, notification settings and volume still affect ordinary
alerts. Do not rely on this as the only anchor safety measure.

Verification: targeted backend, app and native-contract tests passed, along with
TypeScript/web production build, Capacitor sync, artifact secret scan, Deno
checking and an unsigned generic iOS Debug build. The compiled app contains the
exact sound resource (verified by SHA-256 and `afinfo`). `send-anchor-alarm` was
deployed with the updated sound policy; the Critical flag is still not configured.
No new push was sent, no phone installation performed, and no live watch/Pi was
changed. Apple request submission is waiting for the owner's approval.

Subsequent device check: the owner reported installing the new app and locking
the phone. One authorised **Shore Watch SIREN TEST** notification requested the
bundled sound and time-sensitive interruption level, retaining the harmless
`shore_watch_test` type. The exact registered shore iPhone was targeted once via
sandbox APNs, which returned HTTP 200. The temporary service-role-only test
function was deleted immediately afterwards. No alarm event/watch mutation or
automatic resend occurred. Awaiting the owner's confirmation of audible siren
and duration; APNs acceptance alone does not establish either.

## Deploy in order

1. Apply `20260923170000_shore_watch_reliability.sql` to the intended Supabase project.
2. Deploy `anchor-relay` and `send-anchor-alarm` together, with the existing scoped
   gateway/authentication settings and APNs secrets unchanged.
3. Update the Pi broadcaster and app. Restart the Pi only when live monitoring
   and recording can safely be interrupted.
4. Explicitly activate the `shore-watch-health` one-minute job documented in the
   migration. Check `retry-pending-anchor-alarm` is intentionally enabled. Do not
   resume unrelated holiday-paused jobs. Without these jobs, outage detection
   and failed-delivery retries do not run on the server.

For rollback, redeploy the two original downloaded functions with their original
gateway settings (`anchor-relay` JWT on; `send-anchor-alarm` JWT off with its own
service-role check). Leave additive schema columns in place. The prior claim/retry
function definitions are in `db-functions-before.json`. Disable only the new
health job if it was enabled; never change unrelated scheduled jobs. Do not
discard or recreate a live watch to perform a software rollback.

## Contract and limits

- A valid authenticated heartbeat renews an existing Pi relay lease for up to
  six hours, capped by the owner's existing 24-hour watch session. It cannot
  create a watch, revive an expired lease, or extend the hard session expiry.
  _(Superseded once 20261010130000 is pushed: see "A phone-kept watch, and a
  watch that runs for a week" below.)_
- `expires_at` is the lease expiry; `session_expires_at` is the hard session expiry.
  At 15 minutes before hard expiry, the watchdog queues a warning. The skipper
  must create a new watch before the existing session expires. _(Superseded by
  the same migration: the warning moves to 12 hours before the 7-day lease cap.)_
- `stop` uses the Pi credential, relay ID and exact session code. It revokes only
  that binding and resolves its pending events. A delayed old stop cannot delete
  the new watch's binding.
- Fresh GPS is at most 35 seconds old. GPS-unavailable heartbeats carry no stale
  vessel coordinate. They remain heartbeats, not proof the boat is safe.
- A one-minute server sweep queues contact loss after 60 seconds without a
  heartbeat: typically 60–120 seconds before notification delivery time.
- The watchdog covers Pi-backed watches. A phone/tablet aboard still needs its
  own supported background monitoring; a Live Activity alone does not provide it.
  _(Once 20261010130000 is pushed, a phone-kept watch has its own server
  watchdog too: see below.)_
- Push payloads include `notification_type: anchor_alarm`, `session_code`,
  `alarm_kind`, and `observed_at` (ISO time). Kinds are `drag`, `gps_lost`,
  `contact_lost`, and `session_expiring`. Loss of observation is never labelled
  as a confirmed drag.
- Missing tokens are retryable, not marked delivered. Partial delivery remembers
  successful devices and retries failed devices. Retries are bounded to one hour
  and recheck the current Pi condition before sending. Phone-origin events with
  no server heartbeat are not sent after two minutes. Recovery/stop resolves
  pending events. APNs can queue accepted alerts for at most another 60 seconds.
- APNs acceptance is not proof the phone sounded. Notification settings, Focus,
  network, device power and Apple delivery all matter. Critical sounds require
  Apple entitlement approval and the user's permission.

## Device acceptance tests before relying on this

Test a non-emergency alarm with the owner present: leave the page, change tabs,
lock the shore phone, put the app in the background, and terminate it. Verify
the sound/notification settings for each case. Separately disconnect the Pi's
internet, interrupt its GPS, restore each, and stop/restart a watch. Verify only
the correct session/device receives alarms, GPS/contact recovery clears the
warning, and a stopped watch cannot restart itself. Test expiry and APNs failures
with shortened test-only fixtures, never by changing production limits blindly.

## A phone-kept watch, and a watch that runs for a week (build 126, 126-03b)

Written 2026-10-10 in `supabase/migrations/20261010130000_anchor_watch_keeper_heartbeat.sql`
and `send-anchor-alarm`. **Not live until Shane's yeses:** the DB push, then the
`send-anchor-alarm` deploy straight after. `anchor-relay` and the Pi need no change.
Rehearsed on live inside a rolled-back transaction (the file applied twice,
every behaviour check passed, nothing persisted).

### The rules

- **The boat's phone checks in.** While it keeps a shared watch (vessel role,
  watching or alarming), it calls `record_anchor_watch_heartbeat` about once a
  minute, from every fix, BgGeo's heartbeat and a 60 s timer. A blocked (paused)
  watch sends nothing. Weighing anchor or handing the watch to the Pi sends
  `ended` at once; a failed `ended` is retried on the next activity.
- **Quiet means 5 minutes.** `check_anchor_phone_watch_health` pages every Shore
  Watch phone once per outage, as `contact_lost` with `watchkeeper = 'phone'`
  ("The phone keeping the anchor watch has stopped checking in…"). The next
  check-in resolves it, and a later outage pages again. No repeat reminders for
  a phone outage yet (127). It never pages about an ended watch, a watch handed
  to the Pi (the owner is then a shore member), an expired session, or an owner
  whose account is being deleted.
- **No new alarm kind.** Every shipped app reads an unknown `alarm_kind` as a
  drag, so the phone-quiet alarm is the existing `contact_lost` kind plus the
  new `watchkeeper` column. Clients may mark their own rows `phone`, never `pi`.
- **The phone's own drag push** carries `watchkeeper = 'phone'` and is judged on
  time alone (120 s), never against a Pi binding. A silent binding left by a
  refused hand-off used to resolve it unsent.
- **A watch lives while its keeper checks in.** A phone check-in or a Pi
  heartbeat rolls the session's `expires_at` to now + 23 hours, never backwards,
  never reviving an expired session. 23, not 24: an installed Pi refuses a
  session ending more than 24 h after its own clock. A dead watch ends 23 h
  after it last heard from its keeper.
- **The Pi's lease cap is 7 days** after the skipper's phone last authorised it
  (was 48 hours). The phone re-authorises hourly and whenever Thalassa comes to
  the front, so a Pi watch runs while that phone opens Thalassa at least once a
  week. "Shore Watch ends soon" goes out once, 12 hours before the cap; the
  phone that handed the Pi the watch can renew it with one tap, and crew are
  told to ask the skipper. Any re-authorise clears it: the Pi's next heartbeat
  resolves the warning's event, and a crew phone that is hearing the boat asks
  the server every 5 minutes, so its "ends soon" goes away once renewed. It
  also lapses on its own after 12 hours, never holds off the phone's own
  contact-lost alarm, and is not sounded a second time when contact returns.
  Renew counts as done when the cloud authorisation went through (that is the
  renewal), even if the phone could not reach the Pi to re-send it the watch.
- **The shore view says the phone is being watched** ("Her phone checks in
  every minute. If it goes quiet you'll be told, even with this phone locked.")
  only while the server has a check-in under 3 minutes old AND this device's
  notifications are verified (a device that cannot take the page locked is
  never promised it).
- **The code and the membership are bounded, not the watch.** The 24-hour
  session cap used to be all that bounded the session code (anyone signed in
  who holds it may join) and membership (live position, the channel, alarm
  events). Now a code admits newcomers only in a watch's first 24 hours, as
  long as before; the owner and existing members may always rejoin. Leave on
  a crew device deletes that device's token and then gives up the account's
  membership, unless another of its devices is still registered for the watch.
  The owner's own membership is never removed.
- **A refused check-in is retried.** Only "the server has no heartbeat yet"
  (before the push) stops the phone asking for that watch. A refusal (42501)
  is retried each minute: a lapsed sign-in sends the call as anon and is
  refused too, and a passing auth fault must not switch the watchdog off.

### The two minute jobs

| Job                                      | Command                                                                                       | Watches                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `shore-watch-health` (job 26, unchanged) | `SELECT public.check_pi_anchor_watch_health(); SELECT public.queue_anchor_alarm_reminders();` | Pi-kept watches: contact lost after 60 s, ends soon 12 h before the 7-day cap, repeat reminders |
| `anchor-phone-watch-health` (new)        | `SELECT public.check_anchor_phone_watch_health()`                                             | Phone-kept watches: quiet after 5 minutes                                                       |

They are separate on purpose: one failing statement in a job skips the job's
other statements. Each watch in both functions now runs in its own exception
block; a failure is stamped on the session (`last_error_at`,
`last_error_sqlstate`, the code only) and every other watch still pages.

### The OFF switch

The phone watchdog only (the Pi job is untouched):

    SELECT cron.unschedule('anchor-phone-watch-health');

To pause it, keeping the job:

    SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'anchor-phone-watch-health'), active := false);

### Device checks (Shane's lane, at the marina)

One overnight phone-kept watch with a locked shore device (no false page), then
one deliberate airplane-mode test on the boat's phone: a page within 5 to 6
minutes.

**The shore device must be signed in to a different account from the boat's
phone.** Membership is per account: a shore device on the skipper's own
account turns the skipper's membership into 'shore', after which the boat
phone's check-ins are refused (logged "refused … a shore device on the same
account?") and the watchdog skips the watch, so the airplane-mode test would
page nobody. The boat phone's own drag inserts were already refused in that
setup. A crew account on the iPad is the real case anyway.
