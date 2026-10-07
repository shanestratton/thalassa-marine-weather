/**
 * The anchor radar, drawn: where the canvas actually puts the boat and the
 * anchors, through the component, not just the offset helper.
 *
 * jsdom cannot paint a canvas, so the 2D context here is a recorder: every
 * arc and fillText is kept with its coordinates (and the alpha it was drawn
 * at), and one animation frame is run by hand.
 *
 *  - Across 180° (Fiji): an anchor at 179.9999°E and a boat at 179.9999°W are
 *    about 21 m apart. The boat must be drawn beside the anchor, not a whole
 *    world away off the edge of the screen.
 *  - Move anchor's preview: the view centres on the proposed anchor, and the
 *    anchor as it stands now is drawn faint at its offset from it.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';
import { SwingCircleCanvas } from '../components/anchor-watch/SwingCircleCanvas';
import { destinationPoint } from '../utils/navigationCalculations';

type Call = { name: string; args: unknown[]; alpha: number };

const SIZE = 300;
const CENTRE = SIZE / 2;
/** displayRadius = min(W, H) × 0.35 */
const DISPLAY_RADIUS = SIZE * 0.35;

let calls: Call[] = [];
let frames: FrameRequestCallback[] = [];

function recordingContext(): CanvasRenderingContext2D {
    const state: Record<string, unknown> = { globalAlpha: 1 };
    return new Proxy(state, {
        get(target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (prop in target) return target[prop];
            if (prop === 'createRadialGradient' || prop === 'createLinearGradient')
                return () => ({ addColorStop: () => undefined });
            if (prop === 'measureText') return () => ({ width: 10 });
            return (...args: unknown[]) => {
                calls.push({ name: prop, args, alpha: Number(target.globalAlpha) });
            };
        },
        set(target, prop, value) {
            if (typeof prop === 'string') target[prop] = value;
            return true;
        },
    }) as unknown as CanvasRenderingContext2D;
}

function snapshot(
    anchor: { latitude: number; longitude: number },
    vessel: { latitude: number; longitude: number },
    swingRadius = 40,
): AnchorWatchSnapshot {
    return {
        state: 'watching',
        anchorPosition: { ...anchor, timestamp: 0 },
        vesselPosition: { ...vessel, accuracy: 0, heading: 0, speed: 0, timestamp: 0 },
        swingRadius,
        distanceFromAnchor: 0,
        maxDistanceRecorded: 0,
        bearingToAnchor: 0,
        config: { rodeLength: 40, waterDepth: 8, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: 0,
        gpsAccuracy: 0,
        gpsQuality: 'standard',
        gpsQualityLabel: 'Standard GPS',
        guardianStatus: 'idle',
        setupError: null,
    } as AnchorWatchSnapshot;
}

/** Render once and run the first animation frame. */
function draw(element: React.ReactElement) {
    render(element);
    const frame = frames.shift();
    expect(frame).toBeDefined();
    frame!(0);
}

/** The boat's core dot: the 4 px arc. */
function vesselDot(): [number, number] {
    const dot = calls.find((call) => call.name === 'arc' && call.args[2] === 4);
    expect(dot).toBeDefined();
    return [dot!.args[0] as number, dot!.args[1] as number];
}

const anchorsDrawn = () =>
    calls
        .filter((call) => call.name === 'fillText' && call.args[0] === '⚓')
        .map((call) => ({ x: call.args[1] as number, y: call.args[2] as number, alpha: call.alpha }));

describe('SwingCircleCanvas, drawn', () => {
    beforeEach(() => {
        calls = [];
        frames = [];
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
            recordingContext()) as unknown as HTMLCanvasElement['getContext']);
        vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: SIZE,
            bottom: SIZE,
            width: SIZE,
            height: SIZE,
            toJSON: () => ({}),
        } as DOMRect);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        // ResizeObserver comes from tests/setup.ts.
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('Fiji: a boat across 180° from her anchor is drawn beside it, east of it', () => {
        const anchor = { latitude: -16.8, longitude: 179.9999 };
        const boat = { latitude: -16.8, longitude: -179.9999 };
        draw(<SwingCircleCanvas snapshot={snapshot(anchor, boat)} />);

        const [x, y] = vesselDot();
        // 0.0002° of longitude at 16.8°S is about 21.3 m; at 40 m to 105 px, 56 px east.
        const expected = 0.0002 * 111320 * Math.cos((16.8 * Math.PI) / 180) * (DISPLAY_RADIUS / 40);
        expect(x - CENTRE).toBeCloseTo(expected, 0);
        expect(y).toBeCloseTo(CENTRE, 5);
        // The anchor is at the centre, at full strength.
        expect(anchorsDrawn()).toEqual([{ x: CENTRE, y: CENTRE, alpha: 1 }]);
    });

    it('Move anchor: centres on the proposed anchor and draws the one standing now, faint, at its offset', () => {
        const anchorNow = { latitude: 60.394, longitude: 5.32 };
        // The proposal is 20 m north of where the anchor stands now; the boat
        // lies 10 m east of the proposal.
        const proposed = destinationPoint(anchorNow.latitude, anchorNow.longitude, 0, 20 / 1852);
        const boat = destinationPoint(proposed.lat, proposed.lon, 90, 10 / 1852);
        draw(
            <SwingCircleCanvas
                snapshot={snapshot(anchorNow, { latitude: boat.lat, longitude: boat.lon })}
                previewAnchor={{ latitude: proposed.lat, longitude: proposed.lon }}
            />,
        );
        const scale = DISPLAY_RADIUS / 40;

        const [proposal, standing] = anchorsDrawn();
        expect(proposal).toEqual({ x: CENTRE, y: CENTRE, alpha: 1 });
        // 20 m south of the centre on screen, at reduced strength.
        expect(standing.x).toBeCloseTo(CENTRE, 1);
        expect(standing.y - CENTRE).toBeCloseTo(20 * scale, 0);
        expect(standing.alpha).toBeLessThan(1);

        // The boat is drawn against the proposal, not the anchor standing now.
        const [x, y] = vesselDot();
        expect(x - CENTRE).toBeCloseTo(10 * scale, 0);
        expect(y).toBeCloseTo(CENTRE, 0);
    });
});
