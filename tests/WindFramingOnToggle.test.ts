/**
 * Pressing wind always frames z9 (Shane 2026-08-22: "if someone presses
 * wind, it always zooms in to level 9, regardless of where we are on the
 * page").
 *
 * The generic activation effect only framed on the FIRST layer activation
 * and only ever zoomed IN, so wind pressed with another layer already up did
 * nothing, and wind pressed from a harbour left the camera deep. The
 * dedicated effect fires on every off→on transition, keeps the centre, and
 * reads its target from LAYER_FRAME_ZOOM so the number lives in one place.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LAYER_FRAME_ZOOM } from '../components/map/mapConstants';

const src = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
const effect = src.slice(src.indexOf('// ── Wind ALWAYS opens at its local frame'), src.indexOf('// Rain auto-play'));

describe('wind framing on toggle', () => {
    it('exists as its own effect keyed on the wind transition, not first activation', () => {
        expect(effect.length).toBeGreaterThan(0);
        expect(effect).toContain('prevWindOnRef');
        expect(effect).toContain('if (prev === null || prev === windOn || !windOn) return;');
    });

    it('resolves its zoom through the shared frame helper, not wind’s number', () => {
        // Wind alone gets wind's frame; wind in a stack gets the stack's.
        // Hard-coding wind's own number put the camera somewhere different
        // depending on WHICH toggle you tapped to build the same two-layer
        // view.
        expect(effect).toContain('frameZoomForSelection(activeLayers');
        expect(LAYER_FRAME_ZOOM.wind).toBe(9); // back to the harbour frame 2026-08-25
    });

    it('returns to the location box rather than holding the current centre', () => {
        // Reversed 2026-08-24. It used to keep the centre deliberately, which
        // meant framing wind zoomed you in on wherever you had panned to
        // instead of the water you actually selected.
        expect(effect).toContain('frameCenterRef.current');
        expect(effect).toContain('center: box ? [box.lon, box.lat]');
        // ...and the no-op test must consider the centre too, or the flight is
        // skipped while the camera sits over the wrong water at the right zoom.
        expect(effect).toContain('centreMoved');
    });

    it('stays out of Plan and embedded surfaces, and does not fire on mount', () => {
        expect(effect).toContain('if (planMode || embedded) return;');
        // prev === null is the first ready run: record, never fly.
        expect(effect).toContain('prev === null');
    });

    it('removes wind from the generic first-activation framing so two flyTos cannot fight', () => {
        const generic = src.slice(src.indexOf('const windFramesItself'), src.indexOf('const windFramesItself') + 400);
        expect(generic).toContain('!windFramesItself');
    });
});
