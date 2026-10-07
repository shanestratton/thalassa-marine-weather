/**
 * The ocean-currents switch and card say what they actually do.
 *
 * The Preferences switch promised "recent ocean currents (about 5 days old)
 * instead of monthly averages", and the passage card offered "Enhance —
 * Download Real-Time Currents". Neither was true: there is no climatology in
 * the app. Both settings fetch the SAME live chain (Copernicus Marine, then
 * NOAA CoastWatch); the switch only decides how long a fetched field may be
 * reused — a day, or a week. The source tag that called the week-old cache
 * 'climatology' and the day-old one 'nrt' is renamed to what it is.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentBriefing } from '../services/OceanCurrentService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { DEFAULT_SETTINGS, useSettingsStore } from '../stores/settingsStore';

const { sampleCmemsPassageCurrents } = vi.hoisted(() => ({ sampleCmemsPassageCurrents: vi.fn() }));
vi.mock('../services/weather/api/cmemsPassageCurrents', () => ({ sampleCmemsPassageCurrents }));
vi.mock('../services/ReadinessCheckService', () => ({
    ReadinessCheckService: { loadCardChecks: vi.fn(async () => ({})), upsertCheck: vi.fn(async () => undefined) },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { OceanCurrentService } from '../services/OceanCurrentService';
import { OceanCurrentsCard } from '../components/passage/OceanCurrentsCard';
import { GeneralTab } from '../components/settings/GeneralTab';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-07T00:00:00Z');
/** Fictional corridors: the Gulf Stream off Florida and the Agulhas. */
const GULF_STREAM = { north: 27, south: 25, east: -79, west: -80.5 };
const AGULHAS = { north: -33, south: -35, east: 28, west: 26 };

function cmemsField(lat: number, lon: number) {
    return {
        datasetId: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i',
        generation: 'test-generation',
        dataTime: new Date(NOW - 3_600_000).toISOString(),
        vectors: [{ lat, lon, u: 1.2, v: 0.4 }],
    };
}

describe('OceanCurrentService: one live chain, two cache ages', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        localStorage.clear();
        sampleCmemsPassageCurrents.mockReset();
        sampleCmemsPassageCurrents.mockImplementation(async (box: { south: number; west: number }) =>
            cmemsField(box.south + 1, box.west + 1),
        );
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('tags a briefing by how fresh it is kept — never "climatology" or "nrt"', async () => {
        const weekly = await OceanCurrentService.fetchCurrents(GULF_STREAM, 30, 300, 7);
        const daily = await OceanCurrentService.fetchCurrents(AGULHAS, 240, 300, 7, true);
        expect(weekly.freshness).toBe('weekly');
        expect(daily.freshness).toBe('daily');
        for (const b of [weekly, daily]) {
            expect(b).not.toHaveProperty('source');
            expect(b.provider).toBe('E.U. Copernicus Marine Service');
        }
        // The same live provider answered both: the switch never picks a dataset.
        expect(sampleCmemsPassageCurrents).toHaveBeenCalledTimes(2);
    });

    it('off: a fetched field is reused for up to a week', async () => {
        await OceanCurrentService.fetchCurrents(GULF_STREAM, 30, 300, 7);
        vi.setSystemTime(NOW + 6 * DAY);
        expect((await OceanCurrentService.fetchCurrents(GULF_STREAM, 30, 300, 7)).retrieval).toBe('cached');
        vi.setSystemTime(NOW + 7 * DAY + 1);
        expect((await OceanCurrentService.fetchCurrents(GULF_STREAM, 30, 300, 7)).retrieval).toBe('live');
    });

    it('on: it is fetched again after a day', async () => {
        await OceanCurrentService.fetchCurrents(AGULHAS, 240, 300, 7, true);
        vi.setSystemTime(NOW + DAY - 1);
        expect((await OceanCurrentService.fetchCurrents(AGULHAS, 240, 300, 7, true)).retrieval).toBe('cached');
        vi.setSystemTime(NOW + DAY + 1);
        expect((await OceanCurrentService.fetchCurrents(AGULHAS, 240, 300, 7, true)).retrieval).toBe('live');
    });

    it('a refresh skips the cache and fetches now', async () => {
        await OceanCurrentService.fetchCurrents(GULF_STREAM, 30, 300, 7);
        const refreshed = await OceanCurrentService.fetchCurrents(GULF_STREAM, 30, 300, 7, false, { refresh: true });
        expect(refreshed.retrieval).toBe('live');
        expect(sampleCmemsPassageCurrents).toHaveBeenCalledTimes(2);
    });
});

describe('Settings → Preferences: the currents switch', () => {
    beforeEach(() => {
        vi.stubGlobal('__BUILD_STAMP__', '2026-10-07 00:00Z');
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });
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

    it('says it changes how often currents are fetched, and promises no averages', () => {
        const onSave = tab(DEFAULT_SETTINGS);
        const toggle = screen.getByRole('switch', { name: 'Daily ocean currents' });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        const row = toggle.parentElement!;
        expect(row.textContent).toMatch(/always live/i);
        expect(row.textContent).toMatch(/each day/i);
        expect(row.textContent).toMatch(/7 days/);
        expect(row.textContent).not.toMatch(/monthly|average|climatolog|5 days old|high-fidelity/i);
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ currentNrtEnabled: true });
    });

    it('the Vessel page line that points to it says the same', () => {
        const vessel = readFileSync('components/settings/VesselTab.tsx', 'utf8');
        expect(vessel).not.toMatch(/monthly averages|High-fidelity ocean currents/);
        expect(vessel).toContain('Daily ocean currents');
    });
});

function briefing(
    provider: CurrentBriefing['provider'],
    coverage: 'data' | 'empty' = 'data',
    opts: { retrieval?: CurrentBriefing['retrieval']; fieldAgeHours?: number } = {},
): CurrentBriefing {
    return {
        availability: 'available',
        vectors: coverage === 'data' ? [{ lat: 26, lon: -79.8, u: 1.2, v: 0.4, speedKts: 2.5, directionDeg: 72 }] : [],
        avgSpeedKts: coverage === 'data' ? 2.5 : 0,
        maxSpeedKts: coverage === 'data' ? 2.5 : 0,
        netEffectHours: -0.4,
        freshness: 'weekly',
        fetchedAt: new Date(NOW).toISOString(),
        provider,
        providerDataset: 'test-field',
        dataTime: new Date(Date.now() - (opts.fieldAgeHours ?? 1) * 3_600_000).toISOString(),
        retrieval: opts.retrieval ?? 'cached',
        coverage,
        dataFingerprint: 'fp',
        segments: coverage === 'data' ? [{ type: 'favourable', avgSpeedKts: 2.5, label: 'favourable' }] : [],
    };
}

describe('the passage currents card', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('currents-owner');
        fetchSpy = vi.spyOn(OceanCurrentService, 'fetchCurrents');
    });
    afterEach(() => {
        cleanup();
        fetchSpy.mockRestore();
        act(() => {
            useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
            setAuthIdentityScope(null);
        });
    });

    const card = () =>
        render(
            <OceanCurrentsCard
                voyageId="voyage-gulf-stream"
                departure={{ lat: 25.8, lon: -80.1 }}
                destination={{ lat: 26.7, lon: -79.0 }}
                distanceNM={70}
            />,
        );

    it('labels live data as live and offers "Refresh currents", not an "Enhance" download', async () => {
        fetchSpy.mockResolvedValue(briefing('E.U. Copernicus Marine Service', 'data', { retrieval: 'live' }));
        card();
        await screen.findByText(/Surface currents/i);
        expect(screen.getByText('Surface Currents — Live data')).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/Enhance|Real-Time|Near Real-Time|Standard/);
        const refresh = screen.getByRole('button', { name: 'Refresh currents' });
        fireEvent.click(refresh);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        expect(fetchSpy.mock.calls[1][5]).toEqual({ refresh: true });
    });

    it.each([
        [
            'a week-kept copy, 6 days old',
            { retrieval: 'cached', fieldAgeHours: 6 * 24 + 2 },
            'Saved copy · field 6 days old',
        ],
        ['a copy saved this morning', { retrieval: 'cached', fieldAgeHours: 3 }, 'Saved copy'],
        [
            'a fresh download of a 30 h old field',
            { retrieval: 'live', fieldAgeHours: 30 },
            'Live source · field 30 h old',
        ],
    ] as const)('never heads %s "Live data"', async (_name, opts, label) => {
        fetchSpy.mockResolvedValue(briefing('NOAA CoastWatch ERDDAP', 'data', opts));
        card();
        expect(await screen.findByText(`Surface Currents — ${label}`)).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/Live data/);
    });

    it('follows the Preferences switch for how long a field may be reused', async () => {
        useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, currentNrtEnabled: true } });
        fetchSpy.mockResolvedValue(briefing('E.U. Copernicus Marine Service'));
        card();
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(fetchSpy.mock.calls[0][4]).toBe(true);
    });

    it('names the provider that answered, not NOAA when Copernicus did', async () => {
        fetchSpy.mockResolvedValue(briefing('E.U. Copernicus Marine Service', 'empty'));
        card();
        await screen.findByText(/Provider returned an empty current field/);
        expect(screen.getByText(/authoritative E\.U\. Copernicus Marine Service response/)).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/authoritative NOAA/);
    });
});
