import React from 'react';
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
const f = vi.hoisted(() => ({ canStop: false, stop: vi.fn() }));
vi.mock('../services/ais/piFleetClient', () => ({
    isPiFleetSharingConfigured: () => false,
    canStopPairedPiFleetSharing: () => f.canStop,
    stopPairedPiFleetSharing: () => f.stop(),
    reviewPiFleetSharing: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { subscribe: () => () => {} } }));
import Section, { PiFleetSharingSheet } from '../components/settings/PiFleetSharingSection';
import type { PiFleetSession } from '../services/ais/piFleetClient';
beforeEach(() => {
    f.canStop = false;
    f.stop.mockReset().mockResolvedValue(undefined);
});
function session(): PiFleetSession {
    return {
        initial: {
            operatorConfigured: true,
            state: 'off',
            consent: null,
            lastLocalRevision: null,
            lastAcknowledgedAt: null,
        },
        vesselName: 'Fixture yacht',
        current: () => true,
        release: vi.fn(),
        enable: vi.fn(async () => ({
            operatorConfigured: true,
            state: 'listening',
            consent: null,
            lastLocalRevision: null,
            lastAcknowledgedAt: null,
        })),
        off: vi.fn(async () => ({ localStopped: true, cloudWithdrawn: false })),
    };
}
it('unconfigured build cannot enable and honestly allows previously consented Pi independence', () => {
    render(<Section />);
    expect(screen.getByText(/previously consented Pi can continue independently/)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
});
it('unconfigured build still offers one-tap local stop without a cloud or consent review', async () => {
    f.canStop = true;
    render(<Section />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop paired Pi locally' }));
    await waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Cloud withdrawal was not requested');
    expect(screen.queryByRole('checkbox')).toBeNull();
});
it('failed local stop never claims the independent Pi is stopped', async () => {
    f.canStop = true;
    f.stop.mockRejectedValue(Error('unreachable'));
    render(<Section />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop paired Pi locally' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Local stop could not be confirmed'));
});
it('separate public ownship disclosure and explicit checkbox precede enabling; local off needs no extra confirmation', async () => {
    const s = session();
    render(<PiFleetSharingSheet session={s} onClose={vi.fn()} />);
    const enable = screen.getByRole('button', { name: 'Enable for this vessel' });
    expect(enable).toBeDisabled();
    expect(screen.getByText(/publicly trackable/)).toBeVisible();
    expect(screen.getByText(/Phone sharing does not turn this on/)).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(enable).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Pi sharing' }));
    await waitFor(() => expect(s.off).toHaveBeenCalledTimes(1));
    expect(s.enable).not.toHaveBeenCalled();
    await screen.findByText(/Cloud withdrawal could not be confirmed/);
    expect(enable).toBeDisabled();
});
it('not configured on Pi keeps enable disabled even after explicit checkbox', () => {
    const s = session();
    s.initial.operatorConfigured = false;
    render(<PiFleetSharingSheet session={s} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Enable for this vessel' })).toBeDisabled();
    expect(screen.getByText(/receiver-only source has not been configured/)).toBeVisible();
});
it('unreadable local consent has an explicit one-tap clear path and cannot be misreported as off', async () => {
    const s = session();
    s.initial.state = 'unavailable';
    render(<PiFleetSharingSheet session={s} onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('state is unavailable');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Enable for this vessel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Pi sharing' }));
    await waitFor(() => expect(s.off).toHaveBeenCalledTimes(1));
});
