# Boat link only when there is a boat

Package 131-01 (was 126-10; q-boatlink-lazy). Built in build 131 on `bootlazy131`.

A phone with no Pi paired and no gateway saved has no boat link to describe, so it no longer loads the boat-link
service at start-up. A boat with one loads it as before, and her words, her instrument policy and her voyage track's
source plan are the same.

## Who imported it on master (recounted on b131 at 26d1d6e4)

`services/boatLink/BoatLinkService` was imported **statically** by five modules:

| Module                                     | What it read                                 | When                             |
| ------------------------------------------ | -------------------------------------------- | -------------------------------- |
| `components/SystemStatusButton.tsx`        | the NMEA row's words; a subscription         | every launch: the header button  |
| `services/InstrumentSourcePolicy.ts`       | where the phone is; may the fallback open    | every launch: the policy boots   |
| `services/shiplog/trackSourceInputs.ts`    | WHERE, LANE, KIND, DATA at a voyage start    | the Log page, and a voyage start |
| `components/map/MapboxVelocityOverlay.tsx` | may this phone's GPS stand in for the boat   | the chart's wind field           |
| `hooks/useBoatLink.ts`                     | the whole snapshot, for four screens (below) | when one of them opens           |

`useBoatLink` serves VesselHub (the NMEA Gateway row), TheGlassPage (the Instrument Panel pill), RemoteAccessSection
(the VPN banner) and NmeaPage (the gateway page). Counting those four screens beside the other four modules gives the
roadmap's list.

Two more loaded it **dynamically**: `services/underway/UnderwayAlarmWatch.ts` (on idle after the first screen, for
every phone) and `services/ShipLogService.ts` (at a voyage start).

The production build of the base shows it: the 21 KB `BoatLinkService` chunk was a static import of
`SystemStatusButton`, `InstrumentSourcePolicy`, `MapHub`, `SettingsModal`, `trackSourceInputs` and `useBoatLink`, so
the header button alone brought it in, and its 2 s tick started, on every phone.

## What changed

- **The gate** (`services/boatLink/boatLinkGate.ts`): `boatLinkConfigured()` (a Pi paired or a gateway saved),
  `boatLinkIfConfigured()` (the loaded service, else null, starting the load for a boat that has a link),
  `loadBoatLink()`, `watchBoatLink()`, and `BOAT_LINK_CHECKING`, the words while it loads.
- **Boot path, only for a boat with a link:** the instrument policy starts the load on a Pi-first boot and reads it only
  there; the System status button watches it while this phone has a link (re-read on its 5 s poll) or while the box is
  open; the chart's wind field and the under-way watch read it through the gate; the track source plan loads it at a
  voyage start for a boat with a link, with the same facts as before.
- **Screens about the link load it when they open**, set up or not (a crew phone with neither still reads her through
  the cloud).
- **The null path says "checking", never "no boat":** the Vessel row and the gateway page show "Checking…"; the System
  status row says "Checking…" for a boat with a link and "Not set up" for a phone with neither; the policy treats the
  place as unknown and the fallback as not permitted (the fallback cannot open in its first minute anyway); the wind
  field never treats this phone as the boat; Remote Access proves nothing.
- Smart Polars' switch uses `boatLinkConfigured()` (126-B6a's follow-up).

Not changed: `ShipLogService` still loads the service itself at a voyage start (not a start-up cost).

## Measured (production build, `vite build`)

|                                             | Base (b131 at 26d1d6e4) | After                                                   |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Entry static graph                          | 6 chunks, 269,414 B     | 6 chunks, 269,414 B                                     |
| `ApplicationShell` chunk                    | 1,699,456 B             | 1,542,139 B (−157,317 B)                                |
| `ApplicationShell` static graph             | 15 chunks, 2,574,582 B  | 15 chunks, 2,417,265 B                                  |
| Start-up set of a phone with no boat link\* | 32 chunks, 2,687,160 B  | 37 chunks, 2,524,403 B (−162,757 B)                     |
| `BoatLinkService` in that set               | yes (21,125 B)          | no (11,073 B + its 10,193 B model, loaded on demand)    |
| `DiaryPage` chunk                           | 303,008 B               | 80,685 B (the trimmer and mp4box: 222,409 B, on demand) |
| All JavaScript                              | 10,441,230 B            | 10,454,112 B (+12,882 B of chunk seams)                 |

\* The entry, `ApplicationShell`, and the lazy pieces every launch loads (`SystemStatusButton`,
`InstrumentSourcePolicy`, `UnderwayAlarmWatch`), each with its static imports. The passage HUD pane (66,343 B) left
the shell with its own code. Lazy loading changes start-up, not the total: every `.js` file ships.

## On the phone

- A boat with a Pi or a gateway: the Vessel row, the gateway page and the System status row may say "Checking…" for a
  moment on a cold start, then what they said before. Never "No gateway".
- A phone with neither: the System status row says "Not set up"; the Vessel row "Checking…" then "Not connected".
- The passage HUD appears when a route is followed, previewed on Obs, or a track records — a moment later than before
  on the first show of a launch.
