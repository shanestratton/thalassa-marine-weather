import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

describe('NMEA instrument honesty', () => {
    it('derives instrument liveness from a real, non-dead metric', () => {
        // The three-emoji sensor-status tile was retired 2026-08-08 — it
        // repeated the LIVE/Stale header and its GPS/Depth dots said nothing
        // the readings themselves didn't. What survives it is the rule those
        // dots existed to enforce: liveness is computed from metric freshness,
        // never from "the socket is open".
        expect(source).toContain('metricIsAvailable');
        expect(source).toContain('const windAvailable =');
        expect(source).toContain('isLive={windAvailable && !windStale}');
        expect(source).not.toContain('<SensorIcon');
    });

    it('never draws a hardcoded instrument reading', () => {
        // The heel capsule was wired to a literal 0 with no sensor behind it,
        // so it displayed a confident "0° STBD" for ever. If an instrument has
        // no source, it does not get a tile.
        expect(source).not.toContain('HeelCapsule');
        expect(source).not.toContain('degrees={0}');
    });

    it('shows heading for where the bow points, and COG only when making way', () => {
        // COG is GPS course made good; below a knot it is noise. The panel
        // reported 053 while the bow sat on north (Shane 2026-08-08).
        expect(source).toContain('const makingWay =');
        expect(source).toContain('value={heading.value}');
        expect(source).toContain('COG — not making way');
    });

    it('does not describe a disconnected live panel as demo data', () => {
        expect(source).toContain("? 'No feed'");
        expect(source).toContain("? 'Stale'");
        expect(source).toContain("? 'Live'");
        expect(source).toContain(": 'Waiting'");
        expect(source).not.toContain("{isConnected ? 'Live' : 'Demo'}");
    });

    it('masks dead readings and labels the declared depth reference', () => {
        expect(source).toContain("metric.freshness === 'dead' ? null : metric.value");
        expect(source).toContain('nmeaDepthReferenceLabel(state.depthReference)');
        expect(source).not.toContain('m under keel');
    });
});
