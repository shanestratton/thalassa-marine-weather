import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const BOAT = '00000000-0000-4000-8000-0000000000b1';
const BOAT2 = '00000000-0000-4000-8000-0000000000b2';
const REV = '00000000-0000-4000-8000-000000000011';
const mocks = vi.hoisted(() => ({
    state: { activeVesselId: '' },
    status: vi.fn(),
    weather: vi.fn(),
    save: vi.fn(),
    review: vi.fn(),
    share: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((selector: (state: typeof mocks.state) => unknown) => selector(mocks.state), {
        getState: () => mocks.state,
    }),
}));
vi.mock('../services/lightningWatchClient', () => ({
    fetchLightningWatchStatus: mocks.status,
    saveLightningWatch: mocks.save,
}));
vi.mock('../services/weatherWatchClient', () => ({ fetchWeatherWatchStatus: mocks.weather }));
vi.mock('../services/weatherPositionClient', () => ({
    reviewWeatherPositionSource: mocks.review,
    saveWeatherPositionSource: mocks.share,
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
import LightningWatchSection from '../components/settings/LightningWatchSection';
const ready = { profile: null, ready: true, positionFresh: true };
const source = {
    schema: 1,
    ownerId: OWNER,
    piDeviceId: 'pi-test',
    relayId: 'relay-test',
    selfKey: 'a'.repeat(64),
    sourceKey: 'b'.repeat(64),
    position: { lat: -27, lon: 153, at: Date.UTC(2026, 9, 17) },
    servedAt: Date.UTC(2026, 9, 17),
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const toggle = () => screen.findByRole('switch', { name: 'Lightning within 20 NM' });
beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeVesselId = BOAT;
    setAuthIdentityScope(OWNER);
    mocks.status.mockResolvedValue(ready);
    mocks.weather.mockResolvedValue({ position: { registration: null } });
    mocks.review.mockResolvedValue(source);
    mocks.share.mockResolvedValue(REV);
    mocks.save.mockResolvedValue(undefined);
});
afterEach(cleanup);
describe('explicit vessel lightning choices', () => {
    it('retires an in-flight mutation on unmount without another status read', async () => {
        const pending = deferred<void>();
        mocks.save.mockReturnValue(pending.promise);
        const view = render(<LightningWatchSection />);
        fireEvent.click(await toggle());
        await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
        const reads = mocks.status.mock.calls.length;
        view.unmount();
        await act(async () => {
            pending.resolve();
            await pending.promise;
        });
        expect(mocks.status).toHaveBeenCalledTimes(reads);
    });
    it('hides unadmitted watches and never reviews or shares a position automatically', async () => {
        mocks.status.mockResolvedValue({ ...ready, ready: false });
        render(<LightningWatchSection />);
        await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('switch')).toBeNull();
        expect(mocks.review).not.toHaveBeenCalled();
        expect(mocks.share).not.toHaveBeenCalled();
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it('enables only on an explicit tap with the exact current owner and CAS revision', async () => {
        mocks.status.mockResolvedValue({ ...ready, profile: { revision: REV, enabled: false } });
        render(<LightningWatchSection />);
        fireEvent.click(await toggle());
        await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(BOAT, REV, true, getAuthIdentityScope()));
        expect(mocks.save).toHaveBeenCalledTimes(1);
        expect(mocks.share).not.toHaveBeenCalled();
        expect(await screen.findByText('Lightning notices enabled for this vessel.')).toBeInTheDocument();
    });
    it('keeps source review, position sharing and notice consent as separate explicit choices', async () => {
        mocks.status.mockResolvedValue({ ...ready, positionFresh: false });
        render(<LightningWatchSection />);
        expect(await toggle()).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Review paired boat position' }));
        const allow = await screen.findByRole('button', { name: 'Allow this vessel’s position sharing' });
        expect(mocks.share).not.toHaveBeenCalled();
        expect(mocks.save).not.toHaveBeenCalled();
        fireEvent.click(allow);
        await waitFor(() => expect(mocks.share).toHaveBeenCalledWith(BOAT, null, source, true, getAuthIdentityScope()));
        expect(await screen.findByText(/Wait for the next fresh boat fix/)).toBeInTheDocument();
        expect(await toggle()).toBeDisabled();
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it('allows an enabled watch to be stopped after provider readiness or position freshness disappears', async () => {
        mocks.status.mockResolvedValue({
            profile: { revision: REV, enabled: true },
            ready: false,
            positionFresh: false,
        });
        render(<LightningWatchSection />);
        const control = await toggle();
        expect(control).not.toBeDisabled();
        fireEvent.click(control);
        await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(BOAT, REV, false, getAuthIdentityScope()));
    });
    it('surfaces an owner CAS conflict without retrying or showing confirmation', async () => {
        mocks.save.mockRejectedValue(Error('Watch changed on another device. Reload and review it.'));
        render(<LightningWatchSection />);
        fireEvent.click(await toggle());
        expect(await screen.findByText(/Watch changed on another device/)).toBeInTheDocument();
        expect(mocks.save).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Lightning notices enabled for this vessel.')).toBeNull();
    });
    for (const transition of ['owner', 'vessel'] as const)
        it(`retires a delayed reviewed source after ${transition} A→B→A`, async () => {
            const pending = deferred<typeof source>();
            mocks.review.mockReturnValue(pending.promise);
            const view = render(<LightningWatchSection />);
            await toggle();
            fireEvent.click(screen.getByRole('button', { name: 'Review paired boat position' }));
            await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
            if (transition === 'owner') {
                await act(async () => {
                    setAuthIdentityScope(OTHER);
                });
                await act(async () => {
                    setAuthIdentityScope(OWNER);
                });
            } else {
                mocks.state.activeVesselId = BOAT2;
                view.rerender(<LightningWatchSection />);
                mocks.state.activeVesselId = BOAT;
                view.rerender(<LightningWatchSection />);
            }
            await toggle();
            await act(async () => {
                pending.resolve(source);
                await pending.promise;
            });
            expect(screen.queryByRole('button', { name: 'Allow this vessel’s position sharing' })).toBeNull();
            expect(mocks.share).not.toHaveBeenCalled();
            expect(mocks.save).not.toHaveBeenCalled();
        });
    it('does not confirm or reload a previous owner’s late mutation', async () => {
        const pending = deferred<void>();
        mocks.save.mockReturnValue(pending.promise);
        render(<LightningWatchSection />);
        fireEvent.click(await toggle());
        await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
        await act(async () => {
            setAuthIdentityScope(OTHER);
        });
        await toggle();
        const reads = mocks.status.mock.calls.length;
        await act(async () => {
            pending.resolve();
            await pending.promise;
        });
        expect(mocks.status).toHaveBeenCalledTimes(reads);
        expect(screen.queryByText('Lightning notices enabled for this vessel.')).toBeNull();
    });
});
