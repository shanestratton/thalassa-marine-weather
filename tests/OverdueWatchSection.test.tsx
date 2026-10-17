import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({
    status: vi.fn(),
    contacts: vi.fn(),
    save: vi.fn(),
    end: vi.fn(),
    state: { activeVesselId: '20000000-0000-4000-8000-000000000001' },
}));
vi.mock('../services/overdueWatchClient', () => ({
    loadOverdueStatus: mock.status,
    saveOverdueWatch: mock.save,
    endOverdueWatch: mock.end,
}));
vi.mock('../services/shoreContactsClient', () => ({ listShoreContacts: mock.contacts }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((s: (x: typeof mock.state) => unknown) => s(mock.state), {
        getState: () => mock.state,
    }),
}));
import OverdueWatchSection from '../components/vessel/OverdueWatchSection';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
const owner = '10000000-0000-4000-8000-000000000001',
    revision = '30000000-0000-4000-8000-000000000001';
const binding = () => ({
    key: getAuthIdentityScope().key,
    generation: getAuthIdentityScope().generation,
    boatId: mock.state.activeVesselId,
});
const plan = () => ({
    vesselLabel: 'Private yacht',
    from: 'Harbour',
    to: 'Anchorage',
    departureAt: Date.now(),
    etaAt: null,
    overdueAt: Date.now() + 3600000,
    persons: 2,
});
const status = (ready = true, watch: unknown = null) => ({
    schema: 1,
    ownerId: owner,
    boatId: mock.state.activeVesselId,
    checkedAt: Date.now(),
    ready,
    watch,
});
const contacts = (overdue = true) => ({
    checkedAt: Date.now(),
    emailReady: true,
    telegramReady: false,
    contacts: [
        {
            id: owner,
            revision,
            consent: 'confirmed',
            configuration: {
                label: 'Chosen recipient',
                channel: 'email',
                enabled: true,
                sharePosition: false,
                allowOverdue: overdue,
            },
        },
    ],
});
beforeEach(() => {
    setAuthIdentityScope(owner);
    mock.status.mockReset().mockResolvedValue(status());
    mock.contacts.mockReset().mockResolvedValue(contacts());
    mock.save.mockReset().mockResolvedValue(undefined);
    mock.end.mockReset().mockResolvedValue(undefined);
});
it('hides unactivated opt-in and makes no mutation from viewing', async () => {
    mock.status.mockResolvedValue(status(false));
    render(<OverdueWatchSection binding={binding()} plan={plan()} />);
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'Overdue watch' })).toBeNull();
    expect(mock.save).not.toHaveBeenCalled();
});
it('a fresh async receipt is usable immediately, without waiting for the15second age tick', async () => {
    vi.useFakeTimers();
    try {
        vi.setSystemTime(1800000000000);
        let done!: () => void;
        mock.status.mockImplementation(async () => {
            await new Promise<void>((r) => {
                done = r;
            });
            return status();
        });
        render(<OverdueWatchSection binding={binding()} plan={plan()} />);
        await act(async () => {
            vi.advanceTimersByTime(12);
            done();
        });
        expect(screen.getByRole('button', { name: 'Save and arm reviewed plan' })).toBeVisible();
    } finally {
        vi.useRealTimers();
    }
});
it('requires chosen overdue-consented recipient and explicit compact-plan review', async () => {
    const p = plan();
    render(<OverdueWatchSection binding={binding()} plan={p} />);
    await act(async () => {});
    const save = screen.getByRole('button', { name: 'Save and arm reviewed plan' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Chosen recipient/ }));
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed/ }));
    await act(async () => fireEvent.click(save));
    expect(mock.save.mock.calls[0][2]).toEqual({
        enabled: true,
        plan: p,
        contacts: [{ id: owner, revision }],
        sharePosition: false,
        rescueRegion: null,
    });
    expect(JSON.stringify(mock.save.mock.calls)).not.toContain('medical');
    expect(mock.end).not.toHaveBeenCalled();
});
it('legacy anchor consent is not an eligible overdue recipient', async () => {
    mock.contacts.mockResolvedValue(contacts(false));
    render(<OverdueWatchSection binding={binding()} plan={plan()} />);
    await act(async () => {});
    expect(screen.queryByRole('checkbox', { name: /Chosen recipient/ })).toBeNull();
    expect(screen.getByText('No confirmed enabled overdue contacts.')).toBeVisible();
});
it('old watch remains stoppable while capability held; receipt says attempted and unconfirmed', async () => {
    const p = plan();
    mock.status.mockResolvedValue(
        status(false, {
            revision,
            configuration: {
                enabled: true,
                plan: p,
                contacts: [{ id: owner, revision }],
                sharePosition: false,
                rescueRegion: null,
            },
            state: {
                ownerQueuedAt: Date.now() - 2000,
                ownerAttemptedAt: Date.now() - 1000,
                contactsQueuedAt: null,
                endedAt: null,
            },
            endReason: null,
            reviewRequired: false,
        }),
    );
    render(<OverdueWatchSection binding={binding()} plan={p} />);
    await act(async () => {});
    expect(screen.getByText(/Owner notification attempted/)).toHaveTextContent('delivery unconfirmed');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark arrived' })));
    expect(mock.end.mock.calls[0].slice(0, 3)).toEqual([mock.state.activeVesselId, revision, 'arrived']);
    expect(screen.queryByRole('button', { name: 'Save and arm reviewed plan' })).toBeNull();
});
it('account replacement hides plan and pending actions before old async completion', async () => {
    let done!: (v: unknown) => void;
    mock.status.mockImplementation(
        () =>
            new Promise((r) => {
                done = r;
            }),
    );
    render(<OverdueWatchSection binding={binding()} plan={plan()} />);
    mock.contacts.mockResolvedValue(null);
    await act(async () => setAuthIdentityScope(null));
    await act(async () => done(status()));
    expect(screen.queryByText(/Private yacht/)).toBeNull();
    expect(mock.save).not.toHaveBeenCalled();
});
it('a still-open document cannot offer its old compact plan to a new logged-in account or selected boat', async () => {
    const p = plan(),
        view = render(<OverdueWatchSection binding={binding()} plan={p} />);
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Overdue watch' })).toBeVisible();
    await act(async () => setAuthIdentityScope('10000000-0000-4000-8000-000000000099'));
    expect(screen.queryByRole('region', { name: 'Overdue watch' })).toBeNull();
    view.unmount();
    setAuthIdentityScope(owner);
    const v = render(<OverdueWatchSection binding={binding()} plan={p} />);
    await act(async () => {});
    mock.state.activeVesselId = '20000000-0000-4000-8000-000000000099';
    v.rerender(<OverdueWatchSection binding={binding()} plan={p} />);
    expect(screen.queryByRole('region', { name: 'Overdue watch' })).toBeNull();
    mock.state.activeVesselId = '20000000-0000-4000-8000-000000000001';
});
it('a delayed lazy mount preserves the opening account binding instead of adopting a replacement account', async () => {
    const opened = binding();
    setAuthIdentityScope('10000000-0000-4000-8000-000000000099');
    render(<OverdueWatchSection binding={opened} plan={plan()} />);
    await act(async () => {});
    expect(mock.status).not.toHaveBeenCalled();
    expect(mock.contacts).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Overdue watch' })).toBeNull();
});
it('closing the document fences a late save and prevents a new background reload', async () => {
    let done!: () => void;
    mock.save.mockImplementation(
        () =>
            new Promise<void>((r) => {
                done = r;
            }),
    );
    const view = render(<OverdueWatchSection binding={binding()} plan={plan()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('checkbox', { name: /Chosen recipient/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and arm reviewed plan' }));
    view.unmount();
    await act(async () => done());
    expect(mock.status).toHaveBeenCalledTimes(1);
    expect(mock.contacts).toHaveBeenCalledTimes(1);
});
