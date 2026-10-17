import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anchorSafeZoneDisplay } from '../utils/anchorSafeZoneDisplay';
import { anchorZonePosition } from '../utils/anchorSafeZone';
describe('bounded Watch companion drawing', () => {
    const frame = { latitude: 10, longitude: 179.99999, radiusM: 100 };
    it('projects the validated manual outline across the dateline into a bounded unit circle', () => {
        const vertices = [
            [-30, -30],
            [30, -30],
            [30, 30],
            [-30, 30],
        ].map(([x, y]) => anchorZonePosition(frame, x, y)!);
        const drawing = anchorSafeZoneDisplay(
            { version: 1, kind: 'polygon', anchor: { latitude: frame.latitude, longitude: frame.longitude }, vertices },
            frame,
        );
        expect(drawing.safeAreaOutline).toHaveLength(4);
        drawing.safeAreaOutline!.forEach((p, i) => {
            expect(p[0]).toBeCloseTo(i === 0 || i === 3 ? -0.3 : 0.3, 5);
            expect(Math.hypot(...p)).toBeLessThan(1);
        });
        expect(anchorSafeZoneDisplay({ version: 99 }, frame)).toEqual({});
    });
    it('copies only validated wedge angles and keeps the native companion claim restricted to the circle', () => {
        expect(
            anchorSafeZoneDisplay(
                {
                    version: 1,
                    kind: 'wedges',
                    anchor: { latitude: frame.latitude, longitude: frame.longitude },
                    exclusions: [{ startDeg: 350, sweepDeg: 20 }],
                },
                frame,
            ),
        ).toEqual({ safeAreaWedges: [[350, 20]] });
        const view = readFileSync('ios/App/ThalassaWatch Watch App/Views/AnchorWatchView.swift', 'utf8');
        expect(view).toContain('PHONE AREA · WATCH CIRCLE CHECK ONLY');
        expect(view).toContain('safeAreaDrawing(snapshot: snapshot)');
    });
});
