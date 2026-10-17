import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AscatObservedLayer from '../components/map/AscatObservedLayer';
import { ownedVectorFixture } from './helpers/ownedVectorFixture';
import { openAscatSession, type AscatSession } from '../services/weather/ascatSession';
import {
    decodeAscatIndex,
    decodeAscatPointer,
    decodeAscatTile,
    type AscatRow,
} from '../services/weather/ascatContract';
import { ascatOverlay, ASCAT_SOURCE, ASCAT_LINES } from '../services/weather/ascatPresentation';
import { setAuthIdentityScope } from '../services/authIdentityScope';
vi.mock('../services/weather/ascatSession', () => ({ openAscatSession: vi.fn() }));
vi.mock('../components/Toast', () => ({ toast: { persistentError: vi.fn(() => 1), dismiss: vi.fn() } }));
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/ascat141-packet.json'), 'utf8'));
const pointer = decodeAscatPointer(JSON.parse(fixture.resources['latest.json']), fixture.now);
const index = decodeAscatIndex(
    JSON.parse(fixture.resources[`generations/${pointer.generation}/index.json`]),
    pointer,
    fixture.now,
);
const key = Object.keys(index.tiles)[0];
const rows = decodeAscatTile(
    JSON.parse(fixture.resources[`generations/${pointer.generation}/tile-${key}.json`]),
    key,
    index,
    fixture.now,
);
let current = true;
const close = vi.fn(() => {
    current = false;
});
const readViewport = vi.fn<AscatSession['readViewport']>();
const session: AscatSession = { index, close, readViewport, isCurrent: () => current };
function mapFixture() {
    const f = ownedVectorFixture();
    Object.assign(f.map, {
        getContainer: () => ({ clientWidth: 375, clientHeight: 667 }),
        getCenter: () => ({ lng: 154.1, lat: -27 }),
        getBounds: () => ({ getWest: () => 153, getSouth: () => -28, getEast: () => 155, getNorth: () => -26 }),
        project: ([lon, lat]: [number, number]) => ({ x: 100 + (lon - 154) * 500, y: 100 - (lat + 27) * 500 }),
        unproject: ([x, y]: [number, number]) => ({ lng: 154 + (x - 100) / 500, lat: -27 - (y - 100) / 500 }),
        queryRenderedFeatures: vi.fn(() => [{ source: ASCAT_SOURCE, properties: { row: 0 } }]),
    });
    return f;
}
function props(f = mapFixture()) {
    return {
        f,
        value: {
            mapRef: f.mapRef,
            mapReady: true,
            active: true,
            canInteract: true,
            onCredit: vi.fn(),
            onInteractionChange: vi.fn(),
        },
    };
}
beforeEach(() => {
    current = true;
    close.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(fixture.now * 1000 + 1000);
    readViewport.mockReset().mockResolvedValue({ generation: pointer.generation, revision: 1, rows });
    vi.mocked(openAscatSession).mockReset().mockResolvedValue(session);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
describe('actual satellite source ownership', () => {
    it('starts no reads while OFF, then removes owned arrows and closes the session on Hide all', async () => {
        const { f, value } = props();
        const view = render(<AscatObservedLayer {...value} active={false} />);
        expect(openAscatSession).not.toHaveBeenCalled();
        view.rerender(<AscatObservedLayer {...value} />);
        await waitFor(() => expect(f.map.sources.has(ASCAT_SOURCE)).toBe(true));
        act(() => f.map.emit('sourcedata', { sourceId: ASCAT_SOURCE, sourceDataType: 'content' }));
        expect(f.map.getLayer(ASCAT_LINES)).toBeTruthy();
        expect(value.onCredit.mock.lastCall?.[0]?.text).toContain('25 km effective resolution');
        view.rerender(<AscatObservedLayer {...value} active={false} />);
        await waitFor(() => expect(f.map.sources.has(ASCAT_SOURCE)).toBe(false));
        expect(close).toHaveBeenCalledOnce();
        expect(openAscatSession).toHaveBeenCalledOnce();
    });
    it('opens an original-time popup through 44px hit query only after competing gestures release', async () => {
        const { f, value } = props();
        const view = render(<AscatObservedLayer {...value} canInteract={false} />);
        await waitFor(() => expect(f.map.sources.has(ASCAT_SOURCE)).toBe(true));
        act(() => f.map.emit('sourcedata', { sourceId: ASCAT_SOURCE, sourceDataType: 'content' }));
        const nativePrevent = vi.fn(),
            preventDefault = vi.fn();
        const event = {
            point: { x: 100, y: 100 },
            originalEvent: { defaultPrevented: false, preventDefault: nativePrevent },
            preventDefault,
        };
        act(() => f.map.emit('click', event));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        view.rerender(<AscatObservedLayer {...value} />);
        act(() => f.map.emit('click', event));
        await screen.findByRole('dialog');
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(nativePrevent).toHaveBeenCalledOnce();
        expect(
            (f.map as unknown as { queryRenderedFeatures: ReturnType<typeof vi.fn> }).queryRenderedFeatures,
        ).toHaveBeenCalledWith(
            [
                [78, 78],
                [122, 122],
            ],
            { layers: ['ascat-observed141-arrows', 'ascat-observed141-calm'] },
        );
        expect(screen.getByText(/Forecast comparison unavailable/)).toBeInTheDocument();
        expect(screen.getByText(/Observed .*UTC · Metop-C/)).toBeInTheDocument();
        expect(value.onInteractionChange).toHaveBeenCalledWith(true);
        fireEvent.click(screen.getByRole('button', { name: 'Close satellite wind' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(value.onInteractionChange).toHaveBeenLastCalledWith(false);
    });
    it('retires A/B/A authority synchronously and refuses its late viewport result', async () => {
        let release!: (v: Awaited<ReturnType<AscatSession['readViewport']>>) => void;
        readViewport.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        setAuthIdentityScope('ascat-fixture-A');
        const { f, value } = props();
        render(<AscatObservedLayer {...value} />);
        await waitFor(() => expect(readViewport).toHaveBeenCalledOnce());
        act(() => {
            setAuthIdentityScope('ascat-fixture-B');
            setAuthIdentityScope('ascat-fixture-A');
        });
        expect(close).toHaveBeenCalled();
        await act(async () => release({ generation: pointer.generation, revision: 1, rows }));
        expect(f.map.sources.has(ASCAT_SOURCE)).toBe(false);
        expect(openAscatSession).toHaveBeenCalledOnce();
    });
    it('does no foreground or offline reads and removes existing geometry on background', async () => {
        const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
        const { f, value } = props();
        render(<AscatObservedLayer {...value} />);
        expect(openAscatSession).not.toHaveBeenCalled();
        visible.mockReturnValue('visible');
        online.mockReturnValue(false);
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('offline'));
        });
        expect(openAscatSession).not.toHaveBeenCalled();
        online.mockReturnValue(true);
        act(() => window.dispatchEvent(new Event('online')));
        await waitFor(() => expect(f.map.sources.has(ASCAT_SOURCE)).toBe(true));
        visible.mockReturnValue('hidden');
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        await waitFor(() => expect(f.map.sources.has(ASCAT_SOURCE)).toBe(false));
        expect(vi.mocked(openAscatSession).mock.calls[0][0].aborted).toBe(true);
    });
    it('leaves a wide view empty with an honest zoom credit and restores only its own source after style reload', async () => {
        const { f, value } = props();
        render(<AscatObservedLayer {...value} />);
        await waitFor(() => expect(f.map.sources.has(ASCAT_SOURCE)).toBe(true));
        act(() => f.map.restyle());
        await waitFor(() => expect(f.map.sources.has(ASCAT_SOURCE)).toBe(true));
        readViewport.mockRejectedValue(new Error('Zoom in to at most nine tiles'));
        act(() => f.map.emit('moveend'));
        await waitFor(() => expect(value.onCredit.mock.lastCall?.[0]?.text).toContain('Zoom in'));
        expect(f.map.getLayer('hybrid-base-layer')).toBeTruthy();
        expect(f.map.getLayer('enc-vec-depth')).toBeTruthy();
    });
});
describe('bounded observed arrow geometry', () => {
    it('preserves zero wind and original FROM values while drawing positive wind downwind', () => {
        const { f } = props();
        const result = ascatOverlay(f.mapRef.current!, rows, fixture.now * 1000);
        expect(result.shown).toEqual([...rows].sort((a, b) => b[2] - a[2]));
        expect(result.shown.every((row) => rows.includes(row))).toBe(true);
        expect(result.data.features.some((feature) => feature.geometry.type === 'Point')).toBe(true);
        expect(result.data.features.some((feature) => feature.geometry.type === 'LineString')).toBe(true);
        const fromNorth: AscatRow = [154, -27, fixture.now - 30, 10, 0, 0];
        const line = ascatOverlay(f.mapRef.current!, [fromNorth], fixture.now * 1000).data.features[0]
            .geometry as GeoJSON.LineString;
        expect(line.coordinates[1][1]).toBeLessThan(line.coordinates[0][1]);
        expect(fromNorth[4]).toBe(0);
        expect(ascatOverlay(f.mapRef.current!, rows, (fixture.now + 86401) * 1000).shown).toHaveLength(0);
    });
    it('caps actual screen vectors at600 and refuses projected/dateline geometry that would wrap the world', () => {
        const f = mapFixture();
        Object.assign(f.map, {
            getContainer: () => ({ clientWidth: 2000, clientHeight: 2000 }),
            getCenter: () => ({ lng: -175, lat: -80 }),
            project: ([lon, lat]: [number, number]) => ({ x: (lon + 180) * 100, y: (lat + 90) * 100 }),
            unproject: ([x, y]: [number, number]) => ({ lng: x / 100 - 180, lat: y / 100 - 90 }),
        });
        const many: AscatRow[] = Array.from({ length: 1000 }, (_, n) => [
            -179 + (n % 40) * 0.3,
            -89 + Math.floor(n / 40) * 0.3 + 5,
            fixture.now - n,
            10,
            0,
            0,
        ]);
        expect(ascatOverlay(f.mapRef.current!, many, fixture.now * 1000).shown).toHaveLength(600);
        Object.assign(f.map, { project: () => ({ x: 100, y: 100 }), unproject: () => ({ lng: -179.9, lat: -27 }) });
        expect(
            ascatOverlay(f.mapRef.current!, [[179.9, -27, fixture.now - 1, 10, 90, 0]], fixture.now * 1000).shown,
        ).toHaveLength(0);
    });
});
