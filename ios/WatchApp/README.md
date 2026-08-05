# Archived Watch prototype

This directory is an uncompiled historical prototype. It is not the Watch app
that ships with Thalassa. Its Swift files must not be added to either Xcode target.

The authoritative, embedded watchOS target is:

```text
ios/App/ThalassaWatch Watch App/
```

The authoritative phone bridge is:

```text
ios/App/App/WatchConnectivityPlugin.swift
services/native/watchBridge.ts
services/native/watchBridgeListeners.ts
```

## Public-beta boundary

- The iPhone owns Anchor Watch monitoring and the audible alarm.
- The Watch is a foreground companion. It displays age-gated phone snapshots
  and may use a fresh foreground Watch location while its app is open.
- The Watch does not promise independent or background anchor monitoring.
- A Watch MOB gesture asks the phone to record the event. The UI distinguishes
  phone-received, queued, and unreachable states and directs the sailor to
  VHF/DSC or the chartplotter for real distress action. Its stable request ID
  expires after 15 seconds; the phone deduplicates immediate/queued copies and
  never turns an expired request into a current-position MOB mark.
- No App Group or watchOS background-location capability is declared.

See [`docs/apple-watch-companion.md`](../../docs/apple-watch-companion.md) for
the current architecture, capability boundary, and release checks.
