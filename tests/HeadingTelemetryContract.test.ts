import { describe, expect, it } from 'vitest';
import { readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';

const now = Date.parse('2026-09-24T07:00:00Z');

describe('true bow heading across the existing Pi telemetry JSON contract', () => {
    it('preserves zero north and original sensor time in the LAN body and cloud extra without a migration', () => {
        const snapshot = readTelemetrySnapshot(
            {
                navigation: {
                    headingTrue: { value: 0, timestamp: new Date(now - 2_000).toISOString() },
                },
            },
            () => now,
        )!;
        const body = buildTelemetryBody(snapshot, 'test-vessel');
        const expected = { heading_true_deg: 0, heading_true_at_ms: now - 2_000 };
        expect(body.extra).toEqual(expected);
        const relayed = parseTelemetryBody(body, now);
        expect(relayed.ok).toBe(true);
        if (!relayed.ok) throw new Error(relayed.error);
        expect(relayed.row.extra).toEqual(expected);
    });

    it('keeps a legacy unqualified heading separate from reference-qualified orientation', () => {
        const snapshot = readTelemetrySnapshot({ navigation: { headingMagnetic: { value: Math.PI / 2 } } }, () => now)!;
        const body = buildTelemetryBody(snapshot, 'test-vessel');
        const relayed = parseTelemetryBody(body, now);
        if (!relayed.ok) throw new Error(relayed.error);
        expect(relayed.row.heading_deg).toBe(90);
        expect(relayed.row.extra.heading_true_deg).toBeUndefined();
        expect(relayed.row.extra.heading_true_at_ms).toBeUndefined();
    });
});
