/**
 * Equipment's detail page stays current, and its edits change only what was
 * edited (126-B9c; binder audit 2026-10-09: EQ-4).
 *
 * Shane, 2026-10-02: "if i change something on one machine, it is not
 * reflected in the other". Shared binders made two writers on one row normal:
 * the skipper on the iPad, the crew on a phone.
 *
 * BinderLiveSync.test.tsx's harness: a realtime payload from the socket goes
 * into the real LocalDatabase (Filesystem is the global mock), through the
 * real LocalEquipmentService binder read, onto the open page. Only the socket
 * and the sync engine are fakes. The other device is simulated by its realtime
 * events.
 *
 * Fictional gear only: a 'Watermaker' and a 'Windlass', on no particular coast.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem } from '../types';

const rt = vi.hoisted(() => ({
    /** table → the newest open channel's postgres_changes callback */
    bindings: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = {
                on: (_kind: string, filter: { table: string }, callback: (payload: unknown) => void) => {
                    rt.bindings.set(filter.table, callback);
                    return api;
                },
                subscribe: () => api,
            };
            return api;
        },
        removeChannel: vi.fn(),
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    forceFullPull: vi.fn().mockResolvedValue(0),
}));
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        pullFromCloud: vi.fn().mockResolvedValue(0),
        getDownloadUrl: vi.fn(async (uri: string) => uri),
        openDownload: vi.fn().mockResolvedValue(undefined),
        markForSync: vi.fn(),
        markDeleted: vi.fn(),
        pendingCount: 0,
    },
}));
vi.mock('../utils/equipmentPdfExport', () => ({ exportEquipmentPdf: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    getById,
    getFullQueue,
    initLocalDatabase,
    mergePulledRecords,
    prunePulledTable,
} from '../services/vessel/LocalDatabase';
import { LocalEquipmentService } from '../services/vessel/LocalEquipmentService';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { toast } from '../components/Toast';
import { EquipmentList } from '../components/vessel/EquipmentList';

// The edit sheet's keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

const NOW = '2026-10-09T01:00:00.000Z';
const REMOVED = 'Removed on another device';
const REMOVED_NOTHING_SAVED = 'This item was removed on another device. Nothing was saved.';
let accountCounter = 0;

function equipment(id: string, owner: string, name: string, extra: Partial<EquipmentItem> = {}): EquipmentItem {
    return {
        id,
        user_id: owner,
        equipment_name: name,
        category: 'Plumbing',
        make: 'Fictional Pumps',
        model: 'WM-40',
        serial_number: 'WM-0001',
        installation_date: '2024-03-01',
        warranty_expiry: null,
        manual_uri: null,
        notes: 'Flush the membrane weekly',
        created_at: NOW,
        updated_at: NOW,
        ...extra,
    };
}

async function signIn(userId: string): Promise<void> {
    act(() => setAuthIdentityScope(userId));
    await initLocalDatabase(userId);
}

async function channelFor(table: string): Promise<(payload: unknown) => void> {
    // The hook subscribes after a real 300 ms delay.
    await waitFor(() => expect(rt.bindings.has(table)).toBe(true), { timeout: 5000 });
    return rt.bindings.get(table)!;
}

/** What the socket delivers from the other device: the row for UPDATE, its id for DELETE. */
async function deliver(eventType: 'UPDATE' | 'DELETE', row: { id: string }): Promise<void> {
    const callback = await channelFor('equipment_register');
    const payload =
        eventType === 'DELETE'
            ? { eventType, new: {}, old: { id: row.id } }
            : { eventType, new: { ...row, updated_at: new Date().toISOString() }, old: {} };
    await act(async () => {
        callback(payload);
    });
}

/** Every message any toast showed, in order. */
function toasted(): string[] {
    return [
        ...vi.mocked(toast.success).mock.calls,
        ...vi.mocked(toast.error).mock.calls,
        ...vi.mocked(toast.info).mock.calls,
    ].map((call) => String(call[0]));
}

/** Open the list, then the item's detail page. */
async function openDetail(name: string): Promise<void> {
    render(<EquipmentList onBack={vi.fn()} />);
    fireEvent.click(await screen.findByText(name));
    await screen.findByRole('button', { name: 'Back to equipment list' });
    // Live from here on: the page's realtime channel has joined.
    await channelFor('equipment_register');
}

const equipmentUpdates = () =>
    getFullQueue().filter((item) => item.table_name === 'equipment_register' && item.mutation_type === 'UPDATE');

beforeEach(() => {
    localStorage.clear();
    // The vessel files already live in Library (see LocalDatabaseOutbox.test.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    rt.bindings.clear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    accountCounter += 1;
});

afterEach(() => {
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('the open detail page follows changes made on another device', () => {
    it("shows the crew's new notes on 'Watermaker' within the same page", async () => {
        const me = `skipper-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('equipment_register', [equipment('e-wm', me, 'Watermaker')]);
        await openDetail('Watermaker');
        expect(screen.getByText('Flush the membrane weekly')).toBeInTheDocument();

        await deliver('UPDATE', equipment('e-wm', me, 'Watermaker', { notes: 'Membrane replaced, log the hours' }));

        expect(await screen.findByText('Membrane replaced, log the hours')).toBeInTheDocument();
        expect(screen.queryByText('Flush the membrane weekly')).not.toBeInTheDocument();
        // Still the detail page, not the list.
        expect(screen.getByRole('button', { name: 'Back to equipment list' })).toBeInTheDocument();
    });

    it('closes, saying so, when the item is deleted on another device', async () => {
        const me = `skipper-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('equipment_register', [
            equipment('e-wm', me, 'Watermaker'),
            equipment('e-wl', me, 'Windlass', { serial_number: 'WL-0007' }),
        ]);
        await openDetail('Watermaker');

        await deliver('DELETE', { id: 'e-wm' });

        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Back to equipment list' })).not.toBeInTheDocument(),
        );
        expect(toasted()).toContain(REMOVED);
        // Back on the list, which still holds the Windlass and not the Watermaker.
        expect(screen.getByText('Windlass')).toBeInTheDocument();
        expect(screen.queryByText('Watermaker')).not.toBeInTheDocument();
    });

    it("never says 'removed on another device' when this page deleted it", async () => {
        const me = `skipper-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('equipment_register', [equipment('e-wm', me, 'Watermaker')]);
        await openDetail('Watermaker');

        fireEvent.click(screen.getByRole('button', { name: 'Delete Watermaker' }));

        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Back to equipment list' })).not.toBeInTheDocument(),
        );
        expect(toasted()).not.toContain(REMOVED);
    });
});

describe('an edit changes only the fields it changed', () => {
    it("the skipper's serial fix keeps the crew's notes made while the sheet was open", async () => {
        const me = `skipper-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('equipment_register', [
            equipment('e-wl', me, 'Windlass', { serial_number: 'WL-0007', notes: 'Gypsy worn' }),
        ]);
        const update = vi.spyOn(LocalEquipmentService, 'update');
        await openDetail('Windlass');

        fireEvent.click(screen.getByRole('button', { name: 'Edit equipment' }));
        fireEvent.change(screen.getByLabelText('Serial number'), { target: { value: 'WL-0008' } });
        // Meanwhile the crew rewrite the notes on a phone.
        await deliver(
            'UPDATE',
            equipment('e-wl', me, 'Windlass', { serial_number: 'WL-0007', notes: 'Gypsy replaced' }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Save equipment changes' }));

        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        expect(update).toHaveBeenCalledWith('e-wl', { serial_number: 'WL-0008' });
        const queued = equipmentUpdates();
        expect(queued).toHaveLength(1);
        expect(Object.keys(JSON.parse(queued[0].payload)).sort()).toEqual(['serial_number', 'updated_at']);

        // Both changes survive, here and on the page.
        await waitFor(() =>
            expect(LocalEquipmentService.getAll().find((item) => item.id === 'e-wl')).toMatchObject({
                serial_number: 'WL-0008',
                notes: 'Gypsy replaced',
            }),
        );
        expect(await screen.findByText('WL-0008')).toBeInTheDocument();
        expect(screen.getByText('Gypsy replaced')).toBeInTheDocument();
        expect(toasted()).toContain('Equipment updated');
    });

    it('a Save with nothing changed writes nothing and says nothing', async () => {
        const me = `skipper-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('equipment_register', [equipment('e-wm', me, 'Watermaker')]);
        const update = vi.spyOn(LocalEquipmentService, 'update');
        await openDetail('Watermaker');

        fireEvent.click(screen.getByRole('button', { name: 'Edit equipment' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save equipment changes' }));

        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Save equipment changes' })).not.toBeInTheDocument(),
        );
        expect(update).not.toHaveBeenCalled();
        expect(equipmentUpdates()).toEqual([]);
        expect(toasted()).toEqual([]);
    });

    it('a Save onto an item deleted elsewhere says nothing was saved, never "Equipment updated"', async () => {
        const me = `skipper-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('equipment_register', [equipment('e-wm', me, 'Watermaker')]);
        await openDetail('Watermaker');

        fireEvent.click(screen.getByRole('button', { name: 'Edit equipment' }));
        fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Pre-filter changed' } });
        // A sync's deletion sweep removes it here before the page hears of it.
        await act(async () => {
            await prunePulledTable('equipment_register', new Set());
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save equipment changes' }));

        await waitFor(() => expect(toasted()).toContain(REMOVED_NOTHING_SAVED));
        expect(toasted()).not.toContain('Equipment updated');
        // One message, not two: the closing page does not add 'Removed on another device'.
        expect(toasted()).not.toContain(REMOVED);
        expect(equipmentUpdates()).toEqual([]);
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Back to equipment list' })).not.toBeInTheDocument(),
        );
        expect(screen.queryByRole('button', { name: 'Save equipment changes' })).not.toBeInTheDocument();
    });
});

describe('a binder changing hands is not a deletion', () => {
    /** The crew's snapshot of what the skipper shares: Equipment, or nothing. */
    function shareEquipment(crew: string, skipper: string, equipmentShared: boolean): void {
        localStorage.setItem(
            `thalassa_shared_binders_v1::user%3A${crew}`,
            JSON.stringify({
                version: 1,
                userId: crew,
                confirmedAt: NOW,
                skippers: equipmentShared
                    ? [
                          {
                              ownerId: skipper,
                              vesselName: 'Fictional Boat',
                              lastAcceptedAt: NOW,
                              registers: { equipment: { read: true, write: true } },
                          },
                      ]
                    : [],
            }),
        );
        act(() => reloadSharedBindersFromStorage());
    }

    const detailClosed = () =>
        waitFor(() => expect(screen.queryByRole('button', { name: 'Back to equipment list' })).not.toBeInTheDocument());

    it("the crew's own 'Windlass' page closes quietly when the skipper starts sharing Equipment", async () => {
        const crew = `crew-${accountCounter}`;
        const skipper = `skipper-${accountCounter}`;
        await signIn(crew);
        await mergePulledRecords('equipment_register', [
            equipment('e-wl', crew, 'Windlass', { serial_number: 'WL-0007' }),
            equipment('e-wm', skipper, 'Watermaker'),
        ]);
        await openDetail('Windlass');

        shareEquipment(crew, skipper, true);

        await detailClosed();
        // The skipper's register now: their Watermaker, and nothing was deleted.
        expect(await screen.findByText('Watermaker')).toBeInTheDocument();
        expect(screen.queryByText('Windlass')).not.toBeInTheDocument();
        expect(toasted()).not.toContain(REMOVED);
        expect(getById('equipment_register', 'e-wl')).toMatchObject({ user_id: crew });
    });

    it("the skipper's 'Watermaker' page closes quietly when sharing stops and the sync drops their rows", async () => {
        const crew = `crew-${accountCounter}`;
        const skipper = `skipper-${accountCounter}`;
        await signIn(crew);
        shareEquipment(crew, skipper, true);
        await mergePulledRecords('equipment_register', [
            equipment('e-wl', crew, 'Windlass', { serial_number: 'WL-0007' }),
            equipment('e-wm', skipper, 'Watermaker'),
        ]);
        await openDetail('Watermaker');

        // The pull no longer sees the skipper's rows, so its sweep drops them
        // here, and then the snapshot says Equipment is no longer shared.
        await act(async () => {
            await prunePulledTable('equipment_register', new Set(['e-wl']));
        });
        shareEquipment(crew, skipper, false);

        await detailClosed();
        expect(await screen.findByText('Windlass')).toBeInTheDocument();
        expect(getById('equipment_register', 'e-wm')).toBeNull();
        expect(toasted()).not.toContain(REMOVED);
    });

    it("the crew's 'Windlass' moved into the skipper's register by the server closes quietly", async () => {
        const crew = `crew-${accountCounter}`;
        const skipper = `skipper-${accountCounter}`;
        await signIn(crew);
        await mergePulledRecords('equipment_register', [
            equipment('e-wl', crew, 'Windlass', { serial_number: 'WL-0007' }),
        ]);
        await openDetail('Windlass');

        // The server re-homes the row to the skipper; the echo carries the new owner.
        await deliver('UPDATE', equipment('e-wl', skipper, 'Windlass', { serial_number: 'WL-0007' }));

        await detailClosed();
        expect(getById('equipment_register', 'e-wl')).toMatchObject({ user_id: skipper });
        expect(toasted()).not.toContain(REMOVED);
    });

    it('still says so when the skipper deletes the open item from the shared register', async () => {
        const crew = `crew-${accountCounter}`;
        const skipper = `skipper-${accountCounter}`;
        await signIn(crew);
        shareEquipment(crew, skipper, true);
        await mergePulledRecords('equipment_register', [
            equipment('e-wm', skipper, 'Watermaker'),
            equipment('e-wl', skipper, 'Windlass', { serial_number: 'WL-0007' }),
        ]);
        await openDetail('Watermaker');

        await deliver('DELETE', { id: 'e-wm' });

        await detailClosed();
        expect(toasted()).toContain(REMOVED);
        expect(screen.getByText('Windlass')).toBeInTheDocument();
    });
});
