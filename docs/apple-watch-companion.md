# Apple Watch companion

## Public-beta status

Thalassa ships an embedded watchOS 10 companion at
`ios/App/ThalassaWatch Watch App/`.
It is deliberately a **foreground companion**, not a second independent marine
alarm.

The iPhone remains the safety authority:

- Anchor Watch monitoring, geofence handling, notifications, and audible alarm
  run on the phone.
- The Watch receives timestamped Anchor Watch and cockpit snapshots through
  `WatchConnectivity`.
- Watch screens label stale information and stop presenting expired phone or
  GPS data as live.
- A Watch MOB gesture requests the phone workflow. The Watch reports whether
  the phone received it or merely queued it, and tells the sailor to use
  VHF/DSC or the chartplotter for actual distress action. Every request carries
  a stable UUID and a 15-second expiry. The phone deduplicates immediate and
  queued copies and visibly rejects expired/invalid requests; it never uses a
  later phone position as the casualty mark.

Do not describe the Watch as monitoring while asleep, while its app is closed,
or after the phone is unavailable. Those are not public-beta capabilities.

## Shipped architecture

```text
React / TypeScript
  AnchorWatchService + watchBridgeListeners
                 │
                 ▼
iPhone App target
  WatchConnectivityPlugin.swift
                 │ WCSession
                 ▼
Embedded watchOS target
  WatchSession.swift
  ├─ AnchorWatchView.swift
  ├─ CockpitGlanceView.swift
  └─ MobButton.swift
```

Authoritative paths:

- Phone bridge: `ios/App/App/WatchConnectivityPlugin.swift`
- TypeScript bridge: `services/native/watchBridge.ts`
- Event handling: `services/native/watchBridgeListeners.ts`
- Watch target: `ios/App/ThalassaWatch Watch App/`
- Watch Info plist: `ios/App/ThalassaWatch-Watch-App-Info.plist`

`ios/WatchApp/` is an archived, uncompiled prototype and must not be wired into
Xcode.

## Capability boundary

The public-beta Watch target intentionally has:

- no App Group entitlement;
- no watchOS background-location mode;
- foreground `When In Use` location copy only;
- no Critical Alerts entitlement; and
- no claim that a Watch haptic substitutes for the phone alarm or marine
  distress equipment.

The iPhone and Watch bundle versions must match. The Watch must remain embedded
in the host archive, and both privacy manifests must be present in their
respective products.

## Release checks

Automated gates cover target embedding, bundle/version parity, privacy
manifests, timestamp freshness, foreground-only copy, and honest MOB delivery
states. Before external TestFlight, also complete these physical checks:

1. Install one archive on a paired iPhone and Apple Watch.
2. Arm Anchor Watch on the phone and confirm the Watch receives the current
   radius/state while open.
3. Let the snapshot age and confirm the Watch changes to last-known/stale copy.
4. Close or background the Watch app and confirm no UI claims independent
   monitoring.
5. Trigger Watch MOB with the phone reachable and confirm `phone received`.
6. Repeat with the phone unreachable and confirm `queued/not distress sent`,
   then confirm the Watch changes to `expired` after 15 seconds.
7. In a debug build, delay/replay that envelope past its expiry (the Watch
   cancels a still-pending transfer when it can) and confirm the phone displays
   the persistent `NOT marked` warning without creating or moving a MOB marker.
8. Verify the iPhone alarm independently through the locked/background/silent
   and interruption test matrix in `docs/ANCHOR_WATCH_SWIFT_TODO.md`.

The absence of a physical Watch is an external TestFlight release blocker, not
a reason to weaken the foreground-only contract.

## Deferred work

Independent Watch monitoring, complications, background GPS, on-Watch route
guidance, and HealthKit integration are post-beta features. Each requires a new
capability, battery, privacy, and physical-device review before its copy may
change.
