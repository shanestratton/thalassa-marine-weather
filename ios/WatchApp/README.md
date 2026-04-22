# ThalassaWatch — watchOS Companion

This directory holds the SwiftUI sources for the Thalassa Apple Watch
app. They're **not yet wired into the Xcode project** — Capacitor
doesn't sync watchOS targets automatically, so you (the human) need
to do the one-time Xcode setup described below.

For the bigger picture (what this is, why, how it talks to the iOS
app), read [`docs/apple-watch-companion.md`](../../docs/apple-watch-companion.md).

## File map

```
ios/WatchApp/
├── README.md                    ← this file
├── ThalassaWatchApp.swift       ← @main App entry
├── Models/
│   ├── AnchorSnapshot.swift     ← decoded from WCSession dict
│   └── WeatherSnapshot.swift
├── Views/
│   ├── RootView.swift           ← TabView shell (Anchor / Cockpit / MOB)
│   ├── AnchorWatchView.swift    ← swing-radius ring + drag alarm
│   ├── CockpitGlanceView.swift  ← wind / heading / SOG glance
│   └── MobButton.swift          ← long-press mayday trigger
└── Services/
    ├── WatchSession.swift       ← WCSessionDelegate (receives state)
    ├── LocationManager.swift    ← watch-side GPS (independent of phone)
    └── AlarmHaptics.swift       ← taptic patterns
```

## One-time Xcode setup

Open `ios/App/App.xcworkspace` in Xcode, then:

### 1. Create the watchOS App target

- **File → New → Target**
- Choose **watchOS → App** (NOT "App with Companion App" — we already
  have the Capacitor iOS app as the companion)
- Product Name: **`ThalassaWatch`**
- Interface: **SwiftUI**
- Language: **Swift**
- Bundle Identifier: **`com.thalassa.weather.watchkitapp`**
- Embed In Application: select the existing **App** target
- Click **Finish**

Xcode will create a stub `ThalassaWatch` app and `ThalassaWatch
Watch App` target. You can delete the auto-generated `ContentView.swift`
and `ThalassaWatchApp.swift` — we're replacing them with our own.

### 2. Add the Swift sources to the watchOS target

In Xcode's Project Navigator:

- Right-click the **ThalassaWatch Watch App** group → **Add Files
  to "App"…**
- Select the entire `ios/WatchApp/` directory (excluding this README
  and `Models/`, `Views/`, `Services/` will come along automatically)
- **CRITICAL:** in the file inspector, ensure ONLY the
  **ThalassaWatch Watch App** target checkbox is ticked. By default
  Xcode also ticks the iOS `App` target — that would compile the
  watch sources into the iOS app and break the build.

### 3. Add the Capacitor plugin to the iOS target

Two new files for the iOS app side:

- `ios/App/App/WatchConnectivityPlugin.swift`
- `ios/App/App/WatchConnectivityPlugin.m`

Drag both into the `App` group in Xcode and ensure the **App** target
checkbox is ticked (NOT the watch target this time).

### 4. Set capabilities on the watchOS target

Select the **ThalassaWatch Watch App** target → **Signing &
Capabilities** tab:

- Click **+ Capability**
- Add **Background Modes** → check **"Location updates"**
- Add **App Groups** → use group **`group.com.thalassa.weather`**
  (matches the existing iOS app group used by AnchorWatchSyncService)

### 5. Set Info.plist keys on the watchOS target

In `ThalassaWatch Watch App/Info.plist`, add:

| Key                                            | Value                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `NSLocationWhenInUseUsageDescription`          | "Anchor Watch needs GPS to detect drag and trigger the alarm."            |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | "Anchor Watch monitors your position even when the watch face is dimmed." |
| `WKBackgroundModes`                            | Array containing `location`                                               |

### 6. Build + run

- Plug in iPhone, pair with Apple Watch (must be on the same Apple
  ID)
- In Xcode, select the **App** scheme + iPhone destination → Run
- Then switch to the **ThalassaWatch Watch App** scheme + watch
  destination → Run
- The watch app should appear in the watch's app grid; opening it
  should immediately receive the latest anchor + weather state from
  the phone

### 7. Test the wire-up

With the phone app running and an anchor watch active:

1. **Anchor view:** dropping an anchor on the phone should make the
   watch tab show the green ring with the live distance
2. **Drag alarm:** force the alarm by setting a tiny swing radius and
   walking around — the watch should pulse haptics and show the red
   "DRAGGING" banner
3. **Cockpit view:** weather data flows when the phone refreshes
4. **MOB:** long-press the MOB button on the watch for 1.5s — the
   phone-side MOB workflow should fire

## Troubleshooting

- **"WCSession activation failed"** — check both apps have the same
  Apple ID and the watch is paired
- **State doesn't update on the watch** — confirm the `App Groups`
  capability is set on both targets with the same group ID
- **Build error "WatchConnectivity is not available"** — you've
  accidentally added the watchOS sources to the iOS target. Untick
  the App target in the file inspector for each `.swift` file
- **Compass / heading not showing** — Capacitor's CoreMotion plugin
  doesn't auto-forward heading to the watch yet; that's a follow-up
  (see roadmap)

## Future iterations (not in this MVP)

- **Complications** — bezel widgets for wind speed + anchor distance
- **InteractiveWidget** — one-tap MOB from the Smart Stack (watchOS 11+)
- **Watch-side persistence** so the swing circle survives app kills
- **HealthKit heart-rate during night watch** — alert if user is
  asleep and conditions deteriorate
- **Voice trigger** — "Hey Siri, drop anchor"
