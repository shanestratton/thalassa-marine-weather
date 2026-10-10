import { readFileSync } from 'node:fs';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapBaseSelector, type MapBaseKind } from '../components/map/MapBaseSelector';
import { RELIEF_TILE_BASE } from '../components/map/reliefBase';
import { DEFAULT_MAP_BASE, defaultMapBase, useMapBase } from '../components/map/useMapBase';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

const DESK_KEY = 'thalassa_desk_map_v1';

function Harness({ saved, save }: { saved?: unknown; save?: (value: MapBaseKind) => void }) {
    const { mapBase, setMapBase } = useMapBase(saved, save);
    return (
        <MapBaseSelector
            visible
            value={mapBase}
            onChange={setMapBase}
            encCellCount={0}
            encVisible
            onToggleEnc={() => undefined}
        />
    );
}

describe('OBS opens on Relief (Shane 2026-10-04: the satellite stitching)', () => {
    it('defaults to Relief once the relief tiles are configured', () => {
        expect(defaultMapBase('https://relief.example.r2.dev/v1')).toBe('reliefSat');
    });

    // Review 2026-10-05: with no tile address (the R2 upload not done), a
    // default of Relief is a flat blue sea. Satellite was the imagery fallback
    // until it went (Shane 2026-10-09: "remove the old satellite map"); Hybrid,
    // the imagery base that stays, takes its place.
    it('falls back to Hybrid, the imagery base that stays, while no relief tiles are configured', () => {
        expect(defaultMapBase('')).toBe('hybrid');
    });

    it('takes the default from this build’s tile address, with nothing saved, in day and dark alike', () => {
        expect(DEFAULT_MAP_BASE).toBe(defaultMapBase(RELIEF_TILE_BASE));
        const { result } = renderHook(() => useMapBase(undefined));
        expect(result.current.mapBase).toBe(DEFAULT_MAP_BASE);
        expect(result.current.explicit).toBe(false);
    });

    it.each(['relief', 'reliefSat', 'ocean', 'hybrid'] as const)(
        'opens on a saved %s, and counts it as the skipper’s choice',
        (saved: MapBaseKind) => {
            const { result } = renderHook(() => useMapBase(saved));
            expect(result.current.mapBase).toBe(saved);
            expect(result.current.explicit).toBe(true);
        },
    );

    // The settings migration: an account that picked the old Satellite base
    // opens on Relief + Sat, still counted as its own choice (so the planning
    // surface follows it, as it followed Satellite).
    it('opens a saved Satellite (the removed base) on Relief + Sat, as the skipper’s choice', () => {
        const { result } = renderHook(() => useMapBase('satellite'));
        expect(result.current.mapBase).toBe('reliefSat');
        expect(result.current.explicit).toBe(true);
    });

    it.each(['maptiler', 'terrain', 42, null])(
        'ignores an unknown saved value (%s) and falls back to the default',
        (saved) => {
            const { result } = renderHook(() => useMapBase(saved));
            expect(result.current.mapBase).toBe(DEFAULT_MAP_BASE);
            expect(result.current.explicit).toBe(false);
        },
    );

    it('saves a pick to the account and shows it at once', () => {
        const save = vi.fn();
        const { result } = renderHook(() => useMapBase(undefined, save));
        act(() => result.current.setMapBase('ocean'));
        expect(save).toHaveBeenCalledWith('ocean');
        expect(result.current.mapBase).toBe('ocean');
        expect(result.current.explicit).toBe(true);
    });

    it('a pick made this session wins over a late account sync', () => {
        const { result, rerender } = renderHook(({ saved }) => useMapBase(saved), {
            initialProps: { saved: undefined as unknown },
        });
        act(() => result.current.setMapBase('ocean'));
        rerender({ saved: 'hybrid' });
        expect(result.current.mapBase).toBe('ocean');
    });

    it('keeps the actual selector usable and saving', () => {
        const save = vi.fn();
        render(<Harness saved="relief" save={save} />);
        expect(screen.getByRole('button', { name: 'Map base: Relief' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Map base:/ }));
        fireEvent.click(screen.getByRole('menuitemradio', { name: /^Relief \+ Sat / }));
        expect(screen.getByRole('button', { name: 'Map base: Relief + Sat' })).toBeInTheDocument();
        expect(save).toHaveBeenCalledWith('reliefSat');
    });
});

// WebGL itself is outside this focused hook test. Pin the narrow integration
// boundary so the tested hook cannot be left disconnected from the real map.
function source(path: string) {
    return readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

describe('OBS base wiring', () => {
    const hub = source('components/map/MapHub.tsx');

    it('reads and writes the per-account choice through settings', () => {
        expect(source('types/settings.ts')).toMatch(/obsChartBase\?:\s*ObsChartBase/);
        expect(hub).toMatch(/useMapBase\(settings\.obsChartBase, saveMapBase\)/);
        expect(hub).toMatch(/updateSettings\(\{ obsChartBase \}\)/);
        const selector = hub.match(/<MapBaseSelector\b[\s\S]*?\/>/)?.[0];
        expect(selector).toContain('value={mapBase}');
        expect(selector).toContain('onChange={setMapBase}');
    });

    it('takes night from App’s resolved mode for the night palette', () => {
        const app = source('App.tsx');
        const calls = [...app.matchAll(/<MapHub\b[\s\S]*?\/>/g)].map(([call]) => call);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatch(/nightMode=\{effectiveMode === 'night'\}/);
        expect(source('components/map/mapConstants.ts')).toMatch(/nightMode\?:\s*boolean/);
        expect(hub).toMatch(/nightMode\s*=\s*false/);
    });

    // Native (the phone) keeps exactly today's rule: the planning surface on
    // Hybrid unless the skipper picked a base. The web desk planner (127-DESKMAP
    // A2) shows this computer's own pick instead, so a saved Obs pick on any
    // device no longer turns the desk dark.
    it('keeps the planning surface on Hybrid unless the skipper picked a base', () => {
        expect(hub).toMatch(
            /const shownBase(?::\s*MapBaseKind)?\s*=\s*deskPlanner \? deskBase : planningSurface && !baseExplicit \? 'hybrid' : mapBase/,
        );
        expect(hub).toMatch(/mapBaseVisibility\(shownBase\)/);
    });

    it('keeps every base but Light on the ENC imagery treatment (the glaze); Light draws the paper chart', () => {
        expect(hub).toMatch(/const imageryOn(?::\s*boolean)?\s*=\s*shownBase !== 'light';/);
        // The synchronous mirror EncVectorLayer reads follows it.
        expect(hub).toMatch(/localStorage\.setItem\(SATELLITE_KEY, imageryOn \? 'true' : 'false'\)/);
    });

    // Two MapHubs can be mounted at once on the web (the kept-alive Obs map
    // and a Route Planner map on Light): each map's ENC reads its own base,
    // never whichever map wrote the one global key last.
    it('tells each map’s ENC its own base, written before the global fallback key', async () => {
        const mirror = hub.match(/setEncMapBase\(map, imageryOn\);[\s\S]{0,200}?localStorage\.setItem\(SATELLITE_KEY/);
        expect(mirror, 'MapHub writes the per-map base before the key').not.toBeNull();
        const { SATELLITE_KEY, satelliteBaseOn, setEncMapBase } = await import('../components/map/encDepthStyleState');
        const obs = {} as never;
        const desk = {} as never;
        setEncMapBase(obs, true); // Relief + Sat, the glaze
        setEncMapBase(desk, false); // Light, the paper chart
        for (const last of ['false', 'true']) {
            localStorage.setItem(SATELLITE_KEY, last);
            expect(satelliteBaseOn(obs), `key ${last}`).toBe(true);
            expect(satelliteBaseOn(desk), `key ${last}`).toBe(false);
        }
    });

    // 127-DESKMAP A3: a NOAA cell on Light reads as a paper chart (its land,
    // coastline, contours and marks) while tracing on the desk, and only there.
    it('draws the whole open chart on the desk tracer on Light; the switch decides everywhere else', () => {
        expect(hub).toMatch(/const encMaster = encVisible \|\| \(deskPlanner && coordCaptureMode && !imageryOn\);/);
        expect(hub).toMatch(/useEncVectorLayer\(mapRef, mapReady, encMaster,/);
        expect(hub).toMatch(/useTracerChartFloors\(mapRef, mapReady, coordCaptureMode, encMaster,/);
        expect(hub).toMatch(/encApplyLayerVisibility\(map, encMaster\)/);
        expect(hub).toMatch(/encMasterOff: !encMaster/);
    });

    it('is the desk planner only on the web, on the tracer and Route Planner maps', () => {
        expect(hub).toMatch(
            /const deskPlanner\s*=\s*!Capacitor\.isNativePlatform\(\) && \(cleanPlanningMap \|\| coordCaptureMode\);/,
        );
        // The desk's base is this computer's pick, never the account's Obs base.
        expect(hub).toMatch(/const \{ deskBase, setDeskBase, deskSeamarks, toggleDeskSeamarks \} = useDeskMap\(\);/);
        expect(source('components/map/deskMap.ts')).not.toMatch(/updateSettings|obsChartBase/);
    });

    it('offers the desk menu on web desk surfaces only: never picker, embedded or pin view', () => {
        const selectors = [...hub.matchAll(/<MapBaseSelector\b[\s\S]*?\/>/g)].map(([call]) => call);
        expect(selectors).toHaveLength(2);
        const desk = selectors[1];
        expect(desk).toContain('visible={deskSurface}');
        expect(desk).toContain('value={deskBase}');
        expect(desk).toContain('onChange={setDeskBase}');
        expect(desk).toContain('options={DESK_MAP_BASE_OPTIONS}');
        expect(desk).toContain('encRow={false}');
        expect(hub).toMatch(/const deskSurface\s*=\s*deskPlanner && !pickerMode && !embedded && !isPinView;/);
    });
});

describe('the desk map’s own picks (127-DESKMAP A2, thalassa_desk_map_v1)', () => {
    beforeEach(() => localStorage.clear());

    it('opens on Light with seamarks on, whatever the account’s Obs base', async () => {
        const { useDeskMap } = await import('../components/map/deskMap');
        const { result } = renderHook(() => useDeskMap());
        expect(result.current.deskBase).toBe('light');
        expect(result.current.deskSeamarks).toBe(true);
        expect(localStorage.getItem(DESK_KEY)).toBeNull();
    });

    it('writes only the picked field, and a pick survives a reload of the page', async () => {
        const { useDeskMap } = await import('../components/map/deskMap');
        const first = renderHook(() => useDeskMap());
        act(() => first.result.current.setDeskBase('hybrid'));
        expect(first.result.current.deskBase).toBe('hybrid');
        expect(JSON.parse(localStorage.getItem(DESK_KEY)!)).toEqual({ base: 'hybrid' });
        act(() => first.result.current.toggleDeskSeamarks());
        expect(first.result.current.deskSeamarks).toBe(false);
        expect(JSON.parse(localStorage.getItem(DESK_KEY)!)).toEqual({ base: 'hybrid', seamarks: false });
        first.unmount();
        const again = renderHook(() => useDeskMap());
        expect(again.result.current.deskBase).toBe('hybrid');
        expect(again.result.current.deskSeamarks).toBe(false);
    });

    // The Route map dialog and the App's kept-alive tracer are both desk maps:
    // a pick on one reaches the other at once, never only after a reload.
    it('a pick on one mounted desk map reaches every other one at once', async () => {
        const { useDeskMap } = await import('../components/map/deskMap');
        const dialog = renderHook(() => useDeskMap());
        const tracer = renderHook(() => useDeskMap());
        act(() => dialog.result.current.setDeskBase('hybrid'));
        act(() => dialog.result.current.toggleDeskSeamarks());
        expect(tracer.result.current.deskBase).toBe('hybrid');
        expect(tracer.result.current.deskSeamarks).toBe(false);
        act(() => tracer.result.current.toggleDeskSeamarks());
        expect(dialog.result.current.deskSeamarks).toBe(true);
        expect(JSON.parse(localStorage.getItem(DESK_KEY)!)).toEqual({ base: 'hybrid', seamarks: true });
        dialog.unmount();
        tracer.unmount();
    });

    it('never offers the dark bases or an unknown saved value on the desk', async () => {
        const { useDeskMap } = await import('../components/map/deskMap');
        for (const saved of [{ base: 'relief' }, { base: 'ocean' }, { base: 'satellite' }, { base: 42 }, 'junk']) {
            localStorage.setItem(DESK_KEY, typeof saved === 'string' ? saved : JSON.stringify(saved));
            const { result, unmount } = renderHook(() => useDeskMap());
            expect(result.current.deskBase, JSON.stringify(saved)).toBe('light');
            expect(result.current.deskSeamarks).toBe(true);
            unmount();
        }
    });

    it('a throwing localStorage still opens on Light with seamarks on, and a pick still shows', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        const { useDeskMap } = await import('../components/map/deskMap');
        const { result } = renderHook(() => useDeskMap());
        expect(result.current.deskBase).toBe('light');
        expect(result.current.deskSeamarks).toBe(true);
        act(() => result.current.setDeskBase('reliefSat'));
        expect(result.current.deskBase).toBe('reliefSat');
    });
});
