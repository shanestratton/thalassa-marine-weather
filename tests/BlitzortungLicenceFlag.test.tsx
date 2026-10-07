/**
 * Behind the Blitzortung licence flag (default OFF, build 123): the chart's
 * lightning layer cannot be offered, drawn or counted.
 *
 *  - the radial menu gets no Lightning toggle (as protected areas do when
 *    their own flag is off), so nobody can switch on an empty layer;
 *  - the layer hook adds no source and subscribes to nothing;
 *  - the threat banner never counts strikes, whatever it is told;
 *  - and when the flag IS on, the credit names the source AND its licence —
 *    Blitzortung data is CC BY-SA 4.0 under their own terms.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    subscribe: vi.fn(() => () => {}),
    status: vi.fn((cb: (s: unknown) => void) => {
        cb({
            status: 'open',
            lastStrikeAt: 0,
            strikesReceived: 0,
            strikesPerMinute: 0,
            viewportRate: 0,
            viewportCount: 0,
            currentServer: '',
            retryAttempts: 0,
        });
        return () => {};
    }),
}));

vi.mock('../services/weather/api/blitzortungLightning', () => ({
    subscribeLightningStrikes: mocks.subscribe,
    setLightningViewportStats: vi.fn(),
    subscribeLightningStatus: mocks.status,
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildTacticalState } from '../components/map/buildTacticalState';
import { useLightningLayer } from '../components/map/useLightningLayer';
import { ThreatBanner } from '../components/map/ThreatBanner';
import { BlitzortungAttribution } from '../components/map/BlitzortungAttribution';

function tactical() {
    const noop = vi.fn();
    return buildTacticalState({
        aisVisible: false,
        setAisVisible: noop,
        cycloneVisible: false,
        setCycloneVisible: noop,
        squallVisible: false,
        setSquallVisible: noop,
        allCyclones: [],
        cyclonePickerPendingRef: { current: false },
        setStormPickerOpen: noop,
        setChokepointVisible: noop,
        seamarkVisible: false,
        setSeamarkVisible: noop,
        tideStationsVisible: false,
        setTideStationsVisible: noop,
        anchorageVisible: false,
        setAnchorageVisible: noop,
        lightningVisible: false,
        setLightningVisible: noop,
        weatherInspectMode: false,
        setWeatherInspectMode: noop,
        weather: { setActiveLayer: noop, activeLayers: new Set(), toggleLayer: noop },
        mobActive: false,
        setPage: noop,
    } as never);
}

function fakeMap() {
    return {
        getSource: vi.fn(() => undefined),
        addSource: vi.fn(),
        removeSource: vi.fn(),
        getLayer: vi.fn(() => undefined),
        addLayer: vi.fn(),
        removeLayer: vi.fn(),
        hasImage: vi.fn(() => false),
        addImage: vi.fn(),
        removeImage: vi.fn(),
        getStyle: () => ({ layers: [] }),
        getZoom: () => 3,
        getBounds: () => ({ contains: () => true }),
        flyTo: vi.fn(),
    };
}

beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.subscribe.mockClear();
});

afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
});

describe('the one switch', () => {
    it('is owned by the committed beta profile, and its doc says how to flip it back', () => {
        const profile = JSON.parse(readFileSync('config/public-beta-features.json', 'utf8')) as {
            featureFlags: Record<string, boolean>;
        };
        expect(profile.featureFlags.VITE_BLITZORTUNG_ENABLED).toBe(false);
        const doc = readFileSync('services/weather/api/lightningLicence.ts', 'utf8');
        // A production build refuses an env value that disagrees with the
        // profile, so "set the env var at build time" would only break it.
        expect(doc).not.toMatch(/VITE_BLITZORTUNG_ENABLED=true at build time/);
        expect(doc).toContain('config/public-beta-features.json');
        expect(doc).toContain('scripts/check-beta-readiness.mjs');
        expect(doc).toContain('tests/PublicBetaFeatureProfile.test.ts');
    });
});

describe('flag OFF (the default)', () => {
    it('the radial menu is not offered a Lightning toggle', () => {
        const state = tactical();
        expect(state.onToggleLightning).toBeUndefined();
        expect(state.lightningVisible).toBeUndefined();
    });

    it('the layer hook draws nothing and subscribes to nothing, even when asked to show', () => {
        const map = fakeMap();
        renderHook(() => useLightningLayer({ current: map as never }, true, true));
        expect(map.addSource).not.toHaveBeenCalled();
        expect(map.addLayer).not.toHaveBeenCalled();
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });

    it('the threat banner never subscribes to strikes, whatever it is told', () => {
        render(<ThreatBanner visible userLat={43.3} userLon={5.4} cyclones={[]} lightningActive flyTo={vi.fn()} />);
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });
});

describe('flag ON (flipped back by the build)', () => {
    beforeEach(() => {
        vi.stubEnv('VITE_BLITZORTUNG_ENABLED', 'true');
    });

    it('the radial menu offers the toggle again', () => {
        const state = tactical();
        expect(typeof state.onToggleLightning).toBe('function');
        expect(state.lightningVisible).toBe(false);
    });

    it('the threat banner counts strikes while the layer is on', () => {
        render(<ThreatBanner visible userLat={25.8} userLon={-80.1} cyclones={[]} lightningActive flyTo={vi.fn()} />);
        expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    });

    it('the credit names the source and its CC BY-SA 4.0 licence, compact or full', () => {
        for (const compact of [true, false]) {
            const { unmount } = render(<BlitzortungAttribution visible compact={compact} />);
            expect(screen.getByRole('link', { name: 'Blitzortung.org' })).toHaveAttribute(
                'href',
                'https://www.blitzortung.org',
            );
            expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
                'href',
                'https://creativecommons.org/licenses/by-sa/4.0/',
            );
            unmount();
        }
    });
});
