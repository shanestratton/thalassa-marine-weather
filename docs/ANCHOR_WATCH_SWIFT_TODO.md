# Anchor Watch — Remaining Swift / native work

Status as of 2026-05-17 (commit chain `130ad5e6` → `f13178fa` → …).
JavaScript side of the background-reliability pass landed in this
commit chain. Two native-Swift items are still outstanding — they
need Shane on his iPhone with a Lightning cable and Xcode open to
test, so they're flagged here for a dedicated session.

## What already landed (JS side)

- `services/AnchorWatchService.ts` — schedules a `LocalNotifications`
  fallback (1 immediate + 20 reminders × 30 s = 10 min coverage) at
  `interruptionLevel: 'timeSensitive'` so the user wakes up even if
  the looping audio gets killed by iOS thermal throttling.
- Cancellation hooks in `stopAlarm()` and `acknowledgeAlarm()` so
  the reminders stop the moment the user reacts.
- Removed the JS `setInterval` haptic loop that never fired during
  app suspension anyway.
- `services/BgGeoManager.ts` — added `geofenceModeHighAccuracy: true`
  so the iOS geofence uses the precise Core Location API instead of
  the ~500 m Significant Location Changes fallback.

## What's still pending (Swift side)

### Step A — Replace `Timer.scheduledTimer` with `AVAudioPlayer` loop

**File:** `ios/App/App/AlarmAudioPlugin.swift`

Today the alarm tone is synthesised inline and re-triggered every
N seconds via `Timer.scheduledTimer(...)` on the main run loop.
Under full backgrounding, the main run loop pauses → the timer
stops → the alarm goes silent within seconds, even though
`AVAudioSession(.playback)` would happily keep playing audio
indefinitely.

**Fix:**

1. Bundle a pre-rendered alarm tone at
   `ios/App/App/Resources/anchor-alarm.caf` (CAF — Core Audio
   Format — decodes cheaper than WAV).
2. Replace the `Timer` with `AVAudioPlayer.numberOfLoops = -1`
   (infinite loop). Audio thread stays alive in background-audio
   mode.
3. Update the plugin's `playAlarmSound` to accept a sound-file
   parameter so future alarms (Guardian, MOB) can share the
   loop infrastructure.

### Step F — Audio-session interruption resilience

**File:** `ios/App/App/AlarmAudioPlugin.swift`

Add an observer for `AVAudioSession.interruptionNotification`. If
the alarm session is interrupted (incoming call, Siri, alarm clock),
auto-resume on `.ended`. Also flip `AVAudioSession.options` to
include `.mixWithOthers` so Calypso TTS / Apple Music can't kill
the alarm by claiming the session.

### Critical-alerts entitlement (optional, slow)

To upgrade from `timeSensitive` (breaks through Focus/DND) to
`critical` (also bypasses the silent switch), file an Apple
Developer Support request for the entitlement
`com.apple.developer.usernotifications.critical-alerts`. Apple
typically takes 1–4 weeks and can refuse. Plan ships fine without
it — `timeSensitive` is plenty for the main use case.

## Manual test plan (Shane's iPhone, after Swift work lands)

1. **Permissions cold start.** Delete app. Reinstall. Open. Tap "Set
   Anchor" — verify two prompts: Location ("Allow While Using") and
   Notifications ("Allow"). Walk 10 m from anchor — no alarm
   (inside radius).
2. **Background hardware geofence.** Set anchor with 30 m swing
   radius. Lock phone. Wait 30 s for full suspension. Walk 40 m+.
   Verify within 60 s: (a) lock-screen notification "Anchor
   dragging — Xm from anchor", (b) loud alarm tone through speaker,
   (c) tone loops until you unlock + acknowledge.
3. **Silent-switch defeat.** Repeat with hardware mute switch ON.
   Confirm audio still plays at full volume.
4. **Do Not Disturb defeat.** Enable Focus "Do Not Disturb" before
   locking. Repeat step 2. Notification should still break through.
5. **Long-suspension survival.** Set anchor, leave phone idle on
   charge overnight (or 2+ hrs). Walk 40 m+. Alarm fires within
   60 s → confirms iOS didn't kill the BG runtime.
6. **Acknowledge clears it.** Unlock, tap Acknowledge. Confirm
   (a) audio stops, (b) all queued reminder notifications cancelled
   (lock-screen empty after 30 s), (c) watch re-arms cleanly.

## Risk callouts

- **Battery drain.** Looping `.caf` audio in background ≈ 15–20 %/h
  on top of GPS. Auto-acknowledge after 10 min if user doesn't
  respond — bounds the worst-case drain.
- **GPS jitter false positives.** Harbour multi-path can drift the
  vessel position 30 m without movement. Existing software floor
  (`ALARM_CONFIRM_COUNT = 3` + 5-point moving average) handles this
  for the software check, but the hardware geofence triggers on a
  single sample. Consider raising the hardware-geofence minimum
  radius from 20 m → 30 m to reduce false trips.
- **App Store review.** `UIBackgroundModes: location` triggers
  4.5.4 review. Submission notes must explain: "Anchor Watch is a
  marine safety feature that the user explicitly arms; without
  continuous background location, the feature cannot function."
  Reference: ASR Guideline 4.5.4.
- **`MPVolumeView` quirks.** `setSystemVolumeToMax()` in the plugin
  has historically worked but is fragile across iOS major versions.
  Test on the latest iOS before each App Store submission.

## Files to touch (Swift session)

- `ios/App/App/AlarmAudioPlugin.swift` — Steps A + F
- `ios/App/App/Resources/anchor-alarm.caf` — new bundle resource
- `ios/App/App/Info.plist` — verify `UIBackgroundModes` includes
  `audio` exactly once (currently listed twice on line 28 per the
  plan agent — clean up the duplicate)
- `ios/App/App/App.entitlements` — only if/when Apple grants the
  critical-alerts entitlement
