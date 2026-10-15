# Android scoping study — build 133 / 133-11

Recommendation: finish the iOS public beta first, then build an Android release for **crew + Shore Watch**. Reuse the shared React/TypeScript application and backend, but do not describe a Capacitor shell as Android readiness. Pi transport, secure persistence and alarm delivery need native work and physical-device evidence.

This is a read-only study against foundation `6d5701e743c2d1828e8b14503acb381956f16e80`, following [the confirmed 14 October roadmap](roadmap/2026-10-14.md#android-scoping-study-read-only-no-builder-slot). It creates no Android project, build, account, deployment or purchase. Estimates and Android replacements below are engineering proposals, not implemented or device-validated capabilities.

## Current position

- The source tree has no `android/` project; `package.json` has Capacitor 8 core/iOS dependencies but no `@capacitor/android`. `capacitor.config.ts` already names `com.thalassa.weather` and `androidScheme: 'https'`; those settings alone do not supply a native app.
- There are **20 custom `*Plugin.swift` files** under `ios/App/App/`. `ThalassaBridgeViewController.swift` explicitly registers **19**. `SshClientPlugin` is explicitly unregistered and its comment says it is outside the Xcode build graph. AppDelegate, SceneDelegate and the bridge controller are framework integration, not extra plugins.
- Existing official Capacitor plugins cover much of app lifecycle, browser, filesystem, geolocation, haptics, keyboard, local/push notifications, network, preferences, orientation, sharing and status bars. Android installation, permissions, API behavior and version compatibility still require a future build. Community speech recognition, keep-awake and TCP sockets also need device checks.

## Every custom Swift plugin

All filenames below are in `ios/App/App/` and end in `Plugin.swift`. “Android” means a proposed native equivalent; “web” means a bounded shared fallback; “iOS only” means retain that capability only on iOS for the first release.

| Plugin                   | Proposed destination                  | Scope and constraint                                                                                                                                                                     |
| ------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AlarmAudio               | Android                               | Native audio focus/playback and owner-scoped stop/retry semantics; Shore Watch needs this. No claim to bypass mute, DND or user settings.                                                |
| AnchorSafetyNotification | Android                               | Notification channels, verified permissions and scheduling/cancellation with fixed identifiers. Reproduce safety intent, not Apple's time-sensitive API; prove behavior while suspended. |
| AnchorWatchStorage       | Android                               | Keystore-backed encrypted, identity-scoped recovery records with install/reset boundaries. No Preferences/plaintext substitution.                                                        |
| AppleCredentialState     | iOS only                              | Apple's native credential state/revocation listener stays on iOS; Android account/session invalidation needs its own supported server/browser lane.                                      |
| AppleMusic               | iOS only                              | Hide native Apple music controls on Android; not a crew/Shore Watch dependency.                                                                                                          |
| BackgroundLocation       | Android                               | Adapt the existing Transistorsoft lane and foreground-service lifecycle; preserve permission/status semantics. Defer phone-owned skipper tracking from release one.                      |
| Barometer                | Android                               | Optional pressure sensor via native sensor APIs; report unavailable on devices without one. Defer from release one.                                                                      |
| DataScanner              | Android + web                         | Native camera/barcode/OCR equivalent; retain manual entry or existing bounded browser scan path where supported. Never advertise Apple's VisionKit on Android.                           |
| EncryptedLargeStorage    | Android                               | Keystore-backed AES-GCM files with the same logical-key allowlist, bounds, identity binding, migration and cache purge contract.                                                         |
| GoogleOAuth              | Android                               | Supported Android Google identity flow or system-browser PKCE with validated callback; do not reuse the iOS client/callback assumptions.                                                 |
| Lightning                | Android                               | Native WebSocket transport behind the existing licence gate; browser transport requires an authorized relay, not a direct origin bypass. Defer from release one.                         |
| MdnsBrowser              | Android                               | Native DNS-SD discovery with network/multicast lifecycle and permissions; manual paired-host entry remains a discovery fallback, not a TLS fallback.                                     |
| MemoryGauge              | Android + web                         | Android process/memory-pressure callbacks and conservative cache limits; web keeps bounded/no-op behavior. iOS memory numbers are not portable thresholds.                               |
| NetworkInterfaces        | Android                               | Enumerate usable LAN/VPN interfaces and addresses; preserve manual-host fallback and distinguish missing LAN from no internet.                                                           |
| NfcTag                   | Android + web                         | Native NFC/NDEF plus Android app links; manual/QR entry as fallback. Hardware optional; defer NFC from release one.                                                                      |
| PiTls                    | Android                               | Custom pinned-SPKI HTTPS bridge preserving the exact pairing trust contract; highest-risk native gap. No browser fallback in production.                                                 |
| SecureStorage            | Android                               | Keystore-backed secret storage for auth, chat and Pi credentials with existing allowlist/logout/install semantics.                                                                       |
| SshClient                | Android, later                        | Optional SSH provisioning after a separate host-key/security review. It is not a functioning registered iOS capability to port blindly; release one uses an already-provisioned boat.    |
| WatchConnectivity        | iOS only                              | Keep the Apple Watch companion on iOS. Wear OS is a separate product scope.                                                                                                              |
| WeatherKit               | iOS only + shared web/server forecast | Retain the existing shared forecast path on Android; a server-side Apple weather integration would require separate terms and credential review.                                         |

## Platform branches and patches

The key audit distinction is **native platform versus implemented capability**. Android makes `isNativePlatform()` true even when a local Swift plugin has no Android implementation.

- `services/AlarmAudioService.ts`, `services/BackgroundLocationService.ts`, `services/native/dataScanner.ts`, `services/native/scanBarcode.ts`, `services/native/weatherKit.ts`, `services/native/memoryGauge.ts`, `services/weather/api/blitzortungLightning.ts` and native Google auth currently contain broad native checks or assumptions. Add explicit platform/capability routing before exposing those paths on Android. Missing-plugin errors must not become a silent safety fallback.
- `services/auth/secureStorage.ts` currently enables secure storage only on iOS. `services/nativeStorage.ts` enables encrypted large storage only on iOS; other paths use legacy filesystem/localStorage persistence. Android must gain equivalent encryption before storing sensitive sessions, crew keys, precise tracks or watch recovery data; accepting the existing fallback would weaken the storage boundary.
- `services/native/barometer.ts`, `services/native/nfcTags.ts`, `services/native/watchBridge.ts`, `services/native/watchBridgeListeners.ts` and `services/auth/appleCredentialState.ts` explicitly gate on iOS. Enable only replaced capabilities; retain explicit unavailable states for the others. `services/native/apiBase.ts` already routes native calls to an absolute API base.
- Recheck iOS-specific safe areas, keyboard/viewport scaling, audio session assumptions, URL callbacks, notification badges and local-network discovery. The iOS `AppDelegate` push/callback integration and `ThalassaBridgeViewController` registration require Android lifecycle equivalents, not copied Swift.
- `patches/@capacitor-community+apple-sign-in+7.1.0.patch` changes only iOS presentation/main-thread/call ownership. Keep it for iOS; it does not provide Android Apple login.
- `patches/capacitor-tcp-socket+7.1.0.patch` moves blocking Swift socket work off the Capacitor bridge queue. Keep it for iOS; inspect Android socket threading, reconnect, cancellation and concurrent storage latency independently. No automatic Android patch is justified by the Swift fix.

## Auth and push

Keep Supabase identity, crew membership and account deletion semantics shared. Validate email login/recovery, Google login, returning Apple-linked users, invite acceptance and account switching on Android. `services/auth/googleSignIn.ts` dispatches a native flow built around the custom iOS `ASWebAuthenticationSession` bridge and reversed iOS client-ID callback. An Android OAuth client, supported return path, release signing fingerprints where required, provider audience configuration, PKCE/nonce verification, cancellation and cold-start handling are implementation tasks. Do not embed a client secret. Apple web login is separately gated in `SocialAuthService.ts`; it cannot be assumed available merely because iOS login works.

`PushNotificationService.ts` accepts opaque tokens and submits `Capacitor.getPlatform()` to `claim_push_device_token`. However, `supabase/functions/send-push/index.ts` selects `platform` then sends **every token through APNs**. Android registration therefore does not imply Android delivery.

Future FCM work must add Android Firebase configuration, notification permissions/channels and a server-side FCM HTTP v1 sender with platform routing. Preserve token ownership transfers, logout cleanup, token rotation/pruning, expiry, idempotency, retry and notification-tap routing. Keep server credentials off the client. Exercise every producer that reaches the shared sender, including crew and Shore Watch alarms; check any separate anchor-alarm path too. Display a truthful last-contact/stale state: push acceptance is not proof that a person heard an alarm.

The [Capacitor 8 push documentation](https://capacitorjs.com/docs/apis/push-notifications) specifies FCM and app-level `google-services.json`, Android 13+ permission requests, channels, Doze constraints, and no JavaScript data-message callback after the app is killed without a native service. Android 15 private-space locking also blocks visible pushes. A browser/PWA alone does not meet Shore Watch background-alarm acceptance.

## Pi transport is the critical technical risk

`PiTlsPlugin.swift` authenticates the exact paired public key, not a public CA or hostname. Android must preserve TLS 1.2+, exact SPKI comparison, rejection before exposing a mismatched body, and the sole unpinned path `/api/pair/info`. That first-contact response includes the peer SPKI, which must match the advertised pairing key and challenge response before persistence. Preserve timeout/binary response behavior, session isolation, no disk response cache, LAN-to-DHCP/mDNS changes and pinned tailnet access.

Do not replace this with global trust-all networking, cleartext, hostname-only pins or WebView certificate bypasses. `services/piTls.ts` already gates production Pi access on plugin availability; its browser lane cannot observe a peer certificate. Scope an Android native networking implementation and adversarial tests after the iOS beta. Release one may consume the shared remote Shore Watch backend for already-configured boats, with direct Pi pairing/provisioning withheld until this bridge passes. If direct Pi access is required at launch, add the Pi work to the first-release estimate.

## Licensing, Play listing and device evidence

- The manifest declares `@transistorsoft/capacitor-background-geolocation` `^9.3.0` and background-fetch `^8.1.3`. Verify the resolved versions, Android release entitlement and package ID with the existing licence owner. Current [Transistorsoft setup](https://docs.transistorsoft.com/capacitor/setup/) requires a release licence; the [licence agreement](https://docs.transistorsoft.com/license/) scopes a release key to one platform. Existing iOS use does not prove Android entitlement. Do not buy anything for this study; defer unnecessary skipper tracking from release one.
- At implementation time, prepare the Play application ID/signing custody, app bundle, icon/screenshots, description, privacy policy, Data safety answers, account deletion path, content rating, reviewer access and any background-location/foreground-service declarations actually used. Recheck target SDK and policy requirements then. Precise location, contacts/crew data, chat encryption and safety wording must match real behavior.
- Google's current [Play Console setup](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en) lists a **US$25 one-time registration fee**. New personal accounts subject to [production-access testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en) need at least **12 continuously opted-in closed testers for 14 days** before applying. Account type/eligibility is unknown; allow review lead time. No account is opened here.

| Physical-device coverage, proposed                                  | Required checks                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Oldest Android/Capacitor-supported phone, 3–4 GB RAM                | Shared screens, storage bounds, low-memory recovery, chat, low-bandwidth reconnect; choose the support floor during implementation.  |
| Pixel on current Android, including Android 13+ permission behavior | FCM foreground/background/killed, cold-start taps, denied/revoked notification permission, channels, locked screen, Doze and reboot. |
| Samsung Galaxy with One UI                                          | Battery restrictions, screen-off overnight watch, alarm audibility, audio focus/Bluetooth, duplicate suppression and reconnect.      |
| Another restrictive OEM, plus tablet/large font                     | Process killing, battery saver, no-pressure-sensor behavior, keyboard/safe areas, scaling and rotation.                              |
| GMS/FCM-unavailable device                                          | Explicit unsupported push state; do not advertise reliable Shore Watch without a separately validated alternative.                   |
| LAN + mobile data + VPN/tailnet across the above                    | Offline recovery, stale telemetry, Wi-Fi loss/roam, captive portal, wrong-key Pi, changed Pi address and account switching.          |

Cross-platform acceptance must include iOS skipper → Android crew invitations/chat, identity-scoped secure logout/reinstall recovery, backend-triggered Shore Watch alarms and cancellation, revoked membership, stale telemetry, offline return and a real overnight locked-device watch. Run Android from an installed release candidate, not only attached to Android Studio. Record OS/model/battery settings and observed delivery times; emulators are supplemental.

## Estimate and sequence

Planning estimate for one experienced builder, after iOS public beta; not a delivery commitment:

| Work                                                                     | Builder days |
| ------------------------------------------------------------------------ | -----------: |
| Android shell/dependency audit, capability routing and shared UI         |          3–5 |
| Secure auth/storage, crew flows and cross-platform identity checks       |          5–8 |
| FCM sender/client, Shore Watch audio/notification lifecycle and recovery |         7–12 |
| Device hardening, overnight checks and Play preparation                  |         5–10 |
| **Crew + remote Shore Watch first release**                              |    **20–35** |
| Direct Pi TLS/discovery/pairing, if required at first release            | **add 7–12** |

Allow roughly **4–7 builder weeks** for the first release, plus testing/review calendar time where it cannot overlap. Full skipper/navigation parity, background tracking, provisioning, optional sensors and deferred plugins is a separate phase: provisionally another **20–40 builder days**, revisited after the Pi TLS spike and device results. Transistorsoft entitlement, Android identity setup, device availability and OEM alarm behavior are unresolved dependencies; no spend beyond the known future Play fee is estimated without checking existing entitlements.

Proceed later in this order: secure identity/storage and crew → platform-routed FCM → measured remote Shore Watch → Pi TLS spike and pairing → skipper capabilities. Keep iOS-only optional controls hidden on Android. Do not release Shore Watch on the strength of a successful build or token registration: secure persistence, current telemetry, cancellation and overnight alarm behavior must pass on the supported device matrix.

Study validation: source-tree inventory and the listed bridge, service, patch, manifest and sender files were inspected at the pinned foundation; current vendor/Google documentation was checked on 15 October 2026 UTC. No Android execution or physical-device validation occurred. Only this report is changed by package 133-11.
