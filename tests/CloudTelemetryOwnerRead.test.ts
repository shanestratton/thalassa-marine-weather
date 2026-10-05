/**
 * One boat's cloud row (2026-10-05): the weather for a crewed boat reads her
 * skipper's row, and the account's own boat reads strictly its own. Without an
 * owner the read is exactly as before (own row, else the freshest crewed
 * boat), which is what the Ship's Log callers rely on. Fictional ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    eq: vi.fn(),
}));
vi.mock('../services/supabase', () => {
    const query = (rows: () => Record<string, unknown>[]) => ({
        eq: (column: string, value: unknown) => {
            db.eq(column, value);
            return query(() => rows().filter((row) => row[column] === value));
        },
        order: () => ({ limit: async () => ({ data: rows(), error: null }) }),
    });
    return {
        supabase: { from: () => ({ select: () => query(() => db.rows) }) },
        getCurrentUserId: async () => 'crew-kim',
    };
});
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { getState: () => ({ connectionStatus: 'disconnected' }), ingestRemote: vi.fn(), clearRemote: vi.fn() },
}));
vi.mock('../services/PiTelemetryService', () => ({ PiTelemetryService: { isPresent: () => false } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => false }));

import { CloudTelemetryService } from '../services/CloudTelemetryService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const row = (owner: string, minutesAgo: number) => ({
    owner_id: owner,
    boat_id: `boat-${owner}`,
    source: 'pi',
    device_label: owner,
    reported_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    lat: -19.1,
    lon: 147.6,
});

describe('cloud telemetry, one boat at a time', () => {
    beforeEach(() => {
        setAuthIdentityScope('crew-kim');
        db.eq.mockClear();
        db.rows = [row('skipper-wd', 1), row('crew-kim', 5), row('skipper-tern', 0)];
    });

    it('a skipper’s id reads her row only', async () => {
        const reading = await CloudTelemetryService.readOnce('skipper-wd');
        expect(db.eq).toHaveBeenCalledWith('owner_id', 'skipper-wd');
        expect(reading?.ownerId).toBe('skipper-wd');
    });

    it("'self' reads strictly the account's own row, and none is none", async () => {
        expect((await CloudTelemetryService.readOnce('self'))?.ownerId).toBe('crew-kim');
        expect(db.eq).toHaveBeenCalledWith('owner_id', 'crew-kim');
        db.rows = [row('skipper-wd', 1)];
        expect(await CloudTelemetryService.readOnce('self')).toBeNull();
    });

    it('without an owner it reads as it always has: own row, else the freshest crewed boat', async () => {
        expect((await CloudTelemetryService.readOnce())?.ownerId).toBe('crew-kim');
        db.rows = [row('skipper-wd', 1), row('skipper-tern', 0)];
        expect((await CloudTelemetryService.readOnce())?.ownerId).toBe('skipper-tern');
        expect(db.eq).not.toHaveBeenCalled();
    });
});
