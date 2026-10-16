import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
    run: vi.fn(),
    confirm: vi.fn(),
    confirmed: true,
    boat: 'synthetic-boat',
    settings: { vessel: { draft: 6, airDraft: 30 }, satelliteMode: false },
    listeners: new Set<() => void>(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: m.settings, activeVesselId: m.boat }),
        subscribe: (fn: () => void) => {
            m.listeners.add(fn);
            return () => {
                m.listeners.delete(fn);
            };
        },
    },
}));
vi.mock('../services/routing/autoTraceLeg', () => ({ autoTraceLeg: m.run }));
vi.mock('../stores/draftConfirmStore', () => ({ requireConfirmedDraft: m.confirm }));
vi.mock('../services/draftConfirmation', () => ({ isDraftConfirmed: () => m.confirmed }));
vi.mock('../services/units', () => ({ vesselDraftMetres: () => 1.8, vesselAirDraftMetres: () => 9 }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
import { useAutoRouteLeg, type AutoRouteLegDeps } from '../components/map/useAutoRouteLeg';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const pins = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.01 },
    { lat: 0, lon: 0.02 },
];
function setup() {
    let finish!: (result: { points: typeof pins; added: number; distanceNM: number }) => void;
    m.run.mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    const deps: AutoRouteLegDeps = {
        capturedCoords: pins,
        selectedPin: 2,
        setCapturedCoords: vi.fn(),
        setSelectedPin: vi.fn(),
        setInsertAfter: vi.fn(),
        insertAfterRef: { current: 1 },
        fixBusyLeg: null,
        setFixBusyLeg: vi.fn(),
        setAutoRouteDiag: vi.fn(),
        flashTraceFeedback: vi.fn(),
        departureMs: 1792216800000,
        legEtaOffsetsMs: [0, 600000],
        enabled: true,
    };
    const view = renderHook((props: AutoRouteLegDeps) => useAutoRouteLeg(props), { initialProps: deps });
    return { view, deps, finish: () => finish({ points: pins, added: 0, distanceNM: 1.2 }) };
}
beforeEach(() => {
    vi.clearAllMocks();
    m.listeners.clear();
    m.confirmed = true;
    m.confirm.mockResolvedValue(true);
    m.boat = 'synthetic-boat';
    m.settings = { vessel: { draft: 6, airDraft: 30 }, satelliteMode: false };
    setAuthIdentityScope(null);
});
afterEach(cleanup);
it('retires a boat switch even when the original boat is selected again before completion', async () => {
    const { view, deps, finish } = setup();
    act(() => view.result.current());
    await waitFor(() => expect(m.run).toHaveBeenCalled());
    m.boat = 'other-synthetic-boat';
    m.listeners.forEach((fn) => fn());
    m.boat = 'synthetic-boat';
    m.listeners.forEach((fn) => fn());
    await act(async () => finish());
    expect(deps.setCapturedCoords).not.toHaveBeenCalled();
});

it('owns one same-tick run and commits only the selected leg at its transit clock', async () => {
    const { view, deps, finish } = setup();
    act(() => {
        view.result.current();
        view.result.current();
    });
    await waitFor(() => expect(m.run).toHaveBeenCalledTimes(1));
    expect(m.run.mock.calls[0][0]).toMatchObject({ legIndex: 1, departureMs: deps.departureMs! + 600000 });
    expect(deps.setCapturedCoords).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(deps.setCapturedCoords).toHaveBeenCalledWith(pins);
    expect(deps.setSelectedPin).toHaveBeenCalledWith(null);
    expect(deps.insertAfterRef.current).toBeNull();
    expect(deps.setAutoRouteDiag).not.toHaveBeenCalledWith(expect.stringContaining('stopped'));
});
it.each(['pins', 'clock', 'selection', 'hidden', 'boat', 'draft', 'satellite', 'account', 'unmount'])(
    'cannot commit a late Auto result after %s changes',
    async (change) => {
        const { view, deps, finish } = setup();
        act(() => view.result.current());
        await waitFor(() => expect(m.run).toHaveBeenCalled());
        act(() => {
            if (change === 'pins') view.rerender({ ...deps, capturedCoords: [...pins, { lat: 0, lon: 0.03 }] });
            if (change === 'clock') view.rerender({ ...deps, departureMs: deps.departureMs! + 60000 });
            if (change === 'selection') view.rerender({ ...deps, selectedPin: 1 });
            if (change === 'hidden') view.rerender({ ...deps, enabled: false });
            if (change === 'boat') m.boat = 'different-synthetic-boat';
            if (change === 'draft') m.settings = { ...m.settings, vessel: { ...m.settings.vessel, draft: 8 } };
            if (change === 'satellite') m.settings = { ...m.settings, satelliteMode: true };
            if (change === 'account') setAuthIdentityScope('different-synthetic-owner');
            if (change === 'unmount') view.unmount();
        });
        expect(m.run.mock.calls[0][0].shouldContinue()).toBe(false);
        await act(async () => finish());
        expect(deps.setCapturedCoords).not.toHaveBeenCalled();
    },
);
it('cannot commit or start another Auto while confirmation is pending, and closing it releases the latch', async () => {
    let answer!: (value: boolean) => void;
    m.confirmed = false;
    m.confirm.mockReturnValue(
        new Promise((resolve) => {
            answer = resolve;
        }),
    );
    const { view } = setup();
    act(() => {
        view.result.current();
        view.result.current();
    });
    expect(m.confirm).toHaveBeenCalledTimes(1);
    expect(m.run).not.toHaveBeenCalled();
    await act(async () => answer(false));
    m.confirmed = true;
    act(() => view.result.current());
    await waitFor(() => expect(m.run).toHaveBeenCalledTimes(1));
});
it('retires a boat switch during the confirmation itself, even if the original boat returns', async () => {
    let answer!: (value: boolean) => void;
    m.confirmed = false;
    m.confirm.mockReturnValue(
        new Promise((resolve) => {
            answer = resolve;
        }),
    );
    const { view } = setup();
    act(() => view.result.current());
    m.boat = 'another-synthetic-boat';
    m.listeners.forEach((fn) => fn());
    m.boat = 'synthetic-boat';
    m.confirmed = true;
    m.listeners.forEach((fn) => fn());
    await act(async () => answer(true));
    expect(m.run).not.toHaveBeenCalled();
});
