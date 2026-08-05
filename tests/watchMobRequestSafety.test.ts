import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
    values: {} as Record<string, string>,
    failWrites: false,
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: storage.values[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            if (storage.failWrites) throw new Error('Preferences unavailable');
            storage.values[key] = value;
        }),
    },
}));

import {
    _resetWatchMobRequestSafetyForTests,
    claimWatchMobRequest,
    evaluateWatchMobRequest,
    WATCH_MOB_REQUEST_FUTURE_SKEW_MS,
    WATCH_MOB_REQUEST_TTL_MS,
} from '../services/native/watchMobRequestSafety';

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

function envelope(requestedAtMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        mobRequestVersion: 1,
        mobRequestId: REQUEST_ID,
        mobRequestedAtMs: requestedAtMs,
        mobRequestTtlMs: WATCH_MOB_REQUEST_TTL_MS,
        mobRequestExpiresAtMs: requestedAtMs + WATCH_MOB_REQUEST_TTL_MS,
        deliveryChannel: 'queued',
        ...overrides,
    };
}

describe('Watch MOB request safety boundary', () => {
    beforeEach(async () => {
        await _resetWatchMobRequestSafetyForTests();
        for (const key of Object.keys(storage.values)) delete storage.values[key];
        storage.failWrites = false;
    });

    it('accepts a complete request only inside the explicit 15-second window', () => {
        const requestedAtMs = 2_000_000;

        expect(
            evaluateWatchMobRequest(envelope(requestedAtMs), requestedAtMs + WATCH_MOB_REQUEST_TTL_MS),
        ).toMatchObject({
            accepted: true,
            requestId: REQUEST_ID,
            deliveryChannel: 'queued',
        });
        expect(evaluateWatchMobRequest(envelope(requestedAtMs), requestedAtMs + WATCH_MOB_REQUEST_TTL_MS + 1)).toEqual({
            accepted: false,
            reason: 'expired',
            requestId: REQUEST_ID,
        });
    });

    it('fails closed on future, mismatched-expiry, and legacy timestamp-only envelopes', () => {
        const nowMs = 2_000_000;

        expect(evaluateWatchMobRequest(envelope(nowMs + WATCH_MOB_REQUEST_FUTURE_SKEW_MS + 1), nowMs)).toEqual({
            accepted: false,
            reason: 'future-dated',
            requestId: REQUEST_ID,
        });
        expect(evaluateWatchMobRequest(envelope(nowMs, { mobRequestExpiresAtMs: nowMs + 60_000 }), nowMs)).toEqual({
            accepted: false,
            reason: 'invalid-envelope',
            requestId: REQUEST_ID,
        });
        expect(evaluateWatchMobRequest({ type: 'mob', watchTimestamp: nowMs / 1_000 }, nowMs)).toEqual({
            accepted: false,
            reason: 'invalid-envelope',
        });
        expect(evaluateWatchMobRequest(null, nowMs)).toEqual({
            accepted: false,
            reason: 'invalid-envelope',
        });
    });

    it('serializes simultaneous claims so immediate and queued copies cannot both win', async () => {
        const [first, second] = await Promise.all([
            claimWatchMobRequest(REQUEST_ID, 2_000_000),
            claimWatchMobRequest(REQUEST_ID, 2_000_001),
        ]);

        expect(first).toEqual({ duplicate: false, durable: true });
        expect(second).toEqual({ duplicate: true, durable: true });
    });

    it('retains an in-process claim if native Preferences cannot persist it', async () => {
        storage.failWrites = true;

        expect(await claimWatchMobRequest(REQUEST_ID, 2_000_000)).toEqual({ duplicate: false, durable: false });
        expect(await claimWatchMobRequest(REQUEST_ID, 2_000_001)).toEqual({ duplicate: true, durable: false });
    });
});
