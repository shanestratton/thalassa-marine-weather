// @vitest-environment node
/**
 * The pin shredder, pinned shut (2026-09-01).
 *
 * SET_GPS used to replace lat AND lon AND locationName from every action,
 * while the setter shims filled the fields they weren't setting from a stale
 * render snapshot. Two consequences, both fatal to the diary pin:
 *
 *   setLat(a); setLon(b)   — batched into one tick, the second action's
 *                            snapshot predates the first: lat REVERTS.
 *   ...await geocode...
 *   setLocationName(name)  — its snapshot predates both: lat AND lon are
 *                            wiped back to null.
 *
 * Every pin writer fed through this — the ⚓ vessel answer, the photo pin,
 * the Move-pin confirm — leaving the form at "No GPS fix" for the save-time
 * fallback to fill with the phone. The reducer now merges ONLY the fields an
 * action carries; these tests replay the exact shredder sequences.
 */
import { describe, expect, it } from 'vitest';
import { diaryReducer, initialDiaryState } from '../hooks/useDiaryState';

const VESSEL = { lat: -27.19509, lon: 153.10555 };

describe('SET_GPS merges only what the action carries', () => {
    it('a same-tick setLat + setLon pair keeps BOTH coordinates', () => {
        let s = initialDiaryState;
        s = diaryReducer(s, { type: 'SET_GPS', lat: VESSEL.lat });
        s = diaryReducer(s, { type: 'SET_GPS', lon: VESSEL.lon });
        expect(s.lat).toBe(VESSEL.lat);
        expect(s.lon).toBe(VESSEL.lon);
    });

    it('a post-await locationName write leaves the coordinates alone', () => {
        let s = initialDiaryState;
        s = diaryReducer(s, { type: 'SET_GPS', lat: VESSEL.lat });
        s = diaryReducer(s, { type: 'SET_GPS', lon: VESSEL.lon });
        // The geocode resolves later — its action must carry ONLY the name.
        s = diaryReducer(s, { type: 'SET_GPS', locationName: 'Scarborough Boat Harbour' });
        expect(s.lat).toBe(VESSEL.lat);
        expect(s.lon).toBe(VESSEL.lon);
        expect(s.locationName).toBe('Scarborough Boat Harbour');
    });

    it('an explicit null still clears a coordinate — merge is by presence, not truthiness', () => {
        let s = initialDiaryState;
        s = diaryReducer(s, { type: 'SET_GPS', lat: VESSEL.lat, lon: VESSEL.lon });
        s = diaryReducer(s, { type: 'SET_GPS', lat: null, lon: null });
        expect(s.lat).toBeNull();
        expect(s.lon).toBeNull();
    });
});
