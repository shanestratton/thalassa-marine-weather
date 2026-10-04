import { readFileSync } from 'node:fs';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapBaseSelector, type MapBaseKind } from '../components/map/MapBaseSelector';
import { RELIEF_TILE_BASE } from '../components/map/reliefBase';
import { DEFAULT_MAP_BASE, defaultMapBase, useMapBase } from '../components/map/useMapBase';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

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
        expect(defaultMapBase('https://relief.example.r2.dev/v1')).toBe('relief');
    });

    // Review 2026-10-05: with no tile address (the R2 upload not done), a
    // default of Relief is a flat blue sea where Satellite used to be. The
    // build that ships before the upload keeps Satellite; Relief is a pick.
    it('keeps Satellite as the default while no relief tiles are configured', () => {
        expect(defaultMapBase('')).toBe('satellite');
    });

    it('takes the default from this build’s tile address, with nothing saved, in day and dark alike', () => {
        expect(DEFAULT_MAP_BASE).toBe(defaultMapBase(RELIEF_TILE_BASE));
        const { result } = renderHook(() => useMapBase(undefined));
        expect(result.current.mapBase).toBe(DEFAULT_MAP_BASE);
        expect(result.current.explicit).toBe(false);
    });

    it.each(['relief', 'reliefSat', 'ocean', 'satellite', 'hybrid'] as const)(
        'opens on a saved %s, and counts it as the skipper’s choice',
        (saved: MapBaseKind) => {
            const { result } = renderHook(() => useMapBase(saved));
            expect(result.current.mapBase).toBe(saved);
            expect(result.current.explicit).toBe(true);
        },
    );

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
        act(() => result.current.setMapBase('satellite'));
        rerender({ saved: 'hybrid' });
        expect(result.current.mapBase).toBe('satellite');
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

    it('keeps the planning surface on Hybrid unless the skipper picked a base', () => {
        expect(hub).toMatch(
            /const shownBase(?::\s*MapBaseKind)?\s*=\s*planningSurface && !baseExplicit \? 'hybrid' : mapBase/,
        );
        expect(hub).toMatch(/mapBaseVisibility\(shownBase\)/);
    });

    it('keeps every base on the ENC imagery treatment (the glaze)', () => {
        expect(hub).toMatch(/const imageryOn(?::\s*boolean)?\s*=\s*true;/);
    });
});
