/**
 * The course frame's bearing hint (useTracerTraceLayer's 'trace-dest-hint'):
 * one thin dashed straight segment from the trace's live end, or the frame's
 * origin before the first pin, to the destination.
 *
 * Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it
 * goes direct. straight over hills. rocks, other boats, land, sea, air, you
 * name it." A Plan Your Day frame (127-PYD-3's "Plot by hand": her start and
 * the stop, no pins) must never draw it: any straight segment from the boat
 * to the stop crosses whatever is between them. The parked From/To course
 * frame keeps its hint. Pure: the hook calls it in the same place in sync().
 * Fictional places in the Solent and the Azores.
 */
import { describe, expect, it } from 'vitest';
import { destHintFeatures } from '../components/map/useTracerTraceLayer';

const ORIGIN = { lat: 50.7604, lon: -1.2985, name: 'Fixture Haven' };
const DEST = { lat: 50.7178, lon: -1.0995, name: 'Fixture Creek' };
const PIN = { lat: 50.745, lon: -1.24 };

describe('destHintFeatures: the straight bearing hint', () => {
    it('a course frame draws one straight segment from its origin, then from the last pin', () => {
        const before = destHintFeatures({ coordCaptureMode: true, destHint: true, hintFrom: ORIGIN, traceDest: DEST });
        expect(before).toHaveLength(1);
        expect(before[0].geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [ORIGIN.lon, ORIGIN.lat],
                [DEST.lon, DEST.lat],
            ],
        });
        const after = destHintFeatures({ coordCaptureMode: true, destHint: true, hintFrom: PIN, traceDest: DEST });
        expect(after[0].geometry.coordinates[0]).toEqual([PIN.lon, PIN.lat]);
    });

    it('a Plan Your Day frame draws nothing, before and after pins land', () => {
        expect(
            destHintFeatures({ coordCaptureMode: true, destHint: false, hintFrom: ORIGIN, traceDest: DEST }),
        ).toEqual([]);
        expect(destHintFeatures({ coordCaptureMode: true, destHint: false, hintFrom: PIN, traceDest: DEST })).toEqual(
            [],
        );
    });

    it('nothing outside plotting mode, with no destination or with nothing to start from', () => {
        expect(
            destHintFeatures({ coordCaptureMode: false, destHint: true, hintFrom: ORIGIN, traceDest: DEST }),
        ).toEqual([]);
        expect(destHintFeatures({ coordCaptureMode: true, destHint: true, hintFrom: ORIGIN, traceDest: null })).toEqual(
            [],
        );
        expect(destHintFeatures({ coordCaptureMode: true, destHint: true, hintFrom: null, traceDest: DEST })).toEqual(
            [],
        );
    });

    it("is called where the hint's features were, and MapHub passes the frame's kind (course only)", async () => {
        const { readFileSync } = await import('node:fs');
        const layer = readFileSync('components/map/useTracerTraceLayer.ts', 'utf8');
        // One call, in sync(), between the hint's layer install and the promote: nothing reordered.
        const install = layer.indexOf("id: 'trace-dest-hint-line'");
        const call = layer.indexOf('features: destHintFeatures({');
        const promote = layer.indexOf('── Lift the trace to the top, EVERY sync ──');
        expect(install).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(install);
        expect(promote).toBeGreaterThan(call);
        expect(layer.match(/features: destHintFeatures\(\{/g)).toHaveLength(1);
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toMatch(/useTracerTraceLayer\(\{[^}]*destHint: traceFrameKind === 'course',[^}]*\}\)/);
    });
});
