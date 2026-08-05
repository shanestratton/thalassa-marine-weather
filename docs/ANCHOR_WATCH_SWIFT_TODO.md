# Anchor Watch — native audio implementation and physical verification

Status: 2026-08-05

The native looping-alarm source work is complete. Public-beta sign-off still
requires the signed physical-device matrix below. Passing simulator builds and
source tests do not prove locked-screen audibility, route selection, interruption
recovery, or background survival on a real iPhone.

## Implemented

- `AlarmAudioPlugin.swift` retains one `AVAudioPlayer` and loops a generated
  1.5-second PCM alarm indefinitely with `numberOfLoops = -1`. Alarm continuity
  no longer depends on a main-run-loop `Timer`.
- The plugin activates an `AVAudioSession` with the `.playback` category while
  alarming. `Info.plist` declares the `audio` background mode once.
- It observes audio-session interruptions and media-services resets, rebuilds
  the player, and uses bounded resume retries while the alarm remains explicitly
  requested.
- Explicit stop cancels pending resume work, stops the player, deactivates the
  session, and restores the previously active category, mode, and options.
- Every Anchor Watch arming attempt now runs the real native alarm path and
  remains disabled until the skipper explicitly confirms that the sound was
  heard clearly.
- `AnchorSafetyNotificationPlugin.swift` schedules the actual iOS notification
  content with `.timeSensitive`. Before arming it verifies notification
  authorization, Alerts, Sounds, the Time Sensitive setting, and room for the
  complete fixed set of 21 requests. Scheduling removes prior Anchor IDs first
  and succeeds only after every native add callback succeeds.
- Native iOS arming explicitly requests and reads back Always Location access.
  When-In-Use is rejected with Settings guidance, and a live NMEA feed is
  treated as supplemental rather than proof of locked-screen phone execution.
- The shared marine location profile sets
  `pausesLocationUpdatesAutomatically: false` as well as
  `disableStopDetection: true`. Explicit ref-counted tracking leases remain the
  start/stop and battery boundary.
- The app does not alter system volume through `MPVolumeView` or private APIs.
  The skipper controls system volume and validates the current output route in
  the mandatory sound check.

## Safety boundary

The looping tone is ordinary application audio, not an Apple Critical Alert.
The `.playback` category is intended to continue through the Ring/Silent switch
and is eligible to continue while the app is backgrounded, but it is not an
absolute audibility guarantee. System volume, the selected route, attached
Bluetooth or wired hardware, other audio-session owners, iOS process state, and
system policy can still affect what is heard.

The app has the Time Sensitive Notifications entitlement and a first-party
native scheduling path that sets the real iOS interruption level. The signed
profile, delivered notification, user permission, and Focus setting must still
be verified on hardware. A Time Sensitive notification is user-controllable
and must not be described as an unconditional Focus or Silent-mode bypass.

No Critical Alerts entitlement is present and the app makes no Critical Alert
guarantee. Do not add `com.apple.developer.usernotifications.critical-alerts` or
schedule a critical interruption level unless Apple grants the entitlement and
the signed profile contains it.

Ordinary audio cannot survive a force-quit or an iOS-terminated process. The
background-location and local-notification layers are separate fallbacks and
must be tested independently; neither may be represented as proof that the
continuous audio loop survives termination or reboot.

## Required signed-device verification

Record the iPhone model, iOS version, build number, signing profile, date, and
tester for every run. A blank Result cell is not a pass.

| Scenario                       | Pass criterion                                                                                                                                                                                                                         | Result  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Clean install and permissions  | Arming remains blocked until iOS reports Always Location, notification Alerts and Sounds, Time Sensitive Notifications enabled, and capacity for all 21 requests. When-In-Use or denial gives exact Settings guidance.                 | Pending |
| Mandatory sound check          | Every pointer and keyboard arming attempt plays the actual alarm and requires a fresh “I Heard It Clearly” confirmation. Cancel, failure, or no confirmation cannot arm.                                                               | Pending |
| Volume and Ring/Silent switch  | Test at low, normal, and high volume, then with Ring/Silent enabled. Record actual behaviour; no full-volume claim is acceptable.                                                                                                      | Pending |
| Output routes                  | Verify built-in speaker, Bluetooth/headphones connected, route changes during the test, and disconnect/reconnect. The UI must make an inaudible or misrouted test fail closed.                                                         | Pending |
| Locked screen/background       | With no NMEA source connected, arm a safe test radius, lock the phone, allow full suspension, trigger a boundary event, and verify the alarm loops until acknowledgement. Repeat with NMEA connected to prove it remains supplemental. | Pending |
| Phone/Siri interruption        | Interrupt an active alarm with an incoming call and Siri. After the interruption ends, looping audio resumes without re-arming; acknowledgement still stops it.                                                                        | Pending |
| In-app audio ownership         | Exercise Calypso speech and system/third-party media playback immediately before and during an alarm. They must not silently deactivate or strand active alarm playback. Thalassa's Apple Music integration remains beta-off.          | Pending |
| Media-services reset           | If reproducible with development diagnostics, verify the player is rebuilt and resumes; otherwise retain the source contract and capture interruption tests as the practical release evidence.                                         | Pending |
| Time Sensitive notification    | Inspect the delivered `UNNotification` interruption level on the signed build, then test with Focus both allowing and disallowing Time Sensitive notifications. Behaviour and user controls must match the UI copy.                    | Pending |
| Long suspension                | Repeat the locked-screen boundary test after at least two hours and, separately, overnight on charge. Record trigger latency and whether audio, haptics, and notifications each occurred.                                              | Pending |
| Acknowledge and re-arm         | Acknowledge stops audio, cancels queued alarm notifications, clears the alarm state, and requires a new sound check before the next arming.                                                                                            | Pending |
| Process termination and reboot | Record the behaviour after OS termination, user force-quit, and reboot. Do not expect continuous audio to survive. Confirm the app exposes any degraded or stopped-watch state honestly.                                               | Pending |
| Power and thermal conditions   | Exercise Low Power Mode and a warm device. Record battery and thermal observations from the test; do not extrapolate an unsupported hourly drain percentage.                                                                           | Pending |

## Release pass criteria

Native Anchor Watch can be signed off for public beta only when:

1. The matrix above has evidence from the intended minimum and current iOS
   versions on physical hardware.
2. Locked-screen looping, interruption recovery, explicit stop, and route-change
   behaviour pass without an unreported silent failure.
3. The delivered local notification is confirmed to have the interruption level
   the UI and release notes describe. If the signed build delivers it as
   ordinary, the provisioning/scheduling defect must be corrected before
   release.
4. The app never promises forced maximum volume, unconditional Focus bypass, or
   Critical Alert behaviour without the corresponding Apple capability.

## Residual risks and review notes

- Harbour multipath and GPS jitter can cause false boundary crossings. Test the
  actual radius and confirmation logic in representative anchorages.
- Background `location` and `audio` modes must be used only for the explicitly
  armed marine-safety feature and explained accurately in App Review notes
  (App Review Guideline 2.5.4).
- Programmatic manipulation of standard system volume behaviour is intentionally
  absent (App Review Guideline 2.5.9).
- Battery and thermal cost must come from recorded device runs; the previous
  unmeasured percentage-per-hour estimate is not release evidence. Automatic
  stationary pausing is intentionally disabled while a tracking lease is live,
  so long-device runs must measure the cost of that safety choice.

## Remaining work

There is no remaining Timer-to-player, interruption-observer, Time Sensitive
scheduling, or Always-location source TODO. The remaining release work is the
signed-device matrix above, including confirmation of the delivered
interruption level and locked-screen authorization behaviour, plus remediation
of any failed row. Critical Alerts remain a separate, Apple-approved future
capability rather than a public-beta claim.
