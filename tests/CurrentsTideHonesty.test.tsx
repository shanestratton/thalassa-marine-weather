/**
 * The passage currents stop claiming to include tides (build 126, 126-01b;
 * roadmap: "The currents stop claiming to include tides").
 *
 * Thalassa's own CMEMS pipeline publishes `uo`/`vo` only
 * (scripts/cmems-currents-pipeline/pipeline.py, VARIABLES = ["uo", "vo"]).
 * In cmems_mod_glo_phy_anfc_merged-uv_PT1H-i those carry no tide (that is
 * `utide`; `utotal` adds tide and Stokes drift), and NOAA's fallback blend is
 * geostrophic. So the planner's spinner reads "ocean currents", not "tidal
 * streams", and the passage card says plainly that tidal streams are not in
 * it, for either provider.
 *
 * The passage HUD's and Glass's current copy is NOT this: it comes from
 * Open-Meteo's SMOC field, which does carry tides, and already says it
 * under-reads passages. It is not touched here.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentBriefing } from '../services/OceanCurrentService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

vi.mock('../services/weather/api/cmemsPassageCurrents', () => ({ sampleCmemsPassageCurrents: vi.fn() }));
vi.mock('../services/ReadinessCheckService', () => ({
    ReadinessCheckService: { loadCardChecks: vi.fn(async () => ({})), upsertCheck: vi.fn(async () => undefined) },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { OceanCurrentService } from '../services/OceanCurrentService';
import { OceanCurrentsCard } from '../components/passage/OceanCurrentsCard';

const read = (path: string) => readFileSync(path, 'utf8');

describe('the words around the passage currents', () => {
    it('the planner reads "ocean currents", never "tidal streams"', () => {
        // Source-level: the LOADING_PHASES array RoutePlanner cycles through.
        const form = read('hooks/useVoyageForm.ts');
        const phases = form.slice(
            form.indexOf('export const LOADING_PHASES'),
            form.indexOf('];', form.indexOf('export const LOADING_PHASES')),
        );
        expect(phases).toContain("'Reading ocean currents…'");
        expect(phases).not.toMatch(/tidal stream/i);
    });

    it('the two comments on the own pipeline no longer say tides are in it', () => {
        const cmems = read('services/weather/api/cmemsPassageCurrents.ts');
        const service = read('services/OceanCurrentService.ts');
        expect(cmems).not.toMatch(/\+ tides/);
        expect(service).not.toMatch(/tides included/);
        // They name what the pipeline publishes, and where.
        for (const source of [cmems, service]) {
            expect(source).toContain('uo');
            expect(source).toContain('scripts/cmems-currents-pipeline/pipeline.py');
        }
    });

    it("the departure sweep's best pick credits currents, not the tide stream", () => {
        // Its currents come from getCurrentField() (the same own-pipeline
        // uo/vo field, no tide). Dark today (the CMEMS routing beta is off),
        // but the words must be right before it is switched back on.
        const sweep = read('components/passage/DepartureSweepSheet.tsx');
        expect(sweep).toContain('getCurrentField');
        expect(sweep).toContain('currents swing passage ±{spreadMin} min');
        expect(sweep).not.toMatch(/tide stream swings/i);
    });
});

const NOW = Date.parse('2026-10-07T00:00:00Z');

function briefing(provider: CurrentBriefing['provider'], coverage: 'data' | 'empty' = 'data'): CurrentBriefing {
    return {
        availability: 'available',
        // A fictional point in the Agulhas Current.
        vectors: coverage === 'data' ? [{ lat: -34, lon: 27, u: 1.2, v: -0.4, speedKts: 2.5, directionDeg: 252 }] : [],
        avgSpeedKts: coverage === 'data' ? 2.5 : 0,
        maxSpeedKts: coverage === 'data' ? 2.5 : 0,
        netEffectHours: -0.4,
        freshness: 'weekly',
        fetchedAt: new Date(NOW).toISOString(),
        provider,
        providerDataset: 'test-field',
        dataTime: new Date(Date.now() - 3_600_000).toISOString(),
        retrieval: 'live',
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
        setAuthIdentityScope('skipper-1');
        fetchSpy = vi.spyOn(OceanCurrentService, 'fetchCurrents');
    });
    afterEach(() => {
        cleanup();
        fetchSpy.mockRestore();
        act(() => {
            setAuthIdentityScope(null);
        });
    });

    const card = () =>
        render(
            <OceanCurrentsCard
                voyageId="voyage-agulhas"
                departure={{ lat: -33.96, lon: 25.62 }}
                destination={{ lat: -34.18, lon: 22.15 }}
                distanceNM={180}
            />,
        );

    it.each([
        ['Copernicus Marine (uo/vo)', 'E.U. Copernicus Marine Service', 'data'],
        ['NOAA CoastWatch (geostrophic)', 'NOAA CoastWatch ERDDAP', 'data'],
        ['an empty Copernicus field', 'E.U. Copernicus Marine Service', 'empty'],
    ] as const)('says tidal streams are not included for %s', async (_name, provider, coverage) => {
        fetchSpy.mockResolvedValue(briefing(provider, coverage));
        card();
        expect(await screen.findByText('Ocean currents only: tidal streams are not included.')).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/tides included|with tides|tidal streams included/i);
    });
});
