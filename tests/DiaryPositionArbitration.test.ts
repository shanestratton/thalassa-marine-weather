import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'components/DiaryPage.tsx'), 'utf8');
const service = readFileSync(resolve(process.cwd(), 'services/DiaryService.ts'), 'utf8');

describe('diary position arbitration — the pub-vs-passage question', () => {
    it("the vessel candidate is the boat's own electronics, never the phone's ship-log", () => {
        // The ship-log fix follows whatever device feeds the track — which may
        // be this same phone wearing a different hat. Live NMEA first; when
        // the bus is switched off, the Pi's own at-rest fix (her berth) —
        // still the boat's electronics, just asleep.
        // The SAME door as the chart's arrow — resolveOwnshipPosition on the
        // store's own metrics, nmea branch only. NmeaGpsProvider's extra
        // gates made the diary and the arrow disagree on the same device at
        // the same second (2026-08-31).
        expect(service).toContain("await import('./ownshipPosition')");
        expect(service).toContain("own && own.source === 'nmea' ? { lat: own.lat, lon: own.lon } : null");
        expect(service).toContain("await import('./piTrackRecorder')");
        expect(service).toContain('if (!vessel) vessel = await restingPromise;');
    });

    it('the resting fix is gated: recent, and stationary when last heard', () => {
        const recorder = readFileSync(resolve(process.cwd(), 'services/piTrackRecorder.ts'), 'utf8');
        expect(recorder).toContain('if (Date.now() - lastMs > maxAgeMs) return null;');
        expect(recorder).toContain('if (sog !== null && sog > 0.5) return null;');
    });

    it('the candidates surface claims the NMEA store — arbitration is never theatre', () => {
        // Same rule as the chart: asking "where is the boat" only counts if
        // something actually started the feed. Config-gated and idempotent.
        expect(service).toContain('if (hasGateway) NmeaStore.start();');
        // And a socket mid-reconnect gets a moment, hidden inside the
        // already-running phone fetch.
        expect(service).toContain('for (let i = 0; !vessel && hasGateway && i < 32; i++) {');
    });

    it('the phone candidate is a high-accuracy fix and carries its blur radius', () => {
        // The Coolum Parade entry came from the cheap fix with the accuracy
        // thrown away. Ask properly, and keep the number so the conflict rule
        // can weigh it.
        expect(service).toContain('enableHighAccuracy: true,');
        expect(service).toMatch(/accuracyM: Number\.isFinite\(pos\.accuracy\)/);
    });

    it('agreement or a single candidate resolves silently; only conflict asks', () => {
        // Blur-aware: a disagreement smaller than the phone fix's own
        // accuracy radius is fuzz, not the skipper ashore — the boat wins
        // silently (Coolum Parade, 2026-08-31: a fresh 2.3km-off indoor fix).
        expect(page).toContain('const phoneBlurM = phone.accuracyM ?? 50;');
        expect(page).toContain('if (distanceM >= 200 && distanceM > phoneBlurM * 1.5) {');
        expect(page).toContain('setGpsConflict({ vessel, phone, distanceM });');
        // Both single-candidate branches must exist, tagged with their source.
        expect(page).toMatch(/loc = vessel;\s*\n\s*setGpsSource\('vessel'\);/);
        expect(page).toMatch(/loc = phone;\s*\n\s*setGpsSource\('phone'\);/);
    });

    it('a GPS-tagged photo asks before moving ANY resolved pin — new entries included', () => {
        // The silent photo-wins path is only for an entry with no pin at all.
        // A new entry the arbiter just pinned to the boat must not be dragged
        // ashore by a photo without the skipper agreeing (2026-09-01).
        expect(page).toContain('const hasExistingPin = lat !== null && lon !== null;');
        expect(page).not.toContain('editingId !== null && lat !== null');
        expect(page).toContain('setPhotoPinPrompt({ lat: exif.lat, lon: exif.lon, movedM });');
    });

    it('the modal offers exactly the two honest answers', () => {
        expect(page).toContain('Two positions, skipper');
        expect(page).toContain("applyGpsChoice('vessel')");
        expect(page).toContain("applyGpsChoice('phone')");
    });

    it('the chosen source is visible on the compose form', () => {
        expect(page).toContain("gpsSource === 'vessel' ? '⚓ '");
    });
});
