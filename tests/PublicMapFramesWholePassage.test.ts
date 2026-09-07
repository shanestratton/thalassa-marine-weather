/**
 * A frame computed before the route arrives is not a frame.
 *
 * The public map's refocus effect is keyed on the trip selector's focusKey,
 * which resolves well before the passage line — they are separate fetches. It
 * marked the key done on the FIRST run regardless, so the run that found no
 * coordinates fell to the telemetry fallback (fly to the boat at z12) and then
 * never ran again when the route turned up.
 *
 * Shane, 2026-09-05, on a Newport → Lady Musgrave passage: "we are going to
 * lady musgrave, but it does not show up on the current map on the public
 * page. is this possible. or is it going to cost too much moula????"
 *
 * It costs nothing. The public map already renders
 * mapbox://styles/mapbox/satellite-streets-v12 — the full satellite style —
 * and Mapbox GL bills per map load, not per tile, so a wider frame is free.
 * The imagery was there the whole time; the camera was pointed at the first
 * hundred metres of the passage.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('src/components/MapContainer.tsx', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('public map framing', () => {
    it('comes back when there is finally something to frame', () => {
        expect(code).toMatch(/const framable = allCoords\.length > 1;/);
        const effect = code.slice(code.indexOf('const framable ='));
        const deps = effect.slice(effect.indexOf('}, ['), effect.indexOf('}, [') + 40);
        expect(deps).toContain('framable');
    });

    it('does not claim the focus key on a run with nothing to fit', () => {
        const effect = code.slice(code.indexOf('const applyFocus'));
        const body = effect.slice(0, effect.indexOf('const frame = requestAnimationFrame'));
        // Guarded, not unconditional — the empty run must stay provisional.
        expect(body).toMatch(/if \(coords\.length >= 1\) lastFocusKey\.current = focusKey;/);
        const claim = body.indexOf('lastFocusKey.current = focusKey');
        const fallback = body.indexOf('if (fallback) map.flyTo');
        expect(claim).toBeLessThan(fallback);
        expect(body.slice(fallback)).not.toContain('lastFocusKey.current = focusKey');
    });

    it('frames the PLANNED line, not only the sailed track', () => {
        // A passage that has not departed has no track at all; without the
        // plan line there is nothing to frame but the mooring.
        const all = code.slice(code.indexOf('const allCoords = useMemo'));
        expect(all.slice(0, 300)).toContain('...(passageLine ?? [])');
    });

    it('already uses the full satellite style, so none of this costs more', () => {
        // Against `src`, not `code`: the // comment stripper eats the one in
        // `mapbox://`, which is a good reminder that a URL is not a comment.
        expect(src).toContain("satellite: 'mapbox://styles/mapbox/satellite-streets-v12'");
    });
});
