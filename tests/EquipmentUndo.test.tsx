/**
 * Equipment: Undo, then delete something else, and the restored item stays
 * (binder audit 2026-10-09, EQ-1). Undo cleared the five-second timer but left
 * its id and the pending item behind, so the NEXT delete "flushed" the item the
 * skipper had just restored: gone from storage and from every device, with no
 * message.
 *
 * BinderLiveSync.test.tsx's harness: the real LocalDatabase (Filesystem is the
 * global mock) under the real LocalEquipmentService and the real page; only the
 * socket and the sync engine are fakes. Fictional gear: 'Watermaker', 'Windlass'.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem } from '../types';

vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
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
import { initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { LocalEquipmentService } from '../services/vessel/LocalEquipmentService';
import { EquipmentList } from '../components/vessel/EquipmentList';

const NOW = '2026-10-09T01:00:00.000Z';

function gear(id: string, owner: string, name: string): EquipmentItem {
    return {
        id,
        user_id: owner,
        equipment_name: name,
        category: 'Plumbing',
        make: 'Make',
        model: 'Model',
        serial_number: 'SN-FICTIONAL',
        installation_date: null,
        warranty_expiry: null,
        manual_uri: null,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
    };
}

let account = 0;

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    account += 1;
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

async function deleteFromOptions(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `Options for ${name}` }));
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: `Delete ${name}` }));
    });
}

describe('Equipment: Undo, then another delete', () => {
    it('keeps the restored item; only the second item is deleted', async () => {
        const me = `kestrel-${account}`;
        act(() => setAuthIdentityScope(me));
        await initLocalDatabase(me);
        await mergePulledRecords('equipment_register', [
            gear('eq-watermaker', me, 'Watermaker'),
            gear('eq-windlass', me, 'Windlass'),
        ]);
        const remove = vi.spyOn(LocalEquipmentService, 'delete');

        render(<EquipmentList onBack={vi.fn()} />);
        await screen.findByText('Watermaker');
        await screen.findByText('Windlass');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        await deleteFromOptions('Watermaker');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Undo delete action' }));
        });
        // Testing Library's findBy* polls on setTimeout, which is faked here.
        expect(screen.getByText('Watermaker')).toBeInTheDocument();

        await deleteFromOptions('Windlass');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6_000);
        });
        vi.useRealTimers();

        expect(remove.mock.calls.map(([id]) => id)).toEqual(['eq-windlass']);
        const left = LocalEquipmentService.getAll().map((item) => item.equipment_name);
        expect(left).toContain('Watermaker');
        expect(left).not.toContain('Windlass');
        expect(screen.getByText('Watermaker')).toBeInTheDocument();
    });
});
