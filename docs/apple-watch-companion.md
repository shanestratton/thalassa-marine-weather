# Apple Watch Companion — Architecture & Setup

Roadmap item #5. Per the world-domination notes: _"wind / heading /
anchor alarm. This alone is why people pay for Orca/Aqua Map."_

## Why this matters

Apple Watch is the moat. Orca and Aqua Map both ship watch companions
that turn the wrist into a glanceable cockpit instrument — anchor
drag detection, current wind/heading, MOB trigger. Sailors with both
phones AND watches expect this; sailors with neither don't pay $228/yr
for PredictWind. Building this puts Thalassa in the "serious offshore
nav" tier rather than the "weather dashboard" tier.

## MVP scope (this iteration)

Three features, ranked by safety value:

1. **Anchor Watch alarm** — the headline. Watch pings + vibrates the
   moment GPS leaves the swing circle, even if the phone is locked,
   even if the user is asleep. Standalone screen showing distance
   from anchor + max recorded drift + visual ring.
2. **Cockpit Glance** — current wind speed/direction + heading +
   speed-over-ground in one tap. The "I'm trimming sail and want to
   see the gust without pulling out my phone" view.
3. **MOB trigger** — long-press the digital crown to fire the existing
   MOB workflow. Wrist is the fastest path to the mayday button when
   someone's already in the water.

Out of scope this iteration:

- Offline charts on watch (huge, separate epic)
- Watch-side route guidance / arrival notifications (post-MVP)
- HealthKit integration (heart-rate during night watches — nice-to-have)

## Architecture

```
┌──────────────────────────┐         ┌─────────────────────────┐
│   React/TS app (web)     │         │   watchOS app (Swift)   │
│                          │         │                         │
│  AnchorWatchService      │         │  AnchorWatchView        │
│       │                  │         │  CockpitGlanceView      │
│       ▼                  │         │  MobButton              │
│  watchBridge.ts          │         │                         │
└──────────┬───────────────┘         └─────────────┬───────────┘
           │                                        │
           │ Capacitor bridge                       │
           ▼                                        │
┌──────────────────────────┐                       │
│  iOS native (Swift)      │                       │
│                          │   WatchConnectivity   │
│  WatchConnectivityPlugin │ ◄────────────────────►│
│       │                  │   (Apple framework)   │
│       ▼                  │                       │
│  WCSession.default       │                       │
└──────────────────────────┘                       │
```

### Why this layering

- **TS layer doesn't know about WatchConnectivity** — it just calls
  `watchBridge.pushAnchorState(snapshot)`. Cross-platform safe; on
  Android/web the bridge is a no-op.
- **iOS native plugin owns the WCSession lifecycle** — activation,
  reachability, message buffering. Same pattern as our existing
  `AlarmAudioPlugin` and `BackgroundLocationPlugin`.
- **Watch app is fully self-contained** — once it has the latest
  anchor snapshot, it doesn't need the phone for the alarm logic.
  GPS is read directly from the watch's Core Location (Apple Watch
  Ultra has built-in GPS; Series 6+ uses Bluetooth/Wi-Fi from the
  paired phone). Geofence-on-watch ensures the alarm fires even if
  the phone dies or goes out of Bluetooth range.

### Data flow

1. **Phone → Watch (every state change):**
    - AnchorWatchService snapshot (anchor lat/lon, swing radius, current
      vessel position, watch state)
    - WeatherKit minutely current conditions (wind speed/dir, gust,
      pressure trend, temp) — pushed every 10 minutes during active use
    - Active route waypoints (post-MVP)

2. **Watch → Phone (rare events):**
    - MOB trigger
    - "Cancel alarm" acknowledgement

3. **Watch standalone:**
    - GPS reads (watch Core Location)
    - Distance-from-anchor calculation
    - Local alarm trigger (haptic + UI)
    - Compass / heading

## File layout

```
ios/
  App/                                    (existing iOS Capacitor app)
    App/
      WatchConnectivityPlugin.swift       (NEW: bridges TS → WCSession)
      WatchConnectivityPlugin.m           (NEW: Capacitor plugin registration)
      AppDelegate.swift                   (modified: activate WCSession)
  WatchApp/                               (NEW: watchOS App target sources)
    README.md                             (Xcode setup walkthrough — start here)
    ThalassaWatchApp.swift                (App entry point + WCSessionDelegate)
    Models/
      AnchorSnapshot.swift                (mirror of TS AnchorWatchSnapshot)
      WeatherSnapshot.swift               (mirror of subset for cockpit glance)
    Views/
      RootView.swift                      (TabView: Anchor / Cockpit / MOB)
      AnchorWatchView.swift               (live ring + distance + drift)
      CockpitGlanceView.swift             (wind kts/dir + heading + SOG)
      MobButton.swift                     (long-press trigger + countdown)
    Services/
      LocationManager.swift               (Core Location wrapper for watch GPS)
      WatchSession.swift                  (WCSession receiver, observable state)
      AlarmHaptics.swift                  (taptic engine patterns)

services/
  native/
    watchBridge.ts                        (NEW: TS-side Capacitor wrapper)
  AnchorWatchService.ts                   (modified: push snapshot to bridge)
```

## Setup steps (Xcode work — manual)

The TypeScript + native plugin code can ship in this commit. The Xcode
project changes need to be done by hand because Capacitor doesn't sync
watchOS targets automatically.

### 1. Add a watchOS App target

Open `ios/App/App.xcworkspace` in Xcode, then:

- File → New → Target
- Choose **watchOS → App** (not "App with Companion App" — we already
  have the Capacitor iOS app as the companion)
- Product Name: **ThalassaWatch**
- Interface: **SwiftUI**
- Language: **Swift**
- Bundle Identifier: `com.thalassa.weather.watchkitapp`
- Embed In Application: select the existing **App** target

### 2. Drop in the Swift sources

Drag the contents of `ios/WatchApp/` (excluding `README.md`) into the
new ThalassaWatch target group in Xcode. **Make sure the "ThalassaWatch"
target is checked** in the file inspector for each file — by default
Xcode also checks the iOS target which would compile the watch sources
into the iOS app and break the build.

### 3. Set capabilities on the watchOS target

In Xcode, select the ThalassaWatch target → Signing & Capabilities:

- Add **Background Modes** → check "Location updates"
- Add **App Groups** → use group `group.com.thalassa.weather` (matches
  the existing iOS app group used by AnchorWatchSyncService)

### 4. Set Info.plist keys on the watchOS target

In `ThalassaWatch/Info.plist`, add:

- `NSLocationWhenInUseUsageDescription`: "Anchor Watch needs GPS to
  detect drag and trigger the alarm."
- `NSLocationAlwaysAndWhenInUseUsageDescription`: "Anchor Watch monitors
  your position even when the watch face is dimmed."
- `WKBackgroundModes`: array containing "location"

### 5. Update the iOS app target

The new `WatchConnectivityPlugin.swift` in this commit needs to be
added to the iOS App target (drag into Xcode, check "App" target).
`AppDelegate.swift` is already updated to activate the WCSession on
launch.

### 6. Build + run

- Plug in iPhone, pair with Watch, ensure both are on the same Apple ID
- Build the **App** scheme on the iPhone
- Build the **ThalassaWatch** scheme on the Watch (in Xcode → "Run on
  device" picker → select Apple Watch)
- The watch app should appear in the watch face's app grid

## Testing without an Apple Watch

The TS-side and native iOS plugin work even without a paired watch:

- `watchBridge.pushAnchorState()` becomes a no-op — `WCSession.isPaired`
  is false, the plugin logs and returns success
- The Capacitor TS layer doesn't error
- Existing iOS app behavior is unchanged

Once you pair a watch and install the watch app, state starts flowing.

## Ongoing work after MVP

- Watch-side persistence (KeychainSwift) so the swing circle survives
  app kills
- Complications (the bezel widgets) — wind speed + anchor distance
- Voice trigger ("Hey Siri, drop anchor")
- HealthKit heart-rate during night watch (alert if user is asleep
  and conditions deteriorate)
- watchOS 11 InteractiveWidget for one-tap MOB from the Smart Stack
