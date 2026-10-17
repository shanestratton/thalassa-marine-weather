/**
 * Maintenance gets a search (132-B19). The suggested schedule alone seeds
 * forty tasks, and the page had no way to find one but scrolling.
 *
 *  - It finds a task by its name, its notes or its category, in every group,
 *    Paused and Fixed too, which open on what they find;
 *  - nothing found says so, and asks for another word;
 *  - the header's counts stay the whole list's;
 *  - it shows only once there is something to search, as on the sibling pages.
 *
 * MaintenanceSchedules132.test.tsx's harness: the real LocalDatabase
 * (Filesystem is the global mock) under the real LocalMaintenanceService and
 * the real page; only the socket, the sync engine and the PDFs are fakes.
 * Fictional boat 'Kestrel' out of Horta.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';

const AT = '2026-10-01T01:00:00.000Z';
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
        next_due_date: '2099-03-14',
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: AT,
        updated_at: AT,
        ...patch,
    };
}

async function openKestrel(tasks: MaintenanceTask[]): Promise<void> {
    accountCounter += 1;
    me = `skipper-kestrel-search-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
    await mergePulledRecords(
        'maintenance_tasks',
        tasks.map((t) => ({ ...t, user_id: me })),
    );
    render(<MaintenanceHub onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByTestId('shimmer')).toHaveLength(0));
}

const search = () => screen.getByRole('textbox', { name: 'Search maintenance tasks' });
const listed = () =>
    screen
        .queryAllByRole('button', { name: /^Options for / })
        .map((button) => button.getAttribute('aria-label')!.replace('Options for ', ''));
const chips = () => screen.getByTestId('maintenance-status-chips').textContent ?? '';

const KESTREL = [
    task('t-oil', 'Change engine oil', { description: 'Shell Rimula 15W-40, 7 litres' }),
    task('t-impeller', 'Replace raw-water impeller'),
    task('t-flares', 'Check flare expiry', { category: 'Safety' }),
    task('t-shrouds', 'Inspect shrouds', { category: 'Rigging' }),
    task('t-halyards', 'Wash halyards', { category: 'Rigging', is_active: false }),
    task('t-gland', 'Stern gland weeping', {
        category: 'Repair',
        trigger_type: 'daily',
        interval_value: null,
        is_active: false,
        last_completed: AT,
    }),
];

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
});

afterEach(() => {
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('Maintenance search', () => {
    it('finds a task by its name, its notes or its category; the counts stay the whole list', async () => {
        await openKestrel(KESTREL);
        expect(listed()).toEqual([
            'Change engine oil',
            'Replace raw-water impeller',
            'Check flare expiry',
            'Inspect shrouds',
        ]);
        const before = chips();

        fireEvent.change(search(), { target: { value: 'impeller' } });
        expect(listed()).toEqual(['Replace raw-water impeller']);
        // By what is written in its notes.
        fireEvent.change(search(), { target: { value: 'RIMULA' } });
        expect(listed()).toEqual(['Change engine oil']);
        // By its category: every rigging task, the paused one too, its group opened.
        fireEvent.change(search(), { target: { value: 'rigging' } });
        expect(listed()).toEqual(['Inspect shrouds', 'Wash halyards']);
        expect(screen.getByRole('button', { name: 'Paused (1)' })).toHaveAttribute('aria-expanded', 'true');
        expect(chips()).toBe(before);

        fireEvent.change(search(), { target: { value: '' } });
        expect(listed()).toEqual([
            'Change engine oil',
            'Replace raw-water impeller',
            'Check flare expiry',
            'Inspect shrouds',
        ]);
        // Closed again, as it was before the search.
        expect(screen.getByRole('button', { name: 'Paused (1)' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('a repair marked fixed is found under Fixed, opened', async () => {
        await openKestrel(KESTREL);
        fireEvent.change(search(), { target: { value: 'gland' } });
        expect(listed()).toEqual(['Stern gland weeping']);
        expect(screen.getByRole('button', { name: 'Fixed (1)' })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.queryByRole('button', { name: /^Paused/ })).toBeNull();
    });

    it('nothing found says so, and asks for another word', async () => {
        await openKestrel(KESTREL);
        fireEvent.change(search(), { target: { value: 'watermaker' } });
        expect(listed()).toEqual([]);
        expect(screen.getByText('No tasks match')).toBeInTheDocument();
        expect(screen.getByText('Try a different search term.')).toBeInTheDocument();
        expect(screen.queryByText('No maintenance tasks')).toBeNull();
    });

    it('shows only once there is something to search', async () => {
        await openKestrel([]);
        expect(await screen.findByText('No maintenance tasks')).toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: 'Search maintenance tasks' })).toBeNull();
    });
});
