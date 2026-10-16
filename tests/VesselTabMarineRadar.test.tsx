import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
    state: {} as Record<string, unknown>,
    patch: vi.fn(),
    check: vi.fn(),
    listeners: new Set<(next: Record<string, unknown>, prev: Record<string, unknown>) => void>(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((select: (s: Record<string, unknown>) => unknown) => select(f.state), {
        getState: () => f.state,
        subscribe: (listener: (next: Record<string, unknown>, prev: Record<string, unknown>) => void) => {
            f.listeners.add(listener);
            return () => f.listeners.delete(listener);
        },
    }),
}));
vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../services/VesselIdentityService', () => ({ saveIdentity: vi.fn() }));
vi.mock('../hooks/useKeyboardOffset', () => ({ useKeyboardOffset: () => 0 }));
vi.mock('../components/settings/YachtDatabaseSearch', () => ({ YachtDatabaseSearch: () => null }));
vi.mock('../services/radar/radarEquipmentRead', () => ({ checkPairedRadarEquipment: f.check }));
vi.mock('../services/radar/piRadar', () => ({
    PiRadarError: class extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    },
}));
import { VesselTab } from '../components/settings/VesselTab';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { UserSettings } from '../types';
const settings = {
    vessel: {
        name: 'Synthetic yacht',
        type: 'sail',
        length: 40,
        beam: 12,
        draft: 6,
        displacement: 12000,
        maxWaveHeight: 0,
        cruisingSpeed: 0,
    },
} as UserSettings;
function changeVessel(id: string) {
    const previous = f.state;
    f.state = { ...f.state, activeVesselId: id };
    for (const listener of f.listeners) listener(f.state, previous);
}
beforeEach(() => {
    f.patch.mockReset();
    f.patch.mockResolvedValue(undefined);
    f.check.mockReset();
    setAuthIdentityScope('synthetic-radar-owner');
    f.state = {
        settings,
        activeVesselId: 'boat-a',
        vesselFleet: [{ id: 'boat-a', profile: settings.vessel }],
        patchActiveVesselProfile: f.patch,
    };
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});
async function open() {
    fireEvent.click(screen.getByRole('button', { name: /Marine radar/ }));
    return screen.findByRole('dialog', { name: 'Marine radar' });
}
it('writes the confirmed equipment through the active fleet field-patch seam and clears it with null', async () => {
    const legacy = vi.fn();
    render(<VesselTab settings={settings} onSave={legacy} />);
    await open();
    fireEvent.change(screen.getByLabelText('Make'), { target: { value: 'raymarine' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'raymarine-quantum-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save equipment' }));
    expect(f.patch).toHaveBeenCalledWith({
        profile: { marineRadar: { schema: 1, make: 'raymarine', modelId: 'raymarine-quantum-2', detail: null } },
    });
    expect(legacy).not.toHaveBeenCalled();
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Clear equipment' }));
    expect(f.patch).toHaveBeenLastCalledWith({ profile: { marineRadar: null } });
});
it('retires an open check on a synchronous boat A → B → A switch, even before React paints', async () => {
    let resolve!: (value: unknown) => void;
    f.check.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    render(<VesselTab settings={settings} onSave={vi.fn()} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-detect' }));
    const options = f.check.mock.calls[0][0];
    await act(async () => {
        changeVessel('boat-b');
        changeVessel('boat-a');
    });
    expect(screen.queryByRole('dialog', { name: 'Marine radar' })).toBeNull();
    expect(options.signal.aborted).toBe(true);
    expect(options.isCurrent()).toBe(false);
    await act(async () => resolve({ piName: 'Old Pi', isCurrent: () => true }));
    expect(screen.queryByText(/Old Pi/)).toBeNull();
    expect(f.patch).not.toHaveBeenCalled();
});
it('retires the editor on account change and never applies its draft to the next account', async () => {
    render(<VesselTab settings={settings} onSave={vi.fn()} />);
    await open();
    fireEvent.change(screen.getByLabelText('Make'), { target: { value: 'garmin' } });
    await act(async () => {
        setAuthIdentityScope('different-owner');
    });
    expect(screen.queryByRole('dialog', { name: 'Marine radar' })).toBeNull();
    expect(f.patch).not.toHaveBeenCalled();
});
it('uses the legacy local vessel profile without claiming cloud or detection availability', async () => {
    setAuthIdentityScope(null);
    f.state = { settings, activeVesselId: null };
    const save = vi.fn();
    render(<VesselTab settings={settings} onSave={save} />);
    await open();
    fireEvent.change(screen.getByLabelText('Make'), { target: { value: 'raymarine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save equipment' }));
    expect(save).toHaveBeenCalledWith({
        vessel: expect.objectContaining({ marineRadar: { schema: 1, make: 'raymarine', modelId: null, detail: null } }),
    });
    expect(f.patch).not.toHaveBeenCalled();
});
