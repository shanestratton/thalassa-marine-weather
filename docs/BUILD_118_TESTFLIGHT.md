# Build 118 — passage, chart, diary and Log improvements

Status: preparing 1.2.0 (118), following the skipper's September 23 request to
include all accumulated commits and current changes and deliver to TestFlight.
No claim of upload or tester availability until Apple confirms it.

## Included

- Autorouting trial: ENC display, canal departures, chart-aware route review,
  editable waypoints, fewer display points and full-screen tracer-style controls.
- OBS passage HUD: readable instruments, route-relative forecast playback,
  departure-time selection, stable ETA, route framing and waypoint display.
- Tide stations, pressure-layer improvements, fixed marker anchoring and GPS
  diagnostic presentation where receiver metadata is available.
- Diary comment moderation/highlights, logical-save deduplication and public
  diary/map presentation improvements.
- Passage grouping and consistent departure-based Log durations; no automatic
  deletion of recorded voyages from partial local data.
- Yacht locator on planning charts, with source/age-aware last-known positions.

The installed app includes the current repository app source, not the isolated
older web-release baseline. Building does not deploy backend/Pi services or
restart instruments. Existing backend deployments remain unchanged. Scheduled
holiday tasks remain paused. External TestFlight/public access remains unchanged.

## What to Test — English (Australia)

1.2.0 (118) — Passage, chart, diary and Log improvements

OBS: try the Passage HUD with a route loaded in Log. Check readable instruments,
the purple route, whole-route framing, departure time and ETA, and weather
playback with the HUD minimised. Compare live GPS source/age with your instruments.

Planning: check the yacht-locator button. Test the private autorouting trial's
full-screen chart, canal departure, route review and waypoint editing. Trial
proposals and join estimates are not routes cleared for navigation; check current
charts, notices, depths and local conditions before use.

Log: check the purple passage grouping and durations in days plus hours, including
Longest. Recording may be armed before departure; elapsed time starts from
GPS-confirmed movement, not the moment a route is selected.

Diary: check entries no longer briefly duplicate, pending-comment highlights and
approval beneath the relevant entry. Check day/night modes and phone rotation.

## Release evidence

Pending final build, archive, Apple validation, upload and TestFlight processing.
