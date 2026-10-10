/**
 * Wind on the desk (127-DESKMAP-b): the menu row, the credit, and MapHub's
 * wiring. Shane 2026-10-10: "can we include the wind layer on the desktop.??
 * as an option??". The weather rules: "Always pass `&models=`", "Name
 * whichever models you actually used". Licence: the model data is CC BY 4.0,
 * UK Met Office's CC BY-SA 4.0, NOAA's public domain.
 */
import { readFileSync } from 'node:fs';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deskWindToggle, windCreditLine, windModelLabel } from '../components/map/deskWind';
import { DeskMapStrip } from '../components/map/DeskMapStrip';
import { DESK_MAP_BASE_OPTIONS, MapBaseSelector } from '../components/map/MapBaseSelector';
import { creditStackPx, CREDITS_SLOT_PX } from '../components/map/creditsStrip';
import { useDeviceMode } from '../hooks/useDeviceMode';
import { WIND_OVERLAY_MODELS } from '../services/weather/MultiModelWeatherService';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

const source = (path: string) => readFileSync(path, 'utf8');
const hub = source('components/map/MapHub.tsx');

afterEach(() => vi.restoreAllMocks());

describe('the wind credit names the model’s provider and its licence', () => {
    it.each([
        ['ecmwf', 'Wind: ECMWF (CC BY 4.0) via Open-Meteo'],
        ['aifs', 'Wind: ECMWF (CC BY 4.0) via Open-Meteo'],
        ['icon', 'Wind: DWD (CC BY 4.0) via Open-Meteo'],
        ['jma', 'Wind: JMA (CC BY 4.0) via Open-Meteo'],
        ['ukmo', 'Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo'],
        // GFS is NOAA's own GRIB (fetch-wind-grid), not Open-Meteo.
        ['gfs', 'Wind: NOAA (public domain)'],
    ] as const)('%s → %s', (model, line) => {
        expect(windCreditLine(model)).toBe(line);
    });

    it('names each of the Glass’s five by the chips’ own label', () => {
        expect(WIND_OVERLAY_MODELS.map(windModelLabel)).toEqual(['ICON', 'ECMWF', 'AIFS', 'UKMO', 'JMA']);
    });
});

describe('the desk menu’s Wind row', () => {
    it('sits after Seamarks, OFF, "Model forecast · ECMWF", and flips with one click', () => {
        const onToggle = vi.fn();
        render(
            <MapBaseSelector
                visible
                value="light"
                onChange={() => undefined}
                options={DESK_MAP_BASE_OPTIONS}
                encRow={false}
                toggles={[
                    {
                        id: 'seamarks',
                        label: 'Seamarks',
                        detail: 'OpenSeaMap community data, not verified',
                        on: true,
                        onToggle: () => undefined,
                    },
                    deskWindToggle(false, 'ecmwf', onToggle),
                ]}
                encCellCount={0}
                encVisible={false}
                onToggleEnc={() => undefined}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Light' }));
        const rows = screen.getAllByRole('menuitemcheckbox');
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining('Seamarks'),
            expect.stringContaining('Wind'),
        ]);
        const wind = rows[1];
        expect(wind).toHaveTextContent('Model forecast · ECMWF');
        expect(wind).toHaveAttribute('aria-checked', 'false');
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        fireEvent.click(wind);
        expect(onToggle).toHaveBeenCalledOnce();
        expect(writes).not.toHaveBeenCalled();
    });

    it('follows the chosen model: UKMO reads "Model forecast · UKMO"', () => {
        expect(deskWindToggle(true, 'ukmo', () => undefined)).toMatchObject({
            id: 'wind',
            label: 'Wind',
            detail: 'Model forecast · UKMO',
            on: true,
        });
    });

    it('is offered on a desk window 768 px wide or more, never narrower', () => {
        const at = (width: number) => {
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
            return renderHook(() => useDeviceMode()).result.current;
        };
        expect([at(1440), at(1024), at(768), at(767), at(390)]).toEqual(['helm', 'helm', 'helm', 'deck', 'deck']);
        expect(hub).toMatch(/const deskWindOffered = deskSurface && deviceMode === 'helm';/);
        // deskSurface already excludes picker, embedded and pin maps (127-DESKMAP).
        expect(hub).toMatch(/const deskSurface\s*=\s*deskPlanner && !pickerMode && !embedded && !isPinView;/);
    });

    it('is session-only state, OFF at every mount, and Obs’s own wind never turns it on', () => {
        expect(hub).toMatch(/const \[deskWindOn, setDeskWindOn\] = useState\(false\);/);
        expect(hub).toMatch(/const deskWind = deskWindOffered && deskWindOn;/);
        expect(hub).toContain('deskWindToggle(deskWindOn, weather.windModel, () => setDeskWindOn((on) => !on))');
        expect(source('components/map/deskWind.ts')).not.toMatch(/localStorage|sessionStorage|usePersistedState/);
    });
});

describe('MapHub paints the desk’s wind through the planner’s own layers', () => {
    it('hands useWeatherLayers the wind set only while the desk’s Wind is on', () => {
        expect(hub).toMatch(
            /useWeatherLayers\([\s\S]*?true, \/\/ Do not restore[^\n]*\n\s*deskWind \? DESK_WIND_LAYERS : undefined,\s*\);/,
        );
        expect(hub).toMatch(/const DESK_WIND_LAYERS = new Set<WeatherLayer>\(\['wind'\]\);/);
    });

    it('mounts the field on the desk, in the base’s palette, without her instruments', () => {
        const overlay = hub.match(
            /\{!isPinView && !embedded && !pickerMode && \(!planningSurface \|\| deskWind\) && \(\s*<MapboxVelocityOverlay[\s\S]*?\/>/,
        );
        expect(overlay).not.toBeNull();
        expect(overlay![0]).toContain('palette={windPalette}');
        // Dark ink on Light by day; Light's night palette is dim, so white streaks there.
        expect(hub).toMatch(/const windPalette = shownBase === 'light' && !nightMode \? 'light' : 'dark';/);
        expect(overlay![0]).toContain("boatInstruments={!planningSurface && obsStart.kind === 'follow'}");
        expect(overlay![0]).toContain('boatLookUp={!planningSurface && obsShowing}');
    });

    it('gives the panel its desk place, the first pin (or the still centre) and the start', () => {
        expect(hub).toMatch(
            /desk=\{\s*deskWind\s*\?\s*\{\s*palette: windPalette,\s*point: deskWindPoint,\s*pinned: capturedCoords\.length > 0,\s*startMs: departureMs,?\s*\}\s*: undefined\s*\}/,
        );
        expect(hub).toMatch(/const deskWindPoint = capturedCoords\[0\] \?\? stillCentre;/);
    });
});

describe('the credit is in the strip wherever wind draws', () => {
    it('on the desk: slot 2, under the seamarks', () => {
        render(
            <DeskMapStrip
                slot0={{ text: 'No chart for this area', hidden: false }}
                seamarks="shown"
                wind={windCreditLine('ukmo')}
                seabed
            />,
        );
        const slot2 = screen.getByTestId('desk-strip-slot-2');
        expect(slot2).toHaveTextContent('Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo');
        expect(slot2).toHaveAttribute('data-map-credit');
        const order = [...screen.getByTestId('desk-map-strip').children].map((el) => el.getAttribute('data-testid'));
        expect(order).toEqual(['desk-strip-slot-0', 'desk-strip-slot-1', 'desk-strip-slot-2', 'desk-strip-seabed']);
        expect(hub).toMatch(/wind=\{deskWind && weather\.windReady \? windCreditLine\(weather\.windModel\) : null\}/);
    });

    it('on Obs: after the radar and Copernicus credits, and lightning and the cloud stack under it', () => {
        expect(creditStackPx({ rain: true, cmems: true })).toBe(3 * CREDITS_SLOT_PX);
        expect(creditStackPx({ rain: true, cmems: true, wind: true })).toBe(4 * CREDITS_SLOT_PX);
        expect(creditStackPx({ rain: false, cmems: false, wind: true, lightning: true })).toBe(2 * CREDITS_SLOT_PX);
        const pill = hub.match(/<div\s+data-testid="wind-credit"[\s\S]*?<\/div>/);
        expect(pill).not.toBeNull();
        expect(pill![0]).toContain('data-map-credit');
        expect(pill![0]).toContain('windCreditLine(weather.windModel)');
        expect(hub).toMatch(/creditStackPx\(\{ rain: rainCreditShown, cmems: cmemsAttributionLayers\.length > 0 \}\)/);
        expect(hub).toMatch(/const obsWindCredit =\s*ownshipStartup &&/);
        expect(hub).toMatch(/const ownshipStartup = !embedded && !pickerMode && !planningSurface && !isPinView;/);
        // The passage strip clears it as it clears the other credits.
        expect(source('components/passage/PassageHudPane.tsx')).toContain('[data-testid="wind-credit"]');
    });

    // A phone-visible change, pinned (review 2026-10-10): lightning now counts
    // Copernicus as the two slots its three-line credit takes (at one slot it
    // lay on the DOI line), then the wind pill.
    it('lightning sits under the radar, both Copernicus slots and the wind pill', () => {
        expect(creditStackPx({ cmems: true })).toBe(2 * CREDITS_SLOT_PX);
        expect(creditStackPx({ rain: true, cmems: true, wind: true })).toBe(4 * CREDITS_SLOT_PX);
        const lightning = hub.match(
            /top: creditsStripTop\(\s*creditStackPx\(\{([^}]*)\}\),?\s*\),\s*\}\}\s*>\s*<BlitzortungAttribution/,
        );
        expect(lightning).not.toBeNull();
        expect(lightning![1].replace(/\s+/g, ' ').trim()).toBe(
            'rain: rainCreditShown, cmems: cmemsAttributionLayers.length > 0, wind: obsWindCredit,',
        );
    });
});
