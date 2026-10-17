import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    rows: new Map<string, Record<string, unknown>>(),
    calls: [] as Array<{ table: string; op: string; data: unknown }>,
    error: null as null | { code: string },
    session: 'owner',
    wait: null as null | (() => Promise<void>),
}));
vi.mock('../../services/supabase', () => ({
    supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: h.session } } } }) },
        from: (table: string) => {
            let op = 'select',
                payload: Record<string, unknown> = {},
                columns = '';
            const filters: Array<[string, unknown]> = [];
            const chain = {
                insert(data: Record<string, unknown>) {
                    op = 'insert';
                    payload = data;
                    return chain;
                },
                update(data: Record<string, unknown>) {
                    op = 'update';
                    payload = data;
                    return chain;
                },
                delete() {
                    op = 'delete';
                    return chain;
                },
                select(value: string) {
                    columns = value;
                    return chain;
                },
                eq(key: string, value: unknown) {
                    filters.push([key, value]);
                    return chain;
                },
                limit() {
                    return chain;
                },
                then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
                    return (async () => {
                        h.calls.push({ table, op, data: op === 'select' ? columns : { ...payload } });
                        await h.wait?.();
                        if (h.error) return { data: null, error: h.error };
                        const hits = [...h.rows.values()].filter((row) =>
                            filters.every(([key, value]) => row[key] === value),
                        );
                        if (op === 'insert') {
                            if (h.rows.has(String(payload.sighting_id)))
                                return { data: null, error: { code: '23505' } };
                            h.rows.set(String(payload.sighting_id), { ...payload });
                        }
                        if (op === 'update') hits.forEach((row) => Object.assign(row, payload));
                        if (op === 'delete') hits.forEach((row) => h.rows.delete(String(row.sighting_id)));
                        return { data: op === 'select' || op === 'update' ? hits : null, error: null };
                    })().then(resolve, reject);
                },
            };
            return chain;
        },
    },
}));
vi.mock('../../services/sightings/sightingSync', () => ({
    scheduleSightingDrain: vi.fn(),
    ensureSightingSyncTriggers: vi.fn(),
}));
import { setAuthIdentityScope, getAuthIdentityScope } from '../../services/authIdentityScope';
import {
    editPrivateCatch,
    loadPrivateCatch,
    drainPrivateCatches,
    validatePrivateCatch,
} from '../../services/sightings/privateCatch';
import {
    getLocalSighting,
    memoryBackend,
    purgeSightingsForUser,
    putLocalSighting,
    setSightingStoreBackend,
    updateLocalSighting,
} from '../../services/sightings/sightingStore';
import {
    adoptSignedOutSightings,
    editSighting,
    logSighting,
    NO_VESSEL,
} from '../../services/sightings/sightingService';
import { toDarwinCore } from '../../services/sightings/darwinCore';
import { PrivateCatchFields } from '../../components/sightings/PrivateCatchFields';
const details = { species: 'PRIVATE FISH SENTINEL', length_cm: 42.5, disposition: 'released' as const };
async function fish(serverKnown = false) {
    const row = await logSighting({
        group: 'fish',
        context: null,
        vessel: NO_VESSEL,
        visibility: 'private',
        eventAt: Date.now(),
    });
    if (serverKnown) {
        row.sync = { ...row.sync, serverKnown: true, op: null, state: 'synced' };
        await putLocalSighting(row);
    }
    return row;
}
beforeEach(() => {
    setSightingStoreBackend(memoryBackend());
    setAuthIdentityScope('owner');
    h.rows.clear();
    h.calls = [];
    h.error = null;
    h.session = 'owner';
    h.wait = null;
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});
describe('private catch boundary', () => {
    it('validates optional fields, bounded lengths and disposition', () => {
        expect(validatePrivateCatch({ species: '  Cod  ', length_cm: 42.56, disposition: 'kept' })).toEqual({
            ok: true,
            value: { species: 'Cod', length_cm: 42.6, disposition: 'kept' },
        });
        expect(validatePrivateCatch({})).toEqual({ ok: true, value: null });
        for (const input of [
            { species: 'x'.repeat(121) },
            { length_cm: 0 },
            { length_cm: 2001 },
            { length_cm: NaN },
            { disposition: 'unknown' },
            { observer_id: 'other' },
        ])
            expect(validatePrivateCatch(input).ok).toBe(false);
    });
    it('saves signed-out privately, then queues only explicit adoption', async () => {
        setAuthIdentityScope(null);
        const row = await fish();
        expect((await editPrivateCatch(row.id, details)).record?.privateCatchSync?.pending).toBe(false);
        setAuthIdentityScope('owner');
        expect(await getLocalSighting(row.id, 'owner')).toBeNull();
        await adoptSignedOutSightings();
        const adopted = await getLocalSighting(row.id, 'owner');
        expect(adopted?.privateCatch).toEqual(details);
        expect(adopted?.privateCatchSync?.pending).toBe(true);
        expect(adopted?.row.visibility).toBe('private');
    });
    it('refuses cached crew fish, non-fish, a deleted row and another account', async () => {
        const row = await fish();
        for (const change of [
            { row: { ...row.row, observer_id: 'crew' } },
            { row: { ...row.row, taxon_group: 'whale' as const } },
            { sync: { ...row.sync, op: 'delete' as const } },
        ]) {
            await putLocalSighting({ ...row, ...change });
            expect((await editPrivateCatch(row.id, details)).record).toBeNull();
        }
        setAuthIdentityScope('other');
        expect(await loadPrivateCatch(row.id)).toBeNull();
        expect(h.calls).toHaveLength(0);
    });
    it('never recreates a purged record or accepts a stale identity update', async () => {
        const row = await fish(),
            scope = getAuthIdentityScope();
        const snapshot = (await editPrivateCatch(row.id, details)).record!;
        await purgeSightingsForUser('owner');
        expect((await editPrivateCatch(row.id, details)).record).toBeNull();
        await putLocalSighting(snapshot); // a late ordinary base/photo response
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatch).toBeUndefined();
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatchSync).toBeUndefined();
        setAuthIdentityScope('other');
        expect(await updateLocalSighting(row.id, scope, (current) => current)).toBeNull();
    });
    it('does not adopt anonymous catch data after an account changes during the list read', async () => {
        const memory = memoryBackend();
        setSightingStoreBackend(memory);
        setAuthIdentityScope(null);
        const row = await fish();
        await editPrivateCatch(row.id, details);
        setAuthIdentityScope('owner');
        let release!: () => void;
        setSightingStoreBackend({
            ...memory,
            getAll: async () => {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                return memory.getAll();
            },
        });
        const adoption = adoptSignedOutSightings();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        setAuthIdentityScope('other');
        release();
        expect(await adoption).toBe(0);
        expect((await getLocalSighting(row.id, null))?.privateCatch).toEqual(details);
        expect(await getLocalSighting(row.id, 'owner')).toBeNull();
    });
    it('preserves a newer private edit through an older base/photo sync write', async () => {
        const row = await fish();
        await editPrivateCatch(row.id, details);
        await putLocalSighting({ ...row, vernacularName: 'Updated shared label' });
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatch).toEqual(details);
    });
    it('aborts a private write waiting on storage when identity changes or a purge wins', async () => {
        const memory = memoryBackend();
        let release!: () => void;
        setSightingStoreBackend({
            ...memory,
            update: async (id, change, signal) => {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                return memory.update!(id, change, signal);
            },
        });
        const row = await fish();
        const pending = editPrivateCatch(row.id, details);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        setAuthIdentityScope('other');
        release();
        expect((await pending).record).toBeNull();
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatch).toBeUndefined();
        setAuthIdentityScope('owner');
        const deleted = editPrivateCatch(row.id, details);
        await purgeSightingsForUser('owner');
        release();
        expect((await deleted).record).toBeNull();
        expect(await getLocalSighting(row.id, 'owner')).toBeNull();
    });
    it('clears the sidecar when regrouped, without changing shared visibility defaults', async () => {
        const row = await fish(true);
        await editPrivateCatch(row.id, details);
        await drainPrivateCatches();
        await editSighting(row.id, { taxon_group: 'seabird' });
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatch).toBeNull();
        await drainPrivateCatches();
        expect(h.rows.size).toBe(0);
    });
    it('sends only sidecar fields, uses mutable-only PATCH and can clear all details', async () => {
        const row = await fish(true);
        await editPrivateCatch(row.id, details);
        await drainPrivateCatches();
        expect(h.rows.get(row.id)).toEqual({ sighting_id: row.id, observer_id: 'owner', ...details });
        await editPrivateCatch(row.id, { ...details, length_cm: 50 });
        await drainPrivateCatches();
        expect(h.calls.find((call) => call.op === 'update')?.data).toEqual({ ...details, length_cm: 50 });
        expect(h.calls.every((call) => call.table === 'sighting_catches')).toBe(true);
        const confirmed = (await getLocalSighting(row.id, 'owner'))!;
        await putLocalSighting({ ...confirmed, privateCatchSync: { ...confirmed.privateCatchSync!, pending: true } });
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatchSync?.pending).toBe(false);
        await editPrivateCatch(row.id, null);
        await drainPrivateCatches();
        expect(h.rows.size).toBe(0);
    });
    it('waits for the base row and the matching real session', async () => {
        const row = await fish();
        await editPrivateCatch(row.id, details);
        await drainPrivateCatches();
        expect(h.calls).toHaveLength(0);
        await putLocalSighting({
            ...(await getLocalSighting(row.id, 'owner'))!,
            sync: { ...row.sync, serverKnown: true },
        });
        h.session = 'other';
        await drainPrivateCatches();
        expect(h.calls).toHaveLength(0);
    });
    it('bounds a private outbox round to 50 records', async () => {
        for (let i = 0; i < 55; i++) {
            const row = await fish(true);
            await editPrivateCatch(row.id, details);
        }
        expect(await drainPrivateCatches()).toEqual({ sent: 50, remaining: 5 });
        expect(h.calls).toHaveLength(50);
        expect(await drainPrivateCatches()).toEqual({ sent: 5, remaining: 0 });
    });
    it('keeps offline/unmigrated catch data pending without failing the base sighting', async () => {
        const row = await fish(true);
        await editPrivateCatch(row.id, details);
        h.error = { code: 'PGRST205' };
        await drainPrivateCatches();
        const saved = await getLocalSighting(row.id, 'owner');
        expect(saved?.sync.state).toBe('synced');
        expect(saved?.privateCatchSync).toMatchObject({ pending: true, error: 'not-available', attempts: 1 });
        await drainPrivateCatches();
        expect(h.calls).toHaveLength(1);
    });
    it('an edit made during a request wins; account deletion during a private read cannot resurrect it', async () => {
        const row = await fish(true);
        await editPrivateCatch(row.id, details);
        let release!: () => void;
        h.wait = () =>
            new Promise<void>((resolve) => {
                release = resolve;
            });
        const drain = drainPrivateCatches();
        await vi.waitFor(() => expect(h.calls).toHaveLength(1));
        await editPrivateCatch(row.id, { ...details, length_cm: 60 });
        release();
        await drain;
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatchSync?.pending).toBe(true);
        h.wait = null;
        await drainPrivateCatches();
        const read = loadPrivateCatch(row.id);
        h.wait = () =>
            new Promise<void>((resolve) => {
                release = resolve;
            });
        await vi.waitFor(() => expect(h.calls.some((call) => call.op === 'select')).toBe(true));
        await purgeSightingsForUser('owner');
        release();
        await read;
        expect(await getLocalSighting(row.id, 'owner')).toBeNull();
    });
    it('renders only actual owner fish fields, autosaves on blur and hides synchronously on identity change', async () => {
        const row = await fish(),
            onRecord = vi.fn();
        render(<PrivateCatchFields record={row} onRecord={onRecord} />);
        fireEvent.change(screen.getByLabelText('Catch species'), { target: { value: 'Cod' } });
        fireEvent.blur(screen.getByLabelText('Catch species'));
        await waitFor(() => expect(onRecord).toHaveBeenCalled());
        expect((await getLocalSighting(row.id, 'owner'))?.privateCatch?.species).toBe('Cod');
        act(() => {
            setAuthIdentityScope('other');
        });
        expect(screen.queryByText('Catch details · only you')).toBeNull();
    });
    it('private values are absent from shared row, Darwin Core and the existing visibility choice', async () => {
        const row = await fish();
        await editPrivateCatch(row.id, details);
        const saved = (await getLocalSighting(row.id, 'owner'))!;
        expect(JSON.stringify(saved.row)).not.toContain(details.species);
        expect(JSON.stringify(toDarwinCore(saved.row))).not.toContain(details.species);
        expect(saved.row.visibility).toBe('private');
        expect(saved.row.scientific_name).toBeNull();
        expect(saved.row.occurrence_remarks).toBeNull();
    });
});
