import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import SharperSatelliteLayer from '../components/map/SharperSatelliteLayer';
import type {
    PreparedSatelliteFrame,
    SatelliteImagePlan,
    SatelliteTimesLease,
} from '../services/weather/satelliteView';
import type { SatelliteViewFrame, SatelliteViewProduct } from '../services/weather/satelliteViewContract';
import type { AtmosCredit } from '../components/map/atmosPresentation';
import type { OwnedImageOverlayOptions, OwnedImageFrame } from '../components/map/useOwnedImageOverlay';
const f = vi.hoisted(() => ({
    metered: false,
    stuck: false,
    read: vi.fn(),
    prepare: vi.fn(),
    claims: new WeakSet<object>(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: unknown) => unknown) => selector({ settings: { satelliteMode: f.metered } }),
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => f.metered }));
vi.mock('../services/weather/satelliteView', async (original) => ({
    ...(await original<typeof import('../services/weather/satelliteView')>()),
    readSatelliteTimes: f.read,
    prepareSatelliteFrame: f.prepare,
}));
vi.mock('../components/map/useOwnedImageOverlay', () => ({
    useOwnedImageOverlay: (_ref: unknown, _ready: boolean, options: OwnedImageOverlayOptions) => {
        if (f.stuck) return 'stuck-visible';
        if (!options.enabled) return 'off';
        if (!options.owner || !options.sourceCurrent()) return 'unavailable';
        if (!f.claims.has(options.owner)) {
            options.prepare(() => undefined);
            f.claims.add(options.owner);
        }
        return 'ready';
    },
}));
const NOW = Date.parse('2026-10-17T03:30:00Z');
const status = () => within(screen.getByRole('region', { name: 'Sharper satellite controls' })).getByRole('status');
function source(product: SatelliteViewProduct, signal: AbortSignal, current: () => boolean): SatelliteTimesLease {
    let closed = false;
    const daily = product === 'viirs-night';
    const frames = Array.from({ length: 3 }, (_, index) => {
        const timeMs = daily
            ? Date.parse('2026-10-15T00:00:00Z') + index * 86400000
            : Date.parse('2026-10-17T00:00:00Z') + index * 3600000;
        return {
            iso: daily
                ? new Date(timeMs).toISOString().slice(0, 10)
                : new Date(timeMs).toISOString().replace('.000Z', 'Z'),
            timeMs,
            daily,
        };
    });
    return {
        times: { product, metadataUrl: 'https://gibs.earthdata.nasa.gov/metadata', readAtMs: NOW, frames },
        isCurrent: () => !closed && !signal.aborted && current(),
        close: () => {
            closed = true;
        },
    };
}
function prepared(
    lease: SatelliteTimesLease,
    frame: SatelliteViewFrame,
    plan: SatelliteImagePlan,
    signal: AbortSignal,
    current: () => boolean,
): PreparedSatelliteFrame {
    return {
        product: lease.times.product,
        frame,
        plan,
        metadataUrl: lease.times.metadataUrl,
        metadataReadAtMs: NOW,
        alphaFraction: 1,
        isCurrent: () => !signal.aborted && lease.isCurrent() && current(),
        claim: vi.fn(
            (): OwnedImageFrame => ({
                url: 'data:image/png;base64,fixture',
                width: 1,
                height: 1,
                coordinates: [
                    [0, 1],
                    [1, 1],
                    [1, 0],
                    [0, 0],
                ],
            }),
        ),
        releaseUnclaimed: vi.fn(),
    };
}
function mapFixture() {
    const events = new Map<string, Set<() => void>>();
    let box = [0, 0, 10, 10];
    const map = {
        getBounds: () => ({
            getWest: () => box[0],
            getSouth: () => box[1],
            getEast: () => box[2],
            getNorth: () => box[3],
        }),
        on: (event: string, fn: () => void) => {
            if (!events.has(event)) events.set(event, new Set());
            events.get(event)!.add(fn);
        },
        off: (event: string, fn: () => void) => events.get(event)?.delete(fn),
    };
    return {
        ref: { current: map as unknown as mapboxgl.Map },
        move: (next: number[]) => {
            box = next;
            for (const fn of events.get('moveend') ?? []) fn();
        },
    };
}
function Harness({
    refValue,
    active = true,
    fallback = () => undefined,
}: {
    refValue: React.MutableRefObject<mapboxgl.Map | null>;
    active?: boolean;
    fallback?: () => void;
}) {
    const [credit, setCredit] = React.useState<AtmosCredit | null>(null),
        [controls, setControls] = React.useState<React.ReactNode>(null);
    return (
        <>
            <SharperSatelliteLayer
                mapRef={refValue}
                mapReady
                active={active}
                onCredit={setCredit}
                onControls={setControls}
                onFallback={fallback}
            />
            {controls}
            <output data-testid="credit">{credit?.text}</output>
        </>
    );
}
async function settle() {
    for (let i = 0; i < 5; i++)
        await act(async () => {
            await Promise.resolve();
        });
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('VITE_SHARPER_SATELLITE_ENABLED', 'true');
    vi.clearAllMocks();
    f.metered = false;
    f.stuck = false;
    f.claims = new WeakSet();
    f.read.mockImplementation(async (...args: Parameters<typeof source>) => source(...args));
    f.prepare.mockImplementation(async (...args: Parameters<typeof prepared>) => prepared(...args));
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});
describe('actual sharper-satellite source/time controls', () => {
    it('keeps the literal flag OFF without data reads or UI/credit rows', async () => {
        vi.stubEnv('VITE_SHARPER_SATELLITE_ENABLED', 'false');
        render(<Harness refValue={mapFixture().ref} />);
        await settle();
        expect(f.read).not.toHaveBeenCalled();
        expect(f.prepare).not.toHaveBeenCalled();
        expect(screen.queryByRole('region')).toBe(null);
        expect(screen.getByTestId('credit').textContent).toBe('');
    });
    it('selects the real regional source, shows metadata-listed time and uses the existing callback surface', async () => {
        const fallback = vi.fn();
        render(<Harness refValue={mapFixture().ref} fallback={fallback} />);
        await settle();
        expect(f.read).toHaveBeenCalledTimes(1);
        expect(f.read.mock.calls[0][0]).toBe('meteosat-ir');
        expect(status()).toHaveTextContent('Listed frame 2026-10-17 02:00:00 UTC');
        fireEvent.click(screen.getByRole('button', { name: 'Info' }));
        await settle();
        expect(screen.getByRole('region')).toHaveTextContent('not surface fog or visibility');
        fireEvent.click(screen.getByRole('button', { name: 'Hourly mosaic' }));
        expect(fallback).toHaveBeenCalledOnce();
    });
    it('retries a different lease even when metadata readAt and every source/time/window string are identical', async () => {
        render(<Harness refValue={mapFixture().ref} />);
        await settle();
        expect(f.prepare).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await settle();
        expect(f.read).toHaveBeenCalledTimes(2);
        expect(f.prepare).toHaveBeenCalledTimes(2);
        expect(status()).toHaveTextContent('Listed frame');
        expect(f.prepare.mock.calls[0][0]).not.toBe(f.prepare.mock.calls[1][0]);
    });
    it('labels VIIRS as a daily composite and water vapour as upper moisture, not an instant fog observation', async () => {
        render(<Harness refValue={mapFixture().ref} />);
        await settle();
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'viirs-night' } });
        await settle();
        expect(status()).toHaveTextContent('2026-10-17 · daily night composite');
        expect(screen.getByTestId('credit')).toHaveTextContent('observation time within day unknown');
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'water-vapour' } });
        await settle();
        expect(screen.getByTestId('credit')).toHaveTextContent('not surface fog');
    });
    it('plays once through original listed frames, waits for each prepared owner and then stops', async () => {
        render(<Harness refValue={mapFixture().ref} />);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Play once' }));
        await settle();
        expect(status()).toHaveTextContent('00:00:00 UTC');
        act(() => vi.advanceTimersByTime(1000));
        await settle();
        expect(status()).toHaveTextContent('01:00:00 UTC');
        act(() => vi.advanceTimersByTime(1000));
        await settle();
        expect(status()).toHaveTextContent('02:00:00 UTC');
        expect(screen.getByRole('button', { name: 'Play once' })).toBeEnabled();
        const count = f.prepare.mock.calls.length;
        act(() => vi.advanceTimersByTime(10000));
        await settle();
        expect(f.prepare).toHaveBeenCalledTimes(count);
    });
    it('coalesces map moves and reuses source times without renewing their metadata clock', async () => {
        const map = mapFixture();
        render(<Harness refValue={map.ref} />);
        await settle();
        act(() => {
            for (let i = 0; i < 20; i++) map.move([20 + i, 0, 30 + i, 10]);
            vi.advanceTimersByTime(250);
        });
        await settle();
        expect(f.read).toHaveBeenCalledTimes(1);
        expect(f.prepare).toHaveBeenCalledTimes(2);
    });
    it('discards a prior source preparation that completes after source selection changed', async () => {
        let resolve!: (value: PreparedSatelliteFrame) => void;
        let old!: PreparedSatelliteFrame;
        f.prepare.mockImplementationOnce((...args: Parameters<typeof prepared>) => {
            old = prepared(...args);
            return new Promise<PreparedSatelliteFrame>((finish) => {
                resolve = finish;
            });
        });
        render(<Harness refValue={mapFixture().ref} />);
        await settle();
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'goes-east-ir' } });
        await settle();
        await act(async () => resolve(old));
        await settle();
        expect(old.releaseUnclaimed).toHaveBeenCalled();
        expect(screen.getByTestId('credit')).toHaveTextContent('NOAA GOES-East');
        expect(status()).toHaveTextContent('Listed frame');
    });
    it('preserves the original attributed source when user-off removal is uncertain', async () => {
        const map = mapFixture(),
            view = render(<Harness refValue={map.ref} />);
        await settle();
        f.stuck = true;
        view.rerender(<Harness refValue={map.ref} active={false} />);
        await settle();
        expect(status()).toHaveTextContent('Removal uncertain');
        expect(screen.getByTestId('credit')).toHaveTextContent('EUMETSAT Meteosat');
    });
    it('blocks WAN in Satellite Mode and releases all timers/listeners on unmount', async () => {
        f.metered = true;
        const view = render(<Harness refValue={mapFixture().ref} />);
        await settle();
        expect(f.read).not.toHaveBeenCalled();
        expect(status()).toHaveTextContent('paused in Satellite Mode');
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
