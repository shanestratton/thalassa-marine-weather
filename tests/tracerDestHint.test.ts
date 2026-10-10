/**
 * The course frame's dashed bearing hint (127-PYD-3 decision 6).
 *
 * Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it
 * goes direct. straight over hills." The 'trace-dest-hint' is one straight
 * segment from the last pin (or the start) to the destination: over whatever
 * island lies between. It stays for the parked course frame, and is never
 * drawn for a Plan Your Day frame, before or after pins land.
 */
import { describe, expect, it } from 'vitest';
import { destHintFeatures } from '../components/map/useTracerTraceLayer';

const START = { lat: -20.265, lon: 148.719, name: 'Airlie Bay' };
const CID = { lat: -20.24511, lon: 148.94836, name: 'Cid Harbour' };
const PIN = { lat: -20.29, lon: 148.8 };

describe('destHintFeatures', () => {
    it('a course frame gets one straight bearing line from the live end to the destination', () => {
        expect(destHintFeatures({ coordCaptureMode: true, destHint: true, hintFrom: START, traceDest: CID })).toEqual([
            {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [START.lon, START.lat],
                        [CID.lon, CID.lat],
                    ],
                },
            },
        ]);
    });

    it('a Plan Your Day frame gets nothing, before the first pin and after pins land', () => {
        for (const hintFrom of [START, PIN]) {
            expect(destHintFeatures({ coordCaptureMode: true, destHint: false, hintFrom, traceDest: CID })).toEqual([]);
        }
    });

    it('nothing outside the plotter, and nothing without both ends', () => {
        expect(destHintFeatures({ coordCaptureMode: false, destHint: true, hintFrom: START, traceDest: CID })).toEqual(
            [],
        );
        expect(destHintFeatures({ coordCaptureMode: true, destHint: true, hintFrom: null, traceDest: CID })).toEqual(
            [],
        );
        expect(destHintFeatures({ coordCaptureMode: true, destHint: true, hintFrom: START, traceDest: null })).toEqual(
            [],
        );
    });
});
