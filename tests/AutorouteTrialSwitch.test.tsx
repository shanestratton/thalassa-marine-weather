/**
 * Auto route (trial) is opt-in — 2026-10-01, Claude's call under Shane's
 * delegation ("any questions please answer with whatever your recommendation
 * is. as i always trust your recommendations").
 *
 * Phase 3 (3b606808) made Auto's gate local: Pro, signed in, installed charts.
 * While the public beta is on, every account is Pro (PUBLIC_BETA_ACCESS), so
 * Auto would have opened for every signed-in tester with charts as soon as
 * master shipped — before Shane has proved the router in the Whitsundays. It
 * stays closed until the skipper switches on Settings → Preferences → "Auto
 * route (trial)", which is off by default, and when closed it says where the
 * switch is. Pro, signed in and charts still apply on top. The manual
 * planner's own ⚡ Auto route does not read the switch.
 *
 * Plan Your Day no longer reads it (build 124, "Today on the water"): the
 * planner does not route any more, so the switch gates the Auto workspace
 * only. Pro still applies.
 *
 * Real settings store, real switch, real Auto status; one synthetic installed
 * chart (no real chart data); the engine, the workspace and the planner sheet
 * are stand-ins that only record whether they were reached.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VesselProfile } from '../types/vessel';

const mocks = vi.hoisted(() => ({
    cells: [{ id: 'OC-99-SYN001' }] as unknown[],
    route: vi.fn(),
    sheet: vi.fn(),
    workspace: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    listCells: () => mocks.cells,
}));
// The engine is never reached while the switch is off.
vi.mock('../services/InshoreRouter', () => ({
    tryInshoreRoute: mocks.route,
    hasEncCoverageForRoute: () => true,
    MAX_INSHORE_NM: 50,
}));
vi.mock('../components/dayPlanner/TodaySheet', () => ({
    default: () => {
        mocks.sheet();
        return <div role="dialog" aria-label="Plan Your Day" />;
    },
}));
vi.mock('../components/autorouting/AutoroutingTrialWorkspace', () => ({
    AutoroutingTrialWorkspace: () => {
        mocks.workspace();
        return <div role="dialog" aria-label="Autorouting trial workspace" />;
    },
}));

import { RoutingModeDialog } from '../components/autorouting/RoutingModeDialog';
import { DayPlannerEntry } from '../components/dayPlanner/DayPlannerEntry';
import { GeneralTab } from '../components/settings/GeneralTab';
import { calculateThalassaProposal, getThalassaAutorouteStatus } from '../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { PUBLIC_BETA_ACCESS } from '../services/SubscriptionService';
import { awaitSettingsLoaded, DEFAULT_SETTINGS, useSettingsStore } from '../stores/settingsStore';

const AUTO_OFF = 'Auto route (trial) is off. Turn it on in Settings → Preferences. Manual is ready.';

// Confirmed, so a gate that let Auto through would open it at once.
const VESSEL: VesselProfile = {
    name: 'Serene Summer',
    type: 'sail',
    length: 40,
    beam: 16,
    airDraft: 59,
    draft: 7.87,
    draftConfirmedFt: 7.87,
    displacement: 20000,
    maxWaveHeight: 10,
    cruisingSpeed: 6,
};

function setSwitch(on: boolean | undefined) {
    act(() => {
        useSettingsStore.setState({
            settings: { ...useSettingsStore.getState().settings, autorouteTrialEnabled: on },
        });
    });
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('__BUILD_STAMP__', '2026-10-01 12:00Z');
    setAuthIdentityScope('trial-switch-skipper');
    await awaitSettingsLoaded();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, vessel: VESSEL } });
});

afterEach(() => {
    cleanup();
    setSwitch(undefined);
    setAuthIdentityScope(null);
    vi.unstubAllGlobals();
});

describe('Auto route (trial): off by default, even for a beta Pro account', () => {
    it('a signed-in beta account with charts installed starts with Auto closed, and the switch opens it', () => {
        // Every account is Pro while the public beta is on: Pro alone must not open Auto.
        expect(PUBLIC_BETA_ACCESS.enabled).toBe(true);
        expect(DEFAULT_SETTINGS.autorouteTrialEnabled).not.toBe(true);
        expect(useSettingsStore.getState().settings.autorouteTrialEnabled).not.toBe(true);

        expect(getThalassaAutorouteStatus()).toEqual({ enabled: false, ready: false, message: AUTO_OFF });

        setSwitch(true);
        expect(getThalassaAutorouteStatus()).toEqual({ enabled: true, ready: true });

        // The other conditions still apply on top of the switch.
        mocks.cells = [];
        expect(getThalassaAutorouteStatus()).toEqual({
            enabled: true,
            ready: false,
            message: 'Install charts for your area to use Auto. Manual is ready.',
        });
        mocks.cells = [{ id: 'OC-99-SYN001' }];
        setAuthIdentityScope(null);
        expect(getThalassaAutorouteStatus().enabled).toBe(false);
    });

    it('a calculation asked for while the switch is off is refused before the router runs', async () => {
        await expect(
            calculateThalassaProposal({
                departure: { lat: -31.0, lon: 161.0 },
                destination: { lat: -31.05, lon: 161.06 },
                draftM: 2.4,
                speedKts: 6,
            }),
        ).rejects.toThrow(AUTO_OFF);
        expect(mocks.route).not.toHaveBeenCalled();
    });

    it('the routing choice keeps Auto shut and says where the switch is; switched on, Auto opens', async () => {
        const first = render(<RoutingModeDialog mapboxToken="token" onClose={vi.fn()} onManual={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: 'Choose routing mode' });
        await waitFor(() => expect(dialog).toHaveTextContent(AUTO_OFF));
        const auto = screen.getByRole('button', { name: 'Auto routing' });
        expect(auto).toBeDisabled();
        fireEvent.click(auto);
        expect(mocks.workspace).not.toHaveBeenCalled();
        // Manual is never behind the switch.
        expect(screen.getByRole('button', { name: 'Manual routing' })).toBeEnabled();
        first.unmount();

        setSwitch(true);
        render(<RoutingModeDialog mapboxToken="token" onClose={vi.fn()} onManual={vi.fn()} />);
        const open = screen.getByRole('button', { name: 'Auto routing' });
        await waitFor(() => expect(open).toBeEnabled());
        expect(screen.queryByText(AUTO_OFF)).toBeNull();
        fireEvent.click(open);
        await screen.findByRole('dialog', { name: 'Autorouting trial workspace' });
        expect(mocks.workspace).toHaveBeenCalled();
    });
});

describe('Plan Your Day no longer reads the switch', () => {
    const entry = (isPro = true, onUpgrade = vi.fn()) => (
        <DayPlannerEntry
            vessel={VESSEL}
            usingDefaultVessel={false}
            isPro={isPro}
            onUpgrade={onUpgrade}
            onPlot={vi.fn()}
        />
    );

    it('opens for a beta Pro account with the switch off, and says nothing about the switch', async () => {
        expect(useSettingsStore.getState().settings.autorouteTrialEnabled).not.toBe(true);
        render(entry());
        fireEvent.click(screen.getByRole('button', { name: /Plan Your Day/ }));
        await screen.findByRole('dialog', { name: 'Plan Your Day' });
        expect(mocks.sheet).toHaveBeenCalled();
        expect(screen.queryByText(/Auto route \(trial\)/)).toBeNull();
        expect(screen.getByRole('button', { name: /Plan Your Day/ })).toHaveAttribute('aria-expanded', 'true');

        // Switching it on or off while the planner is open changes nothing.
        setSwitch(true);
        setSwitch(false);
        expect(screen.getByRole('dialog', { name: 'Plan Your Day' })).toBeTruthy();
    });

    it('a free account is still offered the upgrade', () => {
        const onUpgrade = vi.fn();
        render(entry(false, onUpgrade));
        fireEvent.click(screen.getByRole('button', { name: /Plan Your Day/ }));
        expect(onUpgrade).toHaveBeenCalledOnce();
        expect(mocks.sheet).not.toHaveBeenCalled();
    });

    it('the entry imports neither the switch nor the planner services; the sheet stays lazy', () => {
        const source = readFileSync('components/dayPlanner/DayPlannerEntry.tsx', 'utf8');
        expect(source).not.toMatch(/autorouteTrialSwitch|draftConfirmStore|services\/dayPlanner/);
        expect(source).toMatch(/lazyRetry\(\(\) => import\('\.\/TodaySheet'\)\)/);
        expect(readFileSync('services/autorouteTrialSwitch.ts', 'utf8')).not.toMatch(/PLAN_YOUR_DAY_TRIAL_OFF/);
    });
});

describe('Settings → Preferences → Routing: the switch', () => {
    const tab = (settings: typeof DEFAULT_SETTINGS, onSave = vi.fn()) => {
        render(
            <GeneralTab
                settings={settings}
                onSave={onSave}
                onLocationSelect={vi.fn()}
                onDetectLocation={vi.fn()}
                onShowFactoryReset={vi.fn()}
            />,
        );
        return onSave;
    };

    it('is off by default, says what it is in one line, and saves autorouteTrialEnabled', () => {
        const onSave = tab(DEFAULT_SETTINGS);
        const toggle = screen.getByRole('switch', { name: 'Auto route (trial)' });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText("Thalassa's own router. Not for navigation — review every route.")).toBeTruthy();
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ autorouteTrialEnabled: true });
    });

    it('switches off again', () => {
        const onSave = tab({ ...DEFAULT_SETTINGS, autorouteTrialEnabled: true });
        const toggle = screen.getByRole('switch', { name: 'Auto route (trial)' });
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ autorouteTrialEnabled: false });
    });

    it("the manual planner's ⚡ Auto route does not read the switch", () => {
        expect(readFileSync('components/map/useAutoRouteLeg.ts', 'utf8')).not.toMatch(/autorouteTrial/i);
    });
});
