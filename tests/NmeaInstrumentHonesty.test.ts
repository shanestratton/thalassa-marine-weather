import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

describe('NMEA instrument honesty', () => {
    it('derives each sensor indicator from a real, non-dead metric', () => {
        expect(source).toContain('const gpsAvailable =');
        expect(source).toContain('const windAvailable =');
        expect(source).toContain('const depthAvailable =');
        expect(source).toContain('active={gpsAvailable}');
        expect(source).toContain('active={windAvailable}');
        expect(source).toContain('active={depthAvailable}');
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
