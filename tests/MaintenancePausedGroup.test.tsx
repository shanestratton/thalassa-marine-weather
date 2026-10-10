/**
 * Pause and Resume in R&M (126-B7a, binder audit MAINT-12; Shane 2026-10-09:
 * "check all of the binders to make sure that they are at the same standard
 * as the rest of the app").
 *
 * deactivateTask existed and nothing called it, so the header's "N paused"
 * chip, the spoken summary's "N paused" and the card's 'Paused' label could
 * never show. Now the service sheet has History · Edit · Pause, a paused task
 * leaves the list and its counts for a collapsed Paused group at the bottom,
 * and opening it offers Resume in place of Log service.
 *
 * BinderLiveSync.test.tsx's harness: the real LocalDatabase (Filesystem is
 * the global mock) under the real LocalMaintenanceService and the real page.
 * Fictional boat 'Kestrel' out of Horta; tasks 'Raw-water impeller',
 * 'Antifouling' and 'Rig inspection'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceTask } from '../types';

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = { on: () => api, subscribe: () => api };
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
}));
vi.mock('../services/MaintenancePdfService', () => ({ exportChecklist: vi.fn(), exportServiceHistory: vi.fn() }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getById, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';
import { toast } from '../components/Toast';

const NOW = '2026-10-10T01:00:00.000Z';
let accountCounter = 0;
let me = '';

function task(id: string, title: string, patch: Partial<MaintenanceTask> = {}): MaintenanceTask {
    return {
        id,
        user_id: me,
        title,
        description: null,
        category: 'Engine',
        trigger_type: 'monthly',
        interval_value: 30,
        // Long overdue: a paused task must never count as overdue.
        next_due_date: '2026-01-15',
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: NOW,
        updated_at: NOW,
        ...patch,
    };
}

async function openKestrelBinder(tasks: MaintenanceTask[]): Promise<void> {
    accountCounter += 1;
    me = `skipper-kestrel-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
    await mergePulledRecords(
        'maintenance_tasks',
        tasks.map((row) => ({ ...row, user_id: me })),
    );
    render(<MaintenanceHub onBack={vi.fn()} />);
}

const impeller = () => task('t-impeller', 'Raw-water impeller', { next_due_date: '2027-03-14' });
const antifouling = (patch: Partial<MaintenanceTask> = {}) =>
    task('t-antifoul', 'Antifouling', { category: 'Hull', trigger_type: 'annual', interval_value: 365, ...patch });
const rig = (patch: Partial<MaintenanceTask> = {}) =>
    task('t-rig', 'Rig inspection', { category: 'Rigging', ...patch });

const openSheet = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Options for ${title}` }));
const stored = (id: string) => getById<MaintenanceTask>('maintenance_tasks', id)!;

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(toast.success).mockClear();
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('paused tasks', () => {
    it('two paused: the "2 paused" chip and spoken summary, never overdue, in a collapsed Paused group', async () => {
        await openKestrelBinder([impeller(), antifouling({ is_active: false }), rig({ is_active: false })]);
        await screen.findByText('Raw-water impeller');

        const chips = await screen.findByTestId('maintenance-status-chips');
        expect(chips).toHaveTextContent('2 paused');
        expect(chips).not.toHaveTextContent('overdue');
        expect(screen.getByText(/^Tasks: .*2 paused\.$/)).toBeInTheDocument();
        expect(screen.getByText(/^Tasks: /)).not.toHaveTextContent('overdue');

        const group = screen.getByRole('button', { name: 'Paused (2)' });
        expect(group).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('Antifouling')).not.toBeInTheDocument();
        expect(screen.queryByText('Rig inspection')).not.toBeInTheDocument();

        fireEvent.click(group);
        expect(group).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText('Antifouling')).toBeInTheDocument();
        expect(screen.getByText('Rig inspection')).toBeInTheDocument();
        // The Paused group sits below every category.
        const order = [screen.getByText('Raw-water impeller'), group, screen.getByText('Antifouling')];
        expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('opening a paused task offers Resume, not Log service; Resume brings it back to the list', async () => {
        await openKestrelBinder([impeller(), antifouling({ is_active: false })]);
        fireEvent.click(await screen.findByRole('button', { name: 'Paused (1)' }));
        openSheet('Antifouling');

        const sheet = await screen.findByRole('dialog', { name: 'Antifouling' });
        expect(within(sheet).queryByRole('button', { name: 'Log service' })).not.toBeInTheDocument();
        expect(within(sheet).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'History' })).toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'Edit task' })).toBeInTheDocument();

        fireEvent.click(within(sheet).getByRole('button', { name: 'Resume' }));

        await waitFor(() => expect(stored('t-antifoul').is_active).toBe(true));
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Paused/ })).not.toBeInTheDocument());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByText('Antifouling')).toBeInTheDocument();
        expect(toast.success).toHaveBeenCalledWith('“Antifouling” resumed');
    });

    it('an active task has History · Edit · Pause over Log service; Pause moves it under Paused', async () => {
        await openKestrelBinder([impeller(), rig()]);
        await screen.findByText('Rig inspection');
        openSheet('Rig inspection');

        const sheet = await screen.findByRole('dialog', { name: 'Rig inspection' });
        expect(within(sheet).getByRole('button', { name: 'Log service' })).toBeInTheDocument();
        expect(within(sheet).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Pause' }));

        await waitFor(() => expect(stored('t-rig').is_active).toBe(false));
        expect(await screen.findByRole('button', { name: 'Paused (1)' })).toBeInTheDocument();
        expect(screen.queryByText('Rig inspection')).not.toBeInTheDocument();
        expect(toast.success).toHaveBeenCalledWith("“Rig inspection” paused. It's under Paused.");
    });

    it('every task paused: the Paused group, not "No maintenance tasks"', async () => {
        await openKestrelBinder([antifouling({ is_active: false }), rig({ is_active: false })]);

        expect(await screen.findByRole('button', { name: 'Paused (2)' })).toBeInTheDocument();
        expect(screen.queryByText('No maintenance tasks')).not.toBeInTheDocument();
        expect(screen.getByTestId('maintenance-status-chips')).toHaveTextContent('2 paused');
    });
});
