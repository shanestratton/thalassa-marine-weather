# Build 117 — music playback and radio layout

Status: preparing 1.2.0 (117); not yet uploaded.

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

Before release preparation: 95 focused unit tests and 18 Chromium/WebKit music
layout cases passed. Remaining checks and delivery receipts will be recorded
after completion. Native MusicKit playback still requires confirmation on an
actual signed-in iPhone; browser fixtures do not play subscription audio.

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
