import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
    list: vi.fn(),
    save: vi.fn(),
    state: { activeVesselId: '20000000-0000-4000-8000-000000000001' },
}));
vi.mock('../services/buddyWatchClient', () => ({ listBuddyWatches: mock.list, saveBuddyWatch: mock.save }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((select: (s: typeof mock.state) => unknown) => select(mock.state), {
        getState: () => mock.state,
    }),
}));
import BuddyWatchSheet from '../components/map/BuddyWatchSheet';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const owner = '10000000-0000-4000-8000-000000000001',
    id = '30000000-0000-4000-8000-000000000001',
    revision = '40000000-0000-4000-8000-000000000001';
const data = (ready = false) => ({
    schema: 1,
    ownerId: owner,
    boatId: mock.state.activeVesselId,
    checkedAt: Date.now(),
    ready,
    watches: [
        {
            id,
            revision,
            configuration: { mmsi: 234567890, label: 'Private label', enabled: false, area: null },
            state: null,
        },
    ],
});
beforeEach(() => {
    setAuthIdentityScope(owner);
    mock.list.mockReset().mockResolvedValue(data());
    mock.save.mockReset().mockResolvedValue(undefined);
});
describe('explicit held buddy list', () => {
    it('shows unknown coverage and prevents enabling held notices; a follow starts off', async () => {
        render(<BuddyWatchSheet onClose={() => {}} candidate={{ mmsi: 234567891, label: 'Example' }} />);
        await act(async () => {});
        expect(screen.getByRole('button', { name: 'Enable notices' })).toBeDisabled();
        expect(screen.getByText(/current position unknown/)).toBeVisible();
        expect(mock.save).not.toHaveBeenCalled();
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Follow boat' })));
        expect(mock.save.mock.calls[0][2]).toEqual({ mmsi: 234567891, label: 'Example', enabled: false, area: null });
    });
    it('a chosen area is explicit; blank coordinates cannot become0', async () => {
        render(<BuddyWatchSheet onClose={() => {}} candidate={{ mmsi: 234567891, label: 'Example' }} />);
        await act(async () => {});
        fireEvent.click(screen.getByLabelText('Watch entry/exit of a chosen circle'));
        fireEvent.change(screen.getByLabelText('Area name'), { target: { value: 'Ocean circle' } });
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Follow boat' })));
        expect(mock.save).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '0' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '179.9' } });
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Follow boat' })));
        expect(mock.save.mock.calls[0][2].area).toEqual({ lat: 0, lon: 179.9, radiusNm: 1, label: 'Ocean circle' });
    });
    it('only a real ready response offers a separate enable action', async () => {
        mock.list.mockResolvedValue(data(true));
        render(<BuddyWatchSheet onClose={() => {}} />);
        await act(async () => {});
        expect(mock.save).not.toHaveBeenCalled();
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enable notices' })));
        expect(mock.save.mock.calls[0][1]).toEqual({
            id,
            revision,
            configuration: data().watches[0].configuration,
            state: null,
        });
        expect(mock.save.mock.calls[0][2].enabled).toBe(true);
    });
    it('hides account-A list and private field edits on account replacement', async () => {
        render(<BuddyWatchSheet onClose={() => {}} />);
        await act(async () => {});
        fireEvent.change(screen.getByLabelText('Your label'), { target: { value: 'Private edited label' } });
        mock.list.mockResolvedValue(null);
        await act(async () => setAuthIdentityScope('10000000-0000-4000-8000-000000000099'));
        expect(screen.queryByText('Private label')).toBeNull();
        expect(screen.getByLabelText('Your label')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Follow boat' })).toBeDisabled();
    });
});
