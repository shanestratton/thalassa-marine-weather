import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CmemsAttribution, CMEMS_PRODUCT_ATTRIBUTIONS } from '../components/map/CmemsAttribution';
import { MARINE_DATASET_CONTRACTS } from '../services/weather/api/marineManifestContract';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('CmemsAttribution', () => {
    it('stays absent with no active CMEMS-derived layer', () => {
        render(<CmemsAttribution layers={[]} />);
        expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    });

    it('credits only the physics product for currents', () => {
        render(<CmemsAttribution layers={['currents']} />);

        expect(
            screen.getByRole('complementary', { name: 'Copernicus Marine data attribution for Currents' }),
        ).toBeInTheDocument();
        expect(screen.getByText('E.U. Copernicus Marine Service Information')).toBeInTheDocument();
        expect(screen.getByText('Currents')).toBeInTheDocument();
        expect(
            screen.getByRole('link', {
                name: 'Global Ocean Physics Analysis and Forecast, DOI 10.48670/moi-00016',
            }),
        ).toHaveAttribute('href', 'https://doi.org/10.48670/moi-00016');
        expect(screen.queryByRole('link', { name: /Global Ocean Waves/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /Global Ocean Biogeochemistry/ })).not.toBeInTheDocument();
    });

    it('lists every distinct active product and keeps the layer names readable', () => {
        render(<CmemsAttribution layers={['waves', 'chl', 'seaice', 'mld']} />);

        expect(screen.getByText('Waves, Chlorophyll, Sea ice, Mixed-layer depth')).toBeInTheDocument();
        expect(
            screen.getByRole('link', {
                name: 'Global Ocean Physics Analysis and Forecast, DOI 10.48670/moi-00016',
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('link', {
                name: 'Global Ocean Waves Analysis and Forecast, DOI 10.48670/moi-00017',
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('link', {
                name: 'Global Ocean Biogeochemistry Analysis and Forecast, DOI 10.48670/moi-00015',
            }),
        ).toBeInTheDocument();
        expect(screen.getByText('© Mercator Ocean International')).toBeInTheDocument();
    });

    it('keeps catalogue metadata and MapHub visibility wiring complete', () => {
        expect(CMEMS_PRODUCT_ATTRIBUTIONS).toEqual([
            expect.objectContaining({
                id: 'physics',
                doi: '10.48670/moi-00016',
                layers: ['currents', 'sst', 'seaice', 'mld'],
            }),
            expect.objectContaining({ id: 'waves', doi: '10.48670/moi-00017', layers: ['waves'] }),
            expect.objectContaining({ id: 'biogeochemistry', doi: '10.48670/moi-00015', layers: ['chl'] }),
        ]);

        const mapHub = read('components/map/MapHub.tsx');
        const requiredWiring = [
            ['isCmemsStepPresented(currentsLoadState)', "push('currents')"],
            ['isCmemsStepPresented(wavesLoadState)', "push('waves')"],
            ['isCmemsStepPresented(sstLoadState)', "push('sst')"],
            ['isCmemsStepPresented(chlLoadState)', "push('chl')"],
            ['isCmemsStepPresented(seaiceLoadState)', "push('seaice')"],
            ['isCmemsStepPresented(mldLoadState)', "push('mld')"],
        ];
        for (const [visibilityGate, attributionLayer] of requiredWiring) {
            expect(mapHub).toContain(visibilityGate);
            expect(mapHub).toContain(attributionLayer);
        }
        // Mounted with the credits-strip stacking offset since 2026-09-06.
        expect(mapHub).toContain('<CmemsAttribution');
        expect(mapHub).toContain('layers={cmemsAttributionLayers}');
        expect(mapHub).toContain('stackOffsetPx={rainCreditShown ? CREDITS_SLOT_PX : 0}');
        expect(mapHub).not.toContain('visible={!pickerMode && currentsVisible}');
        expect(mapHub).not.toContain(
            "currentsVisible && isCmemsCurrentsEnabled() && cmemsAttributionLayers.push('currents')",
        );

        // The products the attribution names are the ones every manifest must carry.
        // The publishers pin the same IDs in shanestratton/thalassa-ocean-data
        // (scripts/publisher-tests/test_release_gate.py).
        expect(MARINE_DATASET_CONTRACTS.currents.id).toBe('cmems_mod_glo_phy_anfc_merged-uv_PT1H-i');
        expect(MARINE_DATASET_CONTRACTS.waves.id).toBe('cmems_mod_glo_wav_anfc_0.083deg_PT3H-i');
        expect(MARINE_DATASET_CONTRACTS.sst.id).toBe('cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m');
        expect(MARINE_DATASET_CONTRACTS.chl.id).toBe('cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m');
        expect(MARINE_DATASET_CONTRACTS.seaice.id).toBe('cmems_mod_glo_phy_anfc_0.083deg_P1D-m');
        expect(MARINE_DATASET_CONTRACTS.mld.id).toBe('cmems_mod_glo_phy_anfc_0.083deg_P1D-m');
    });
});
