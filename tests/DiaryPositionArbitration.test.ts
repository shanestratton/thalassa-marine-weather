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

    it('the modal answer clears a photo pin set BEFORE it — order must not matter', () => {
        // Photos attached before the modal raised locationFromPhotoRef, and
        // applyResolvedPosition honours that flag — an explicit ⚓ tap was
        // silently a no-op (2026-09-01). The choice handler now lowers the
        // flag before applying.
        const choice = page.slice(page.indexOf('const applyGpsChoice'), page.indexOf('const applyGpsChoice') + 1800);
        expect(choice).toContain('gpsChoiceExplicitRef.current = true;');
        expect(choice).toContain('locationFromPhotoRef.current = false;');
    });

    it('an explicit modal answer outranks photo EXIF for the whole session', () => {
        // The skipper picked ⚓ or 📱 by hand; a photo's geotag — the
        // camera's last CACHED phone fix, hours stale on a bad day — must
        // not reopen or silently reverse that answer (2026-09-01).
        expect(page).toContain('gpsChoiceExplicitRef.current = true;');
        expect(page).toContain('!locationFromPhotoRef.current && !gpsChoiceExplicitRef.current');
        // Cleared with every compose/edit session reset, alongside the
        // photo-pin flag.
        const resets = page.match(/gpsChoiceExplicitRef\.current = false;/g) ?? [];
        expect(resets.length).toBeGreaterThanOrEqual(3);
    });

    it('the save-time GPS retry arbitrates like everyone else — and never phones it in', () => {
        // "No GPS fix — will retry when you save" used to mean "ask only the
        // phone". The last unguarded gate (found by Shane, 2026-09-01): a
        // webview reload wiped the answered pin and this retry pinned the
        // entry at the phone while the boat streamed live. It now runs the
        // full candidates flow, and a real conflict raises the card and
        // steps aside instead of guessing.
        expect(page).not.toContain('DiaryService.getCurrentLocation()');
        const gate = page.slice(page.indexOf('will retry when you'), page.indexOf('will retry when you') + 2600);
        expect(gate).toContain('await DiaryService.getPositionCandidates();');
        expect(gate).toContain('toast.info');
        expect(gate).toContain('setGpsConflict({ vessel, phone, distanceM });');
    });

    it('the setter shims dispatch single fields — the shredder stays dead', () => {
        // Each shim used to send all three GPS fields with the others from a
        // stale snapshot; the reducer replaced everything. See
        // DiaryGpsStateAtomicity.test.ts for the reducer half of this pin.
        expect(page).toContain("dispatch({ type: 'SET_GPS', lat: v })");
        expect(page).toContain("dispatch({ type: 'SET_GPS', lon: v })");
        expect(page).toContain("dispatch({ type: 'SET_GPS', locationName: v })");
        // And a re-fired grabGps can never clobber an explicit answer.
        expect(page).toContain('if (locationFromPhotoRef.current || gpsChoiceExplicitRef.current) return;');
    });

    it('the Move-pin question can actually appear during compose', () => {
        // It rendered only in the timeline branch, so during compose it never
        // showed — it popped after the form closed, into dead state.
        expect(page).toContain('const photoPinDialog = (');
        const composeBranch = page.slice(page.indexOf('if (showCompose)'));
        expect(composeBranch).toContain('{photoPinDialog}');
        // An answered modal dismisses a pre-answer photo question.
        const choice = page.slice(page.indexOf('const applyGpsChoice'), page.indexOf('const applyGpsChoice') + 1900);
        expect(choice).toContain('setPhotoPinPrompt(null);');
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
