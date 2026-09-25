import { describe, expect, it, vi } from 'vitest';
import type { ShipLogEntry } from '../types';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import {
    cleanupUndepartedRecordings,
    type UndepartedCleanupContext,
} from '../services/shiplog/UndepartedRecordingCleanup';

const START = Date.parse('2026-09-23T00:00:00Z');
const VOYAGE = `voyage_${START}_abc123xyz`;
const OWNER = 'owner-a';
const iso = (seconds: number) => new Date(START + seconds * 1000).toISOString();

function entries(voyageId = VOYAGE): ShipLogEntry[] {
    return Array.from({ length: 7 }, (_, index) => ({
        id: `${voyageId}-${index}`,
        userId: OWNER,
        voyageId,
        timestamp: iso(index * 10),
        latitude: -20 + (index % 2 ? 3 : -3) / 111195,
        longitude: 148,
        positionFormatted: '',
        distanceNM: 0.001,
        cumulativeDistanceNM: 0,
        speedKts: 0.4,
        source: 'device',
        entryType: index === 0 || index >= 5 ? 'waypoint' : 'auto',
        waypointName:
            index === 0 ? 'Voyage Start' : index === 6 ? 'Voyage End' : index === 5 ? 'Latest Position' : undefined,
    }));
}

function summary(overrides: Partial<VoyageSummary> = {}): VoyageSummary {
    return {
        voyageId: VOYAGE,
        entryCount: 7,
        startedAt: iso(0),
        endedAt: iso(60),
        departedAt: null,
        totalDistanceNM: 0,
        avgSpeedKts: 0.4,
        hasManual: false,
        isPlannedRoute: false,
        isImported: false,
        firstLat: -20,
        firstLon: 148,
        lastLat: -20,
        lastLon: 148,
        firstIsOnWater: true,
        landFraction: 0,
        spanM: 6,
        ...overrides,
    };
}

function context() {
    return {
        ownerId: OWNER,
        isCurrent: vi.fn(() => true),
        isIdle: vi.fn<UndepartedCleanupContext['isIdle']>().mockResolvedValue(true),
        readComplete: vi.fn<UndepartedCleanupContext['readComplete']>().mockImplementation(async (id) => entries(id)),
        remove: vi.fn<UndepartedCleanupContext['remove']>().mockResolvedValue(true),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

describe('undeparted recording cleanup orchestration', () => {
    it('removes a completely read, idle, stationary recording through the guarded deletion path', async () => {
        const ctx = context();
        await expect(cleanupUndepartedRecordings([summary()], ctx)).resolves.toEqual([VOYAGE]);
        expect(ctx.readComplete).toHaveBeenCalledExactlyOnceWith(VOYAGE);
        expect(ctx.isIdle).toHaveBeenCalledTimes(2);
        expect(ctx.remove).toHaveBeenCalledExactlyOnceWith(VOYAGE, ctx.isCurrent);
        expect(ctx.isIdle.mock.invocationCallOrder[0]).toBeLessThan(ctx.readComplete.mock.invocationCallOrder[0]);
        expect(ctx.readComplete.mock.invocationCallOrder[0]).toBeLessThan(ctx.isIdle.mock.invocationCallOrder[1]);
        expect(ctx.isIdle.mock.invocationCallOrder[1]).toBeLessThan(ctx.remove.mock.invocationCallOrder[0]);
    });

    it.each([
        ['failed complete read', null],
        ['unknown empty result', []],
        ['arrival-only tail', entries().slice(-1)],
        ['complete-looking boundaries but missing rows', [entries()[0], entries()[1], entries()[5], entries()[6]]],
    ] as Array<[string, ShipLogEntry[] | null]>)('retains %s', async (_reason, result) => {
        const ctx = context();
        ctx.readComplete.mockResolvedValue(result);
        await expect(cleanupUndepartedRecordings([summary()], ctx)).resolves.toEqual([]);
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it.each([
        ['missing earlier history', { startedAt: iso(-10) }],
        ['missing later history', { endedAt: iso(70) }],
        ['unknown start time', { startedAt: 'invalid' }],
        ['unknown end time', { endedAt: 'invalid' }],
        ['reversed summary bounds', { startedAt: iso(60), endedAt: iso(0) }],
    ] as Array<[string, Partial<VoyageSummary>]>)('retains uncertain time coverage: %s', async (_reason, change) => {
        const ctx = context();
        await expect(cleanupUndepartedRecordings([summary(change)], ctx)).resolves.toEqual([]);
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it.each([
        ['authored note absent from summary', { notes: 'Checked the bilge' }],
        ['actual movement absent from summary', { speedKts: 3 }],
        ['another owner in full rows', { userId: 'owner-b' }],
    ] as Array<[string, Partial<ShipLogEntry>]>)('uses full evidence to protect %s', async (_reason, change) => {
        const ctx = context();
        const full = entries();
        full[3] = { ...full[3], ...change };
        ctx.readComplete.mockResolvedValue(full);
        await expect(cleanupUndepartedRecordings([summary()], ctx)).resolves.toEqual([]);
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it('does not read a voyage whose active/paused/handoff state is not safely idle', async () => {
        const ctx = context();
        ctx.isIdle.mockResolvedValue(false);
        await expect(cleanupUndepartedRecordings([summary()], ctx)).resolves.toEqual([]);
        expect(ctx.readComplete).not.toHaveBeenCalled();
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it('checks the real footprint when a cloud summary includes the generated no-GPS Start', async () => {
        const ctx = context();
        const full = entries();
        full[0] = {
            ...full[0],
            latitude: 0,
            longitude: 0,
            speedKts: 0,
            distanceNM: 0,
            cumulativeDistanceNM: 0,
            positionFormatted: 'Acquiring position...',
        };
        ctx.readComplete.mockResolvedValue(full);
        await expect(
            cleanupUndepartedRecordings([summary({ firstLat: 0, firstLon: 0, spanM: 10_000_000 })], ctx),
        ).resolves.toEqual([VOYAGE]);
        full[3] = { ...full[3], latitude: -21 };
        await expect(
            cleanupUndepartedRecordings([summary({ firstLat: 0, firstLon: 0, spanM: 10_000_000 })], ctx),
        ).resolves.toEqual([]);
        expect(ctx.remove).toHaveBeenCalledOnce();
    });

    it('rechecks idle state after the read and protects a resumed voyage', async () => {
        const ctx = context();
        ctx.isIdle.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await expect(cleanupUndepartedRecordings([summary()], ctx)).resolves.toEqual([]);
        expect(ctx.readComplete).toHaveBeenCalledOnce();
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it('does no work for an already stale owner/start generation', async () => {
        const ctx = context();
        ctx.isCurrent.mockReturnValue(false);
        await expect(cleanupUndepartedRecordings([summary()], ctx)).resolves.toEqual([]);
        expect(ctx.isIdle).not.toHaveBeenCalled();
        expect(ctx.readComplete).not.toHaveBeenCalled();
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it('drops a full read when ownership or the start generation changes while it is pending', async () => {
        const read = deferred<ShipLogEntry[]>();
        const ctx = context();
        ctx.readComplete.mockReturnValue(read.promise);
        const cleanup = cleanupUndepartedRecordings([summary()], ctx);
        await vi.waitFor(() => expect(ctx.readComplete).toHaveBeenCalledOnce());
        ctx.isCurrent.mockReturnValue(false);
        read.resolve(entries());
        await expect(cleanup).resolves.toEqual([]);
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it('protects a generation change during the final idle check', async () => {
        const idle = deferred<boolean>();
        const ctx = context();
        ctx.isIdle.mockResolvedValueOnce(true).mockReturnValueOnce(idle.promise);
        const cleanup = cleanupUndepartedRecordings([summary()], ctx);
        await vi.waitFor(() => expect(ctx.isIdle).toHaveBeenCalledTimes(2));
        ctx.isCurrent.mockReturnValue(false);
        idle.resolve(true);
        await expect(cleanup).resolves.toEqual([]);
        expect(ctx.remove).not.toHaveBeenCalled();
    });

    it('passes a live guard into deletion so a new start can cancel before acceptance', async () => {
        const commit = deferred<void>();
        const ctx = context();
        ctx.remove.mockImplementation(async (_id, canDelete) => {
            await commit.promise;
            return canDelete();
        });
        const cleanup = cleanupUndepartedRecordings([summary()], ctx);
        await vi.waitFor(() => expect(ctx.remove).toHaveBeenCalledOnce());
        ctx.isCurrent.mockReturnValue(false);
        commit.resolve();
        await expect(cleanup).resolves.toEqual([]);
    });

    it.each(['read', 'idle', 'delete-rejected', 'delete-false'])(
        'retains records after %s failure',
        async (failure) => {
            const ctx = context();
            if (failure === 'read') ctx.readComplete.mockRejectedValue(new Error('offline'));
            if (failure === 'idle') ctx.isIdle.mockRejectedValue(new Error('storage unavailable'));
            if (failure === 'delete-rejected') ctx.remove.mockRejectedValue(new Error('tombstone failed'));
            if (failure === 'delete-false') ctx.remove.mockResolvedValue(false);
            await expect(cleanupUndepartedRecordings([summary()], ctx)).resolves.toEqual([]);
            if (failure === 'read' || failure === 'idle') expect(ctx.remove).not.toHaveBeenCalled();
        },
    );

    it('bounds work to three nominated candidates and does not read ineligible summaries', async () => {
        const ctx = context();
        const candidates = Array.from({ length: 5 }, (_, index) => summary({ voyageId: `voyage_${START}_r${index}` }));
        const skipped = [
            summary({ voyageId: 'default_voyage' }),
            summary({ hasManual: true }),
            summary({ departedAt: iso(20) }),
            summary({ passageGroupId: 'passage-a' }),
            summary({ entryCount: 10_000 }),
        ];
        const expected = candidates.slice(0, 3).map((row) => row.voyageId);
        await expect(cleanupUndepartedRecordings([...skipped, ...candidates], ctx)).resolves.toEqual(expected);
        expect(ctx.readComplete.mock.calls.map(([id]) => id)).toEqual(expected);
        expect(ctx.remove).toHaveBeenCalledTimes(3);
    });
});
