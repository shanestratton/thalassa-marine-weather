/**
 * Checklists: run one list and keep the run (132-B16; binder audit
 * 2026-10-09: CHK-03, CHK-04, CHK-06, CHK-09, CHK-10, CHK-11, CHK-13).
 *
 * - Each checklist has its own Run; a run holds that list only (the ⋮'s
 *   Run checklist ran every list on the page at once).
 * - Every tick is kept on the phone, so a run comes back after the app
 *   closes or crashes; leaving one with anything checked asks first.
 * - Complete and Add can no longer fire twice.
 * - A new checklist's items go under it, not under the page's first list.
 * - Past runs says when each list was last run and what failed.
 * - Search keeps a matched checklist's items; the run overlay is the shared
 *   OverlayPortal.
 *
 * The page's harness from ChecklistsPage.test.tsx (service mocked); the run
 * draft is the real one, in jsdom's localStorage. Fictional lists only:
 * 'Pre-departure', 'Heavy weather' and an empty 'Anchoring'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllMock, getRunsMock } = vi.hoisted(() => ({
    getAllMock: vi.fn(),
    getRunsMock: vi.fn(),
}));

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../../services/vessel/SyncService', () => ({ onSyncComplete: () => () => undefined }));
vi.mock('../../services/vessel/LocalChecklistService', () => ({
    LocalChecklistService: {
        getAll: getAllMock,
        getRuns: getRunsMock,
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
        saveRun: vi.fn(),
    },
}));
vi.mock('../../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: { createRepair: vi.fn().mockResolvedValue({ id: 'maintenance-task' }) },
}));
vi.mock('../../services/vessel/LocalDatabase', () => ({ generateUUID: vi.fn(() => 'run-1') }));
vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action }: { title: string; action?: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {action}
        </header>
    ),
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { ChecklistsPage } from '../../components/vessel/ChecklistsPage';
import { PastRunsSheet } from '../../components/vessel/checklists/PastRunsSheet';
import {
    LocalChecklistService,
    type ChecklistEntry,
    type ChecklistRun,
} from '../../services/vessel/LocalChecklistService';
import { LocalMaintenanceService } from '../../services/vessel/LocalMaintenanceService';
import { authScopedStorageKey } from '../../services/authIdentityScope';
import { toast } from '../../components/Toast';

const at = '2026-01-01T00:00:00.000Z';
function entry(id: string, text: string, headingId: string | null, order: number): ChecklistEntry {
    return {
        id,
        type: headingId ? 'detail' : 'heading',
        text,
        heading_id: headingId,
        order,
        created_at: at,
        updated_at: at,
    };
}
const LISTS = [
    entry('h-pre', 'Pre-departure', null, 1),
    entry('i-bilge', 'Bilge pump', 'h-pre', 2),
    entry('i-seacocks', 'Close seacocks', 'h-pre', 3),
    entry('h-heavy', 'Heavy weather', null, 4),
    entry('i-jib', 'Storm jib hanked on', 'h-heavy', 5),
    entry('h-anchor', 'Anchoring', null, 6),
];

const DRAFT_KEY = () => authScopedStorageKey('thalassa_checklist_run_draft_v1');
const saveRun = vi.mocked(LocalChecklistService.saveRun);
const create = vi.mocked(LocalChecklistService.create);
const createRepair = vi.mocked(LocalMaintenanceService.createRepair);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const runDialog = () => screen.queryByRole('dialog', { name: 'Run checklist' });
/** Whether the ⋮ offers Past runs (it also holds Reorder items, 132-B20); leaves the menu closed. */
const pastRunsInMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    const offered = !!screen.queryByRole('menuitem', { name: 'Past runs' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    return offered;
};
const tick = (text: string, from: 'not checked' | 'passed' | 'failed') => {
    const to = from === 'not checked' ? 'passed' : from === 'passed' ? 'failed' : 'not checked';
    fireEvent.click(screen.getByRole('button', { name: `${text}: ${from}. Change status to ${to}` }));
};

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getAllMock.mockReturnValue(LISTS);
    getRunsMock.mockReturnValue([]);
    saveRun.mockResolvedValue({} as never);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('Run: one checklist at a time (CHK-03)', () => {
    it('each checklist with items has its own Run, and an empty one has none', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Run Pre-departure' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Run Heavy weather' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Run Anchoring' })).not.toBeInTheDocument();
        // The ⋮'s run-everything is gone; with no past runs it holds Reorder
        // items alone (132-B20), never Past runs.
        expect(pastRunsInMenu()).toBe(false);
    });

    it('a run holds that list only, under its name', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Heavy weather' }));

        const dialog = runDialog()!;
        expect(within(dialog).getByText('Heavy weather')).toBeInTheDocument();
        expect(within(dialog).getByText('Storm jib hanked on')).toBeInTheDocument();
        expect(within(dialog).queryByText('Bilge pump')).not.toBeInTheDocument();
        expect(within(dialog).getByText('0/1 checked')).toBeInTheDocument();
    });

    it('the run overlay is the shared OverlayPortal, on the modal layer (CHK-13)', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        expect(runDialog()!.getAttribute('data-overlay-layer')).toBe('modal');
        expect(runDialog()!.className).not.toMatch(/z-999/);
    });
});

describe('Run: kept on the phone as it is ticked (CHK-04)', () => {
    it('comes back, ticks and flags as they were, when the page opens after the app closed', () => {
        const first = render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');
        tick('Bilge pump', 'passed');
        fireEvent.click(screen.getByRole('button', { name: 'Flag Bilge pump for repair and maintenance' }));
        tick('Close seacocks', 'not checked');
        // The app goes: no Complete, no Exit.
        first.unmount();

        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(runDialog()).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'Bilge pump: failed. Change status to not checked' }),
        ).toBeInTheDocument();
        expect(
            screen
                .getByRole('button', { name: 'Flag Bilge pump for repair and maintenance' })
                .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(
            screen.getByRole('button', { name: 'Close seacocks: passed. Change status to failed' }),
        ).toBeInTheDocument();
        expect(toast.info).toHaveBeenCalledWith('Your “Pre-departure” run is back where you left it');
    });

    it('keeps the run on the phone under this account, with each tick', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');

        const draft = JSON.parse(localStorage.getItem(DRAFT_KEY())!);
        expect(draft).toMatchObject({
            id: 'run-1',
            heading_id: 'h-pre',
            heading: 'Pre-departure',
            owner_user_id: null,
        });
        expect(draft.items.map((i: { entry_id: string; status: string }) => [i.entry_id, i.status])).toEqual([
            ['i-bilge', 'pass'],
            ['i-seacocks', 'unchecked'],
        ]);
    });

    it('Exit with nothing checked closes at once and keeps nothing', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        fireEvent.click(screen.getByRole('button', { name: 'Exit checklist run' }));

        expect(screen.queryByRole('dialog', { name: 'Discard this run?' })).not.toBeInTheDocument();
        expect(runDialog()).not.toBeInTheDocument();
        expect(localStorage.getItem(DRAFT_KEY())).toBeNull();
    });

    it('Exit with something checked asks first; Keep going keeps the run', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');
        fireEvent.click(screen.getByRole('button', { name: 'Exit checklist run' }));

        const ask = screen.getByRole('dialog', { name: 'Discard this run?' });
        expect(ask).toHaveTextContent('1 of 2 checked so far. Nothing from this run is kept.');
        expect(within(ask).getByRole('button', { name: 'Keep going' })).toHaveFocus();
        fireEvent.click(within(ask).getByRole('button', { name: 'Keep going' }));

        expect(screen.queryByRole('dialog', { name: 'Discard this run?' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Bilge pump: passed. Change status to failed' })).toBeInTheDocument();
        expect(localStorage.getItem(DRAFT_KEY())).not.toBeNull();
    });

    it('Escape asks the same question; Discard run closes it, keeps nothing, and saves nothing', () => {
        const first = render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Exit checklist run' }), { key: 'Escape' });

        fireEvent.click(screen.getByRole('button', { name: 'Discard run' }));
        expect(runDialog()).not.toBeInTheDocument();
        expect(localStorage.getItem(DRAFT_KEY())).toBeNull();
        expect(saveRun).not.toHaveBeenCalled();

        first.unmount();
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(runDialog()).not.toBeInTheDocument();
    });

    it('a phone that will not keep the run says so, once', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('full', 'QuotaExceededError');
        });
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');
        tick('Close seacocks', 'not checked');

        const warnings = vi
            .mocked(toast.error)
            .mock.calls.filter(([message]) => String(message).startsWith("This phone couldn't keep the run"));
        expect(warnings).toEqual([
            ["This phone couldn't keep the run as you go. Complete it before you close the app.", 8000],
        ]);
    });
});

describe('Complete: saves the run once, with when it began (CHK-04, CHK-06)', () => {
    it('saves the list, its start and its end, then lets the phone copy go', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-13T04:05:00.000Z'));
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');
        vi.setSystemTime(new Date('2026-10-13T04:20:00.000Z'));

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        });

        expect(saveRun).toHaveBeenCalledTimes(1);
        const run = saveRun.mock.calls[0][0];
        expect(run).toMatchObject({
            id: 'run-1',
            started_at: '2026-10-13T04:05:00.000Z',
            completed_at: '2026-10-13T04:20:00.000Z',
        });
        expect(run.items.map((i) => [i.heading_id, i.heading, i.text, i.status])).toEqual([
            ['h-pre', 'Pre-departure', 'Bilge pump', 'pass'],
            ['h-pre', 'Pre-departure', 'Close seacocks', 'unchecked'],
        ]);
        expect(runDialog()).not.toBeInTheDocument();
        expect(localStorage.getItem(DRAFT_KEY())).toBeNull();
    });

    it('a phone clock set back mid-run never saves a run completed before it began', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-13T04:05:00.000Z'));
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        vi.setSystemTime(new Date('2026-10-13T03:00:00.000Z'));

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        });

        expect(saveRun.mock.calls[0][0]).toMatchObject({
            started_at: '2026-10-13T04:05:00.000Z',
            completed_at: '2026-10-13T04:05:00.000Z',
        });
    });

    it('a save that fails keeps the run on screen and on the phone, and says so', async () => {
        saveRun.mockRejectedValueOnce(new Error('[LocalDB] Failed to write vessel_checklist_runs.json'));
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        });

        expect(toast.error).toHaveBeenCalledWith("Couldn't save this run. Try Complete again.");
        expect(runDialog()).toBeInTheDocument();
        expect(localStorage.getItem(DRAFT_KEY())).not.toBeNull();
        expect(screen.getByRole('button', { name: 'Complete checklist run' })).toBeEnabled();
    });

    it('Complete greys while it saves, and Exit waits for it', async () => {
        const save = deferred<ChecklistRun>();
        saveRun.mockReturnValueOnce(save.promise);
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');

        fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        const complete = screen.getByRole('button', { name: 'Complete checklist run' });
        expect(complete).toBeDisabled();
        expect(complete.getAttribute('aria-busy')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: 'Exit checklist run' }));
        expect(screen.queryByRole('dialog', { name: 'Discard this run?' })).not.toBeInTheDocument();

        await act(async () => {
            save.resolve({} as ChecklistRun);
        });
        expect(saveRun).toHaveBeenCalledTimes(1);
        expect(runDialog()).not.toBeInTheDocument();
    });

    it('a tick while Complete saves is not taken, and the saved run never comes back to be completed again', async () => {
        const repair = deferred<Awaited<ReturnType<typeof createRepair>>>();
        createRepair.mockReturnValueOnce(repair.promise);
        const first = render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');
        tick('Bilge pump', 'passed');
        fireEvent.click(screen.getByRole('button', { name: 'Flag Bilge pump for repair and maintenance' }));

        // A tick in the same moment as Complete, before the page re-renders:
        // the guard, not just the inert items, keeps it out.
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
            tick('Close seacocks', 'not checked');
        });

        // Saved, and the phone's copy let go; the repair is still being added,
        // so the run is on screen with its items inert.
        expect(saveRun).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem(DRAFT_KEY())).toBeNull();
        const seacocks = screen.getByRole('button', { name: 'Close seacocks: not checked. Change status to passed' });
        const flag = screen.getByRole('button', { name: 'Flag Bilge pump for repair and maintenance' });
        expect(seacocks).toBeDisabled();
        expect(flag).toBeDisabled();
        fireEvent.click(seacocks);
        fireEvent.click(flag);
        expect(localStorage.getItem(DRAFT_KEY())).toBeNull();

        await act(async () => {
            repair.resolve({ id: 'maintenance-task' } as Awaited<ReturnType<typeof createRepair>>);
        });
        expect(runDialog()).not.toBeInTheDocument();
        expect(localStorage.getItem(DRAFT_KEY())).toBeNull();
        expect(saveRun.mock.calls[0][0].items.map((i) => [i.text, i.status, i.flagged_rm])).toEqual([
            ['Bilge pump', 'fail', true],
            ['Close seacocks', 'unchecked', false],
        ]);

        // The app opens again: nothing to bring back, nothing to complete twice.
        first.unmount();
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(runDialog()).not.toBeInTheDocument();
        expect(toast.info).not.toHaveBeenCalledWith('Your “Pre-departure” run is back where you left it');
        expect(saveRun).toHaveBeenCalledTimes(1);
        expect(createRepair).toHaveBeenCalledTimes(1);
    });
});

describe('Add: once per tap, and under the checklist just made (CHK-06, CHK-09)', () => {
    function openAddForm() {
        fireEvent.click(screen.getByRole('button', { name: 'Add checklist or item' }));
    }

    it('a double tap on Add item adds the item once', async () => {
        const made = deferred<ChecklistEntry>();
        create.mockReturnValueOnce(made.promise);
        render(<ChecklistsPage onBack={vi.fn()} />);
        openAddForm();
        fireEvent.change(screen.getByLabelText(/Check item/), { target: { value: 'Gas locker closed' } });

        const add = screen.getByRole('button', { name: 'Add item' });
        // Both taps land before the page re-renders (one act), so the guard,
        // not just the greyed button, keeps the second one out.
        await act(async () => {
            fireEvent.click(add);
            fireEvent.click(add);
        });
        expect(add).toBeDisabled();

        await act(async () => {
            made.resolve(entry('i-gas', 'Gas locker closed', 'h-pre', 7));
        });
        expect(create).toHaveBeenCalledTimes(1);
        expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it("a new checklist's items go under it, not under the page's first list", async () => {
        const anchoring2 = entry('h-night', 'Night passage', null, 7);
        create.mockResolvedValueOnce(anchoring2);
        render(<ChecklistsPage onBack={vi.fn()} />);
        openAddForm();
        fireEvent.click(screen.getByRole('button', { name: 'Checklist' }));
        fireEvent.change(screen.getByLabelText(/Checklist name/), { target: { value: 'Night passage' } });
        getAllMock.mockReturnValue([...LISTS, anchoring2]);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add checklist' }));
        });

        // The form has turned to Item, under the list just made.
        expect(screen.getByRole('button', { name: 'Item' }).getAttribute('aria-pressed')).toBe('true');
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('h-night');

        create.mockResolvedValueOnce(entry('i-lights', 'Nav lights on', 'h-night', 8));
        fireEvent.change(screen.getByLabelText(/Check item/), { target: { value: 'Nav lights on' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
        });
        expect(create).toHaveBeenLastCalledWith({ type: 'detail', text: 'Nav lights on', heading_id: 'h-night' });

        // Closed and opened again, Add still starts there.
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        openAddForm();
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('h-night');
    });
});

describe('Search keeps a matched checklist whole (CHK-11)', () => {
    it("a checklist's name shows all its items; an item's text shows that item", () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        const search = screen.getByRole('textbox', { name: 'Search checklists' });

        fireEvent.change(search, { target: { value: 'pre-dep' } });
        expect(screen.getByText('Bilge pump')).toBeInTheDocument();
        expect(screen.getByText('Close seacocks')).toBeInTheDocument();
        expect(screen.queryByText('Storm jib hanked on')).not.toBeInTheDocument();

        fireEvent.change(search, { target: { value: 'bilge' } });
        expect(screen.getByText('Bilge pump')).toBeInTheDocument();
        expect(screen.queryByText('Close seacocks')).not.toBeInTheDocument();
    });

    it('a run started while searching still holds the whole list', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.change(screen.getByRole('textbox', { name: 'Search checklists' }), { target: { value: 'bilge' } });
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        expect(within(runDialog()!).getByText('Close seacocks')).toBeInTheDocument();
    });
});

describe('Past runs: when each list was last run, and what failed (CHK-10)', () => {
    // Local times, so the sheet reads the same in any time zone.
    const lastRun = new Date(2026, 9, 13, 14, 5).toISOString();
    const earlierRun = new Date(2026, 9, 2, 9, 10).toISOString();
    const item = (entryId: string, text: string, status: 'pass' | 'fail' | 'unchecked', flagged = false) => ({
        entry_id: entryId,
        heading: 'Pre-departure',
        heading_id: 'h-pre',
        text,
        status,
        flagged_rm: flagged,
        notes: '',
    });
    const RUNS: ChecklistRun[] = [
        {
            id: 'r-earlier',
            started_at: earlierRun,
            completed_at: earlierRun,
            items: [item('i-bilge', 'Bilge pump', 'pass'), item('i-seacocks', 'Close seacocks', 'pass')],
        },
        {
            id: 'r-last',
            started_at: lastRun,
            completed_at: lastRun,
            items: [item('i-bilge', 'Bilge pump', 'fail', true), item('i-seacocks', 'Close seacocks', 'pass')],
        },
    ];

    it('opens from the ⋮ once there is a run, and reads the last run, its failures and the one before', async () => {
        getRunsMock.mockReturnValue(RUNS);
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Past runs' }));

        const sheet = await screen.findByRole('dialog', { name: 'Past runs' });
        const pre = within(sheet).getByRole('region', { name: 'Pre-departure' });
        expect(pre).toHaveTextContent('Last run Tue 13 Oct 2026, 14:05');
        expect(pre).toHaveTextContent('1 passed · 1 failed');
        const failed = within(pre).getAllByRole('list', { name: 'Failed' })[0];
        expect(failed).toHaveTextContent('Bilge pump');
        expect(failed).toHaveTextContent('flagged for repair');
        expect(within(pre).getByRole('list', { name: 'Earlier runs' })).toHaveTextContent(
            'Fri 2 Oct 2026, 09:10All 2 passed',
        );
        // A list with items and no run yet says so; an empty one is not mentioned.
        expect(sheet).toHaveTextContent('Not run yet: Heavy weather');
        expect(sheet).not.toHaveTextContent('Anchoring');
    });

    it('shows the last run and four before it, and says how many more there are', () => {
        const many: ChecklistRun[] = Array.from({ length: 7 }, (_, i) => {
            const when = new Date(2026, 9, 1 + i, 8, 0).toISOString();
            return { ...RUNS[0], id: `r-${i}`, started_at: when, completed_at: when };
        });
        render(<PastRunsSheet runs={many} entries={LISTS} onClose={vi.fn()} />);

        const pre = screen.getByRole('region', { name: 'Pre-departure' });
        expect(pre).toHaveTextContent('Last run Wed 7 Oct 2026, 08:00');
        expect(within(pre).getByRole('list', { name: 'Earlier runs' }).children).toHaveLength(4);
        expect(pre).toHaveTextContent('2 earlier runs not shown');
    });

    it('a list carried untouched through a pre-132 run of every list is still not run yet', () => {
        const legacy: ChecklistRun = {
            id: 'r-legacy',
            started_at: lastRun,
            completed_at: lastRun,
            items: [
                { ...item('i-bilge', 'Bilge pump', 'pass'), heading_id: undefined },
                { ...item('i-seacocks', 'Close seacocks', 'pass'), heading_id: undefined },
                {
                    ...item('i-jib', 'Storm jib hanked on', 'unchecked'),
                    heading: 'Heavy weather',
                    heading_id: undefined,
                },
            ],
        };
        render(<PastRunsSheet runs={[legacy]} entries={LISTS} onClose={vi.fn()} />);

        expect(screen.getByRole('region', { name: 'Pre-departure' })).toHaveTextContent(
            'Last run Tue 13 Oct 2026, 14:05',
        );
        expect(screen.queryByRole('region', { name: 'Heavy weather' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Past runs' })).toHaveTextContent('Not run yet: Heavy weather');
    });

    it('a run in progress on another device is not a past run', () => {
        getRunsMock.mockReturnValue([{ ...RUNS[0], id: 'r-open', completed_at: null }]);
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(pastRunsInMenu()).toBe(false);
    });

    it('with nothing to reorder, the ⋮ waits for the first completed run', () => {
        getAllMock.mockReturnValue(LISTS.filter((e) => e.id !== 'i-seacocks'));
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Page actions' })).not.toBeInTheDocument();
    });

    it('Past runs joins the ⋮ once the first run is completed', async () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(pastRunsInMenu()).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Run Pre-departure' }));
        tick('Bilge pump', 'not checked');
        saveRun.mockImplementationOnce(async (run) => {
            getRunsMock.mockReturnValue([run]);
            return run;
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        });

        await waitFor(() => expect(pastRunsInMenu()).toBe(true));
    });
});
