import { readFileSync } from 'node:fs';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapBaseSelector, mapBaseVisibility, type MapBaseKind } from '../components/map/MapBaseSelector';
import { useMapBase } from '../components/map/useMapBase';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function Harness({ daylightMode }: { daylightMode: boolean }) {
    const { mapBase, setMapBase } = useMapBase(daylightMode);
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

function selectBase(label: 'Ocean' | 'Satellite' | 'Hybrid') {
    fireEvent.click(screen.getByRole('button', { name: /^Map base:/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: new RegExp(`^${label} `) }));
}

describe('OBS map defaults follow the resolved display mode', () => {
    it.each([
        [true, 'ocean'],
        [false, 'satellite'],
    ] as const)('daylight=%s begins on %s', (daylightMode, expected) => {
        const { result } = renderHook(() => useMapBase(daylightMode));
        expect(result.current.mapBase).toBe(expected);
        expect(Object.values(mapBaseVisibility(result.current.mapBase)).filter(Boolean)).toHaveLength(1);
    });

    it('changes defaults on a mounted map when daylight changes, without a remount', () => {
        const { result, rerender } = renderHook(({ daylightMode }) => useMapBase(daylightMode), {
            initialProps: { daylightMode: false },
        });
        expect(result.current.mapBase).toBe('satellite');
        rerender({ daylightMode: true });
        expect(result.current.mapBase).toBe('ocean');
        rerender({ daylightMode: false });
        expect(result.current.mapBase).toBe('satellite');
    });

    it.each(['hybrid', 'satellite', 'ocean'] as const)(
        'retains a manual %s selection across ordinary rerenders',
        (choice: MapBaseKind) => {
            const { result, rerender } = renderHook(({ daylightMode }) => useMapBase(daylightMode), {
                initialProps: { daylightMode: true },
            });
            act(() => result.current.setMapBase(choice));
            rerender({ daylightMode: true });
            rerender({ daylightMode: true });
            expect(result.current.mapBase).toBe(choice);
        },
    );

    it('remembers day and dark choices independently for the current map session', () => {
        const { result, rerender } = renderHook(({ daylightMode }) => useMapBase(daylightMode), {
            initialProps: { daylightMode: true },
        });
        act(() => result.current.setMapBase('satellite'));
        rerender({ daylightMode: false });
        expect(result.current.mapBase).toBe('satellite');
        act(() => result.current.setMapBase('hybrid'));
        rerender({ daylightMode: true });
        expect(result.current.mapBase).toBe('satellite');
        rerender({ daylightMode: false });
        expect(result.current.mapBase).toBe('hybrid');
    });

    it('does not persist a manual map selection into a new session', () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem');
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        const first = renderHook(() => useMapBase(true));
        act(() => first.result.current.setMapBase('hybrid'));
        expect(first.result.current.mapBase).toBe('hybrid');
        first.unmount();

        const second = renderHook(() => useMapBase(true));
        expect(second.result.current.mapBase).toBe('ocean');
        expect(getItem).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
    });

    it('does not share a manual override with another map instance', () => {
        const obs = renderHook(() => useMapBase(true));
        const anotherMap = renderHook(() => useMapBase(false));
        act(() => obs.result.current.setMapBase('hybrid'));
        expect(obs.result.current.mapBase).toBe('hybrid');
        expect(anotherMap.result.current.mapBase).toBe('satellite');
    });

    it('keeps the actual selector usable and in sync with independent day/dark choices', () => {
        const { rerender } = render(<Harness daylightMode />);
        expect(screen.getByRole('button', { name: 'Map base: Ocean' })).toBeInTheDocument();
        selectBase('Satellite');
        expect(screen.getByRole('button', { name: 'Map base: Satellite' })).toBeInTheDocument();

        rerender(<Harness daylightMode={false} />);
        selectBase('Hybrid');
        expect(screen.getByRole('button', { name: 'Map base: Hybrid' })).toBeInTheDocument();

        rerender(<Harness daylightMode />);
        expect(screen.getByRole('button', { name: 'Map base: Satellite' })).toBeInTheDocument();
        selectBase('Ocean');
        rerender(<Harness daylightMode={false} />);
        expect(screen.getByRole('button', { name: 'Map base: Hybrid' })).toBeInTheDocument();
    });
});

// WebGL itself is outside this focused hook test. Pin the narrow integration
// boundary so the tested hook cannot be left disconnected from the real map.
function source(path: string) {
    return readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

describe('OBS display-mode wiring', () => {
    it('uses App’s resolved light mode, including auto, rather than the environment theme', () => {
        const app = source('App.tsx');
        const calls = [...app.matchAll(/<MapHub\b[\s\S]*?\/>/g)].map(([call]) => call);
        expect(calls).toHaveLength(1);
        expect(app).toMatch(/const isLight\s*=\s*effectiveMode\s*===\s*'light'/);
        expect(calls[0]).toMatch(/daylightMode=\{isLight\}/);
        // Auto already resolves through the app controller. The map must not
        // invent a second clock/sunrise rule or treat literal 'auto' as dark.
        const controller = source('hooks/useAppController.ts');
        expect(controller).toContain("settings.displayMode === 'auto'");
        expect(controller).toContain("effectiveMode = isNight ? 'dark' : 'light'");
    });

    it('connects the hook to MapHub and leaves other surfaces on the prior default', () => {
        const hub = source('components/map/MapHub.tsx');
        expect(source('components/map/mapConstants.ts')).toMatch(/daylightMode\?:\s*boolean/);
        expect(hub).toMatch(/daylightMode\s*=\s*false/);
        expect(hub).toMatch(/\{\s*mapBase,\s*setMapBase\s*\}\s*=\s*useMapBase\(daylightMode\)/);
        const selector = hub.match(/<MapBaseSelector\b[\s\S]*?\/>/)?.[0];
        expect(selector).toContain('value={mapBase}');
        expect(selector).toContain('onChange={setMapBase}');
        for (const path of ['components/RoutePlanner.tsx', 'components/onboarding/HomePortStep.tsx']) {
            const calls = [...source(path).matchAll(/<MapHub\b[\s\S]*?\/>/g)].map(([call]) => call);
            expect(calls.length).toBeGreaterThan(0);
            for (const call of calls) expect(call).not.toContain('daylightMode');
        }
    });
});
