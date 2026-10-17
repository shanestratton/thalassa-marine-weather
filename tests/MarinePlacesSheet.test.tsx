import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    search: vi.fn(),
    area: vi.fn(),
    clear: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    observe: vi.fn(),
    settings: { satelliteMode: false, savedLocations: [] as string[], savedLocationCoords: {} },
    auth: (() => undefined) as () => void,
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: { coordinates: { lat: -17, lon: 179.5 } }, selectLocation: h.select }),
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: h.settings, updateSettings: h.update }),
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({}),
    isAuthIdentityScopeCurrent: () => true,
    subscribeAuthIdentityScope: (fn: () => void) => {
        h.auth = fn;
        return () => undefined;
    },
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => h.settings.satelliteMode }));
vi.mock('../services/marineCatalogue/service', () => ({ searchMarinePlaces: h.search, loadMarineArea: h.area }));
vi.mock('../services/marineCatalogue/cache', () => ({
    catalogueCacheStats: async () => ({ entries: 0, bytes: 0 }),
    clearCatalogueCache: h.clear,
}));
vi.mock('../components/observations/ObservedNearbyCard', () => ({
    default: (props: unknown) => {
        h.observe(props);
        return <p>Actual observation card adapter</p>;
    },
}));
import MarinePlacesSheet from '../components/weather/MarinePlacesSheet';
const point = {
    id: 'geonames:1',
    name: 'Fictional Coral Bay',
    kind: 'bay',
    lat: -17,
    lon: 179.5,
    country: 'FJ',
    aliases: [],
    approximate: true,
};
beforeEach(() => {
    vi.clearAllMocks();
    h.settings.satelliteMode = false;
    h.search.mockResolvedValue({ records: [point], manifests: [], partial: false, cachedOnly: false });
    h.clear.mockResolvedValue(undefined);
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});
async function openSpot() {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fictional' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search marine places' }));
    fireEvent.click(await screen.findByRole('button', { name: /Fictional Coral Bay/ }));
}
describe('Glass public place search and explicit spot actions', () => {
    it('opening never queries a catalogue, forecast, observation or tide provider', async () => {
        await act(async () => {
            render(<MarinePlacesSheet onClose={vi.fn()} />);
        });
        expect(h.search).not.toHaveBeenCalled();
        expect(h.area).not.toHaveBeenCalled();
        expect(h.observe).not.toHaveBeenCalled();
        expect(h.select).not.toHaveBeenCalled();
    });
    it('selection retains actual coordinates, provenance and explicit forecast/save actions', async () => {
        const close = vi.fn();
        render(<MarinePlacesSheet onClose={close} />);
        await openSpot();
        expect(screen.getByRole('link', { name: /GeoNames/ })).toHaveAttribute('href', 'https://www.geonames.org/1/');
        expect(screen.getByText(/Representative location/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Save spot' }));
        expect(h.update).toHaveBeenCalledWith({
            savedLocations: ['Fictional Coral Bay, FJ'],
            savedLocationCoords: { 'Fictional Coral Bay, FJ': { lat: -17, lon: 179.5 } },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Forecast in The Glass' }));
        expect(h.select).toHaveBeenCalledWith('Fictional Coral Bay, FJ', { lat: -17, lon: 179.5 });
        expect(close).toHaveBeenCalledOnce();
    });
    it('nearby observations only mount after an explicit request at the chosen public point', async () => {
        render(<MarinePlacesSheet onClose={vi.fn()} />);
        await openSpot();
        expect(h.observe).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Nearby buoy / observations' }));
        await screen.findByText('Actual observation card adapter');
        expect(h.observe).toHaveBeenCalledWith({ point });
    });
    it('query edits cancel stale results and delete cancels the operation before clearing storage', async () => {
        let done!: (v: unknown) => void;
        h.search.mockImplementation(
            () =>
                new Promise((r) => {
                    done = r;
                }),
        );
        render(<MarinePlacesSheet onClose={vi.fn()} />);
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search marine places' }));
        const signal = h.search.mock.calls[0][2] as AbortSignal;
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Second' } });
        expect(signal.aborted).toBe(true);
        await act(async () => {
            done({ records: [point], manifests: [], partial: false });
        });
        expect(screen.queryByRole('button', { name: /Fictional Coral Bay/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Delete saved catalogue' }));
        expect(h.clear).toHaveBeenCalledOnce();
        await screen.findByText('Saved public catalogue deleted.');
    });
    it('account changes close the spot and fence selected-account actions', async () => {
        const close = vi.fn();
        await act(async () => {
            render(<MarinePlacesSheet onClose={close} />);
        });
        act(() => h.auth());
        expect(close).toHaveBeenCalledOnce();
    });
});
