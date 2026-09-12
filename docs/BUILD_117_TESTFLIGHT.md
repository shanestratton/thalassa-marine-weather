# Build 117 — music playback and radio layout

Status: delivered — 1.2.0 (117) is Testing in the existing Skipper internal
TestFlight group, confirmed September 12, 2026. English (Australia) testing notes
saved and verified after reload. Uploaded once at 11:00:00 AEST; no repeat upload.

## Changes

- MusicKit now prepares a newly assigned queue before judging playback, rather
  than misreporting an unhydrated queue as “superseded”. Only a genuinely newer
  playback intent cancels the old operation. Stop/Pause remain authoritative.
- Playlist and track retries clear the previous error; late cancelled results
  do not become user-facing errors. Genuine current playback failures remain
  visible and retryable.
- Radio instructions and transcript retain the real app header. Call-type
  buttons retain their position, including in iPad split view.
- The large coordinate-confirmation checkbox card is replaced by a compact
  action within the GPS card. Source, age, vessel matching and last-known
  warnings remain; unconfirmed coordinates are not silently called boat GPS.

## Release checks

Shane explicitly authorised skipping the full CI suite for these small changes
on September 12. The release commit uses `[skip ci]`; no full CI success is
claimed for 117. Focused tests, TypeScript, production build, native archive,
signing and Apple validation still apply.

- 95 focused unit tests and 18 Chromium/WebKit music layout cases passed.
- 28 exact-production radio browser tests passed in Chromium/mobile Safari,
  including phone/split-pane frame, unchanged call selector positions, complete
  transcripts, unconfirmed phone GPS and long-identity fallbacks. No retries or
  skips in these focused runs. Phone and split-pane screenshots inspected.
- TypeScript, targeted ESLint, formatting, diff checks and fresh `ship:beta`
  passed, including 140 final release contracts.
- Xcode 26.6 native archive and Apple validation passed. Independent archive,
  validation-distribution and upload-distribution verifications passed with zero
  failures/warnings, 422 matching public files and 23 matching binary/dSYM UUID
  pairs. Distribution signing, capabilities, privacy and source-map absence
  verified. AppIntents metadata warnings in dependency builds are non-fatal.

Native MusicKit streaming still requires confirmation on an actual signed-in
iPhone; browser fixtures do not play subscription audio.

## Artifact and delivery identities

- Release/compiled SHA: `aaa79791b47ae1fd69459cc40c65d0a19b400d1d`.
- Main `assets/main-HNtgzfOl.js`; SHA256
  `8b02d897c3063037197942dd5c0b5c936d409c7719262d1c8613fef2439b6177`.
- Archive:
  `/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-12/Thalassa-1.2.0-117-aaa79791.xcarchive`.
- Evidence: `/private/tmp/thalassa-release117.dkFTsU`.
- Frozen117 verifier SHA256:
  `0336d8d2f86e0fe3c264604d67d5d48e08e69f87ec7533363967085d78706be7`.
- Upload receipt: `6b636451-af68-41c2-af2e-9bc163c360d8`. Single upload exited0,
  `Upload succeeded`, `Uploaded App`, `EXPORT SUCCEEDED` at 11:00 AEST.
- Apple build ID matches the delivery receipt. Skipper received it automatically:
  16 builds, one existing tester. Its row explicitly shows `Testing`, upload date
  September 12 at 11:00 AM; no new testers or groups were created.
- Build116 is already Testing in Skipper; it was not rebuilt or reuploaded.

## What to Test — English (Australia)

> 1.2.0 (117) — Music playback and tidier radio screens
>
> Music: open a playlist and press Play, or choose a specific track. Check that
> playback starts without the false “superseded” message. Try switching tracks,
> Pause, and Stop; Stop should return to the compact playlist view. A real
> playback error should clear when you retry.
>
> Radio: the Thalassa header stays visible in VHF instructions and the voice
> transcript. Routine / PAN-PAN / MAYDAY stay in the same position. The bulky
> coordinate checkbox is gone; use the compact “Use these coordinates in call”
> action in the GPS card after checking the position. Continue remains available
> without it, with a manual-position prompt. Check iPhone and iPad split view
> in day, dark and night modes. These screens prepare text only; they do not
> transmit a radio call or distress alert.
