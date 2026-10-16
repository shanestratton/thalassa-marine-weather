import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
    features: [] as GeoJSON.Feature<GeoJSON.Point>[],
    filters: { source: 'local', minSpeedKn: 10 },
}));
vi.mock('../services/AisStore', () => ({ AisStore: { subscribe: () => () => undefined } }));
vi.mock('../services/ais/aisTargetCache', () => ({
    readAisTargetPicture: () => fixtures.features,
    subscribeAisTargetPicture: () => () => undefined,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: unknown) => unknown) =>
        selector({ settings: { aisDisplayFilters: fixtures.filters } }),
}));
vi.mock('../services/AisGuardWatch', () => ({
    readCollisionInputs: () => ({
        own: { lat: -27, lon: 153 },
        motion: {},
        prefs: {},
        ownMmsis: new Set(),
        atAnchor: false,
    }),
    gradeCollisionTargets: () => [{ mmsi: 503000002, assessment: { risk: 'CAUTION', cpaNm: 0.25 } }],
}));
import { AisTargetsSheet } from '../components/map/AisTargetsSheet';
afterEach(cleanup);

describe('the lazy AIS Targets sheet', () => {
    it('uses display choices while keeping caution and distress, shows measurements and selects the actual report', () => {
        fixtures.features = [
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [153, -26.99] },
                properties: {
                    mmsi: 503000001,
                    name: 'HIDDEN SLOW BOAT',
                    source: 'cloud',
                    sog: 0,
                    lastUpdated: Date.now(),
                },
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [153, -26.98] },
                properties: {
                    mmsi: 503000002,
                    name: 'CLOSE SHIP',
                    source: 'cloud',
                    sog: 5,
                    lastUpdated: Date.now() - 120000,
                },
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [153, -26.97] },
                properties: { mmsi: 970000001, name: 'AIS SART', source: 'cloud', sog: 0, lastUpdated: Date.now() },
            },
        ];
        const onSelect = vi.fn();
        const onClose = vi.fn();
        render(<AisTargetsSheet onSelect={onSelect} onClose={onClose} />);
        expect(screen.queryByText('HIDDEN SLOW BOAT')).toBeNull();
        const close = screen.getByRole('button', { name: /CLOSE SHIP/ });
        expect(close).toHaveTextContent('CAUTION');
        expect(close).toHaveTextContent('000°T');
        expect(close).toHaveTextContent('CPA 0.25 NM');
        expect(close).toHaveTextContent('2 min old');
        expect(screen.getByText('AIS SART')).toBeTruthy();
        fireEvent.click(close);
        expect(onSelect).toHaveBeenCalledWith(fixtures.features[1]);
        fireEvent.click(screen.getByRole('button', { name: 'Close targets' }));
        expect(onClose).toHaveBeenCalledOnce();
    });
});
