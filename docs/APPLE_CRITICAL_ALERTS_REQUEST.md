# Critical Alerts entitlement request — draft for owner approval

Status: prepared, **not submitted or approved**. Do not enable the server's
`APNS_CRITICAL_ALERTS_ENABLED` flag or add the signing entitlement until Apple
approval and the corresponding app permission/provisioning work are complete.

Form: https://developer.apple.com/contact/request/notifications-critical-alerts-entitlement/

## App Type

Personal Safety and Security

## Bundle ID

`com.thalassa.weather`

## Describe your app

Thalassa is a marine weather and voyage companion for recreational sailors.
Its optional Anchor Watch helps a skipper monitor an anchored vessel. The
skipper deliberately starts a time-limited watch, sets an anchor position and
swing radius, and pairs an authorised shore phone. An onboard receiver supplies
GPS positions through a connected onboard device. A server checks the active
watch and sends alerts to the paired phone. This is supplementary assistance,
not a replacement for proper seamanship, a lookout or independent safety measures.

## What type of notifications will you send as Critical Alerts?

Only urgent conditions during a watch explicitly activated by the skipper:
(1) the vessel is reported outside the configured anchor swing radius;
(2) fresh GPS is lost and the boat's position can no longer be checked; or
(3) the onboard device stops reporting, so remote monitoring is unavailable.
Loss-of-monitoring alerts are explicitly labelled GPS LOST or CONTACT LOST,
not as confirmed dragging. Routine expiry reminders, weather information,
messages, community features and marketing will not use Critical Alerts.

## How frequently will you send Critical Alerts?

Rarely. They are event-driven, not regularly scheduled. A normally holding,
connected vessel generates no alarm. The current remote implementation limits
repeated drag events to no more than one per ten minutes per active session;
GPS/contact-loss alerts occur when the corresponding condition is detected.
Failed-delivery retries are bounded, recheck the active condition, and exclude
devices for which Apple has already accepted the same event. Recovery or stopping
the watch suppresses pending events. Delivery and audibility cannot be guaranteed.

## Explain why you need this entitlement and how it will be used

An anchored boat may drift towards another vessel, shore or hazards if its
anchor drags. The skipper may be asleep aboard or temporarily ashore with the
paired phone locked, muted or in Focus. Missing an urgent warning can delay
checking the vessel. Likewise, loss of GPS or communication means the skipper
must know that the remote watch can no longer observe the boat.

We currently use ordinary time-sensitive push notifications, with a distinctive
24-second bundled alarm sound in the updated app. These cannot reliably alert
through Silent mode or all Focus configurations. Foreground app audio cannot
be relied on to start when the app is suspended or terminated. We therefore
request Critical Alerts for the narrowly scoped active-watch conditions above.

If approved, we will add the approved entitlement and request explicit iOS
Critical Alerts permission when the user sets up the safety feature. The app
will check permission/settings and explain when notification readiness is not
verified. Users can stop the watch or leave Shore Watch and revoke permission
in iOS Settings. Current watch expiry, condition checks, stale-event suppression
and limited delivery lifetime will continue to apply. We will not represent
APNs acceptance as proof that a device sounded, nor use this entitlement for
routine reminders or general-purpose alerts.

## Required after approval

1. Add the entitlement only for the approved App ID and regenerate signing
   profiles for development and distribution.
2. Implement explicit Critical Alerts authorisation and expose its actual status
   in readiness; normal notification permission is not sufficient.
3. Carry device capability/permission through registration so mixed-version
   devices do not receive an unsupported Critical payload.
4. Test a clearly labelled non-emergency notification with the owner present:
   foreground, background, locked, Silent, Focus, denied/revoked permission,
   and both Xcode and TestFlight builds. Do not disturb a live watch to test.
5. Enable critical delivery only after those checks. Until then keep the ordinary
   time-sensitive path and its limitations visible.

References:

- [Apple Critical Alerts entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.critical-alerts)
- [Apple custom notification sound requirements](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/SupportingNotificationsinYourApp.html)
