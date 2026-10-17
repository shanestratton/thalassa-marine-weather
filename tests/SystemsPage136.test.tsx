import React, { useLayoutEffect } from 'react';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const external = vi.hoisted(() => ({
    pair: { deviceId: 'generated-boat', publicKeySpki: 'generated-pin', pairedAt: '2026-01-01' },
    vessel: 'generated-vessel',
    listeners: new Set<() => void>(),
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => external.pair }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ activeVesselId: external.vessel }),
        subscribe: (listener: () => void) => {
            external.listeners.add(listener);
            return () => external.listeners.delete(listener);
        },
    },
}));
import { NmeaStore } from '../services/NmeaStore';
import { snapshotFromWire } from '../services/telemetryWire';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import SystemsPage from '../components/vessel/SystemsPage';
import { SystemsEntry } from '../components/vessel/SystemsEntry';
const T = 1_800_000_000_000;
const pack = (kind: string, id: string, ...values: unknown[]) => JSON.stringify([1, kind, id, 'venus.1', T, ...values]);
function feed(
    extra: Record<string, string> = {
        sys_0_v1: pack('b', 'bank1', 13.4, 0, -5, 1000, 78, 2000),
        sys_1_v1: pack('b', 'bank2', 12.8, 0, 0, 0, null, null),
        sys_2_v1: pack('p', 'autopilot', 0, 0),
        sys_3_v1: pack('a', 'bus1/single', 350, 0, null, null, null, null),
    },
) {
    NmeaStore.ingestRemote(
        snapshotFromWire({ source: 'pi', reported_at: new Date(T).toISOString(), extra }, 'lan')!.snapshot,
    );
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    NmeaStore.stop();
    NmeaStore.clearRemote();
    external.vessel = 'generated-vessel';
    external.pair = { deviceId: 'generated-boat', publicKeySpki: 'generated-pin', pairedAt: '2026-01-01' };
    setAuthIdentityScope('systems-owner');
});
afterEach(() => {
    NmeaStore.stop();
    vi.useRealTimers();
});
it('shows measured signs and source age; changing a bank selects its own values without controls or house-bank guesses', () => {
    feed();
    render(<SystemsPage onClose={vi.fn()} />);
    const card = screen.getByRole('region', { name: 'Battery' });
    expect(within(card).getByText(/-5 A/)).toBeVisible();
    expect(within(card).getByLabelText('Sample age 1s ago')).toBeVisible();
    fireEvent.change(within(card).getByRole('combobox'), {
        target: { value: JSON.stringify(['b', 'bank2', 'venus.1']) },
    });
    expect(within(card).getByText(/12.8 V/)).toBeVisible();
    expect(within(card).getByText(/0 A/)).toBeVisible();
    expect(within(card).queryByText(/-5 A/)).toBeNull();
    const pilot = screen.getByRole('region', { name: 'Autopilot' });
    expect(within(pilot).getByText('Auto')).toBeVisible();
    expect(within(pilot).queryByRole('button')).toBeNull();
    expect(screen.getByText(/AC readings do not establish a shore connection/)).toBeVisible();
    expect(screen.queryByText(/House battery/)).toBeNull();
});
it('keeps separator-bearing instance and source identities distinct when selecting a sender', () => {
    feed({
        sys_0_v1: JSON.stringify([1, 'b', 'a:b', 'c', T, 12, 0, null, null, null, null]),
        sys_1_v1: JSON.stringify([1, 'b', 'a', 'b:c', T, 14, 0, null, null, null, null]),
    });
    render(<SystemsPage onClose={vi.fn()} />);
    const battery = screen.getByRole('region', { name: 'Battery' });
    fireEvent.change(within(battery).getByRole('combobox'), { target: { value: JSON.stringify(['b', 'a', 'b:c']) } });
    expect(within(battery).getByText(/14 V/)).toBeVisible();
    expect(within(battery).queryByText(/12 V/)).toBeNull();
});
it('a new report timestamp cannot revive a frozen sender, and an omitted next snapshot clears its values', () => {
    feed();
    render(<SystemsPage onClose={vi.fn()} />);
    act(() => vi.advanceTimersByTime(181000));
    expect(screen.getByRole('region', { name: 'Battery' })).toHaveTextContent('Unavailable');
    act(() => feed({}));
    expect(screen.getByRole('region', { name: 'Battery' })).toHaveTextContent('No current reported sender');
});
it.each(['account', 'pair', 'vessel'])('retires displayed private readings when %s changes', (change) => {
    feed();
    const close = vi.fn();
    render(<SystemsPage onClose={close} />);
    act(() => {
        if (change === 'account') setAuthIdentityScope('other-owner');
        else if (change === 'pair') external.pair = { ...external.pair, publicKeySpki: 'different-pin' };
        else {
            external.vessel = 'other-vessel';
            external.listeners.forEach((listener) => listener());
        }
        vi.advanceTimersByTime(1000);
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/13.4 V/)).toBeNull();
});
it('fences an account change between rendering and effect subscription', () => {
    feed();
    const close = vi.fn();
    function SwitchOnMount() {
        useLayoutEffect(() => {
            setAuthIdentityScope('changed-before-subscribe');
        }, []);
        return <SystemsPage onClose={close} />;
    }
    render(<SwitchOnMount />);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/13.4 V/)).toBeNull();
});
it('keeps unrelated engine meters unavailable even beside a fresh RPM', () => {
    NmeaStore.ingestRemote({
        ...snapshotFromWire(
            {
                source: 'pi',
                reported_at: new Date(T).toISOString(),
                rpm: 1000,
                extra: {
                    engine_metrics_v1: JSON.stringify([1, 'engine1', T, null, null, 80, 0, 300, 0]),
                    instrument_times_v1: JSON.stringify([null, null, null, null, null, T, null, null]),
                },
            },
            'lan',
        )!.snapshot,
        rpmEngineId: 'other-engine',
        rpmEngineCount: 1,
    });
    render(<SystemsPage onClose={vi.fn()} />);
    const engine = screen.getByRole('region', { name: 'Engine' });
    expect(engine).not.toHaveTextContent('80');
    expect(engine).toHaveTextContent('Unavailable');
});
it('the reachable Vessel row opens lazily and Escape restores focus to the row', async () => {
    vi.useRealTimers();
    feed();
    render(<SystemsEntry />);
    const opener = screen.getByRole('button', { name: 'Systems' });
    fireEvent.click(opener);
    expect(await screen.findByRole('dialog', { name: 'Boat systems' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
});
