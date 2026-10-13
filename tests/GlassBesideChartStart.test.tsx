/**
 * Tablets and wide windows start with The Glass beside Obs (Shane 2026-10-13,
 * build 128): "lastly on the ipads etc that have a screen wide enough for two
 * pages at once, can we auto start with the Glass page and the Obs page
 * together. that is from the moment they start the app, if it is in the
 * correct size and if it is in landscape".
 *
 * Our call, recorded: a Settings → Preferences switch, "Start with The Glass
 * beside the chart", on by default and shown only on a screen that can hold two
 * pages. The start is checked once: portrait or narrower opens as today, and
 * rotating or resizing afterwards keeps the split's own rules (App.tsx).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    lastSessionDiedInForeground,
    opensWithGlassBesideChart,
    screenHoldsTwoPages,
} from '../utils/glassBesideChartStart';
import { detectAbnormalExit, markOrderlyExit, markSessionOpen } from '../services/webContentKill';

const innerSize = { width: window.innerWidth, height: window.innerHeight };
function setInnerSize(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

/** A window of this size, answering the two media features the start reads. */
function windowOf(width: number, height: number) {
    setInnerSize(width, height);
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
        const min = /\(min-width:\s*(\d+)px\)/.exec(query);
        const landscape = query.includes('(orientation: landscape)');
        const matches = (!min || width >= Number(min[1])) && (!landscape || width >= height);
        return {
            matches,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        } as unknown as MediaQueryList;
    });
}

function screenOf(width: number, height: number) {
    vi.spyOn(window.screen, 'width', 'get').mockReturnValue(width);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(height);
}

afterEach(() => {
    vi.restoreAllMocks();
    setInnerSize(innerSize.width, innerSize.height);
    localStorage.clear();
    document.querySelectorAll('script[data-test-build]').forEach((el) => el.remove());
});

describe('opensWithGlassBesideChart', () => {
    it.each([
        ['an iPad (iPad12,1) in landscape', 1080, 810],
        ['a 12.9-inch iPad in landscape', 1366, 1024],
        ['the narrowest split, 1024 x 768', 1024, 768],
        ['a laptop browser window', 1440, 900],
    ])('opens split on %s', (_name, width, height) => {
        windowOf(width, height);
        expect(opensWithGlassBesideChart(undefined)).toBe(true);
        expect(opensWithGlassBesideChart(true)).toBe(true);
    });

    it.each([
        ['an iPad in portrait', 810, 1080],
        ['a 12.9-inch iPad in portrait, wide enough but upright', 1024, 1366],
        ['a phone', 390, 844],
        ['a phone on its side', 844, 390],
        ['a large phone on its side', 932, 430],
    ])('opens as today on %s', (_name, width, height) => {
        windowOf(width, height);
        expect(opensWithGlassBesideChart(undefined)).toBe(false);
    });

    it('opens as today when the switch is off', () => {
        windowOf(1080, 810);
        expect(opensWithGlassBesideChart(false)).toBe(false);
    });

    describe('Settings → Orientation, which turns the screen a moment after the start is asked', () => {
        it('Portrait never splits, even when the iPad is held on its side as the app opens', () => {
            windowOf(1080, 810);
            expect(opensWithGlassBesideChart(undefined, 'portrait', true)).toBe(false);
        });

        it('Landscape splits a tablet held upright as the app opens, since the lock turns it on its side', () => {
            windowOf(810, 1080);
            expect(opensWithGlassBesideChart(undefined, 'landscape', true)).toBe(true);
            windowOf(1024, 1366);
            expect(opensWithGlassBesideChart(undefined, 'landscape', true)).toBe(true);
        });

        it('Landscape still never splits a phone, whose long side is too short', () => {
            windowOf(390, 844);
            expect(opensWithGlassBesideChart(undefined, 'landscape', true)).toBe(false);
            windowOf(932, 430);
            expect(opensWithGlassBesideChart(undefined, 'landscape', true)).toBe(false);
        });

        it('Auto, and a browser (where the lock turns nothing), go by the window as it is', () => {
            windowOf(1080, 810);
            expect(opensWithGlassBesideChart(undefined, 'auto', true)).toBe(true);
            expect(opensWithGlassBesideChart(undefined, 'portrait', false)).toBe(true);
            windowOf(810, 1080);
            expect(opensWithGlassBesideChart(undefined, 'landscape', false)).toBe(false);
        });

        it('the switch off still wins', () => {
            windowOf(810, 1080);
            expect(opensWithGlassBesideChart(false, 'landscape', true)).toBe(false);
        });
    });

    it('opens as today where the window cannot be asked', () => {
        vi.spyOn(window, 'matchMedia').mockImplementation(() => {
            throw new Error('no matchMedia');
        });
        expect(opensWithGlassBesideChart(undefined)).toBe(false);
    });
});

describe('straight after a foreground death, The Glass opens alone (no crash loop into the chart)', () => {
    // This page loaded a minute after the last session's flag went up.
    const bootAt = Date.now();
    const before = bootAt - 60_000;

    function addBuildScript(hash: string) {
        const script = document.createElement('script');
        script.setAttribute('src', `/assets/index-${hash}.js`);
        script.setAttribute('data-test-build', '');
        document.head.appendChild(script);
    }

    it('the flag still up from before this page loaded is a death, and the start stands off', () => {
        markSessionOpen('map', before);
        expect(lastSessionDiedInForeground(bootAt)).toBe(true);
        windowOf(1080, 810);
        markSessionOpen('map', performance.timeOrigin - 60_000);
        expect(opensWithGlassBesideChart(undefined)).toBe(false);
    });

    it('a death this boot has already counted (settings came in after the watch) stands off too', () => {
        markSessionOpen('map', before);
        expect(detectAbnormalExit(bootAt + 5)?.count).toBe(1);
        // The watch re-raises the flag for this session.
        markSessionOpen('dashboard', bootAt + 6);
        expect(lastSessionDiedInForeground(bootAt)).toBe(true);
    });

    it('an orderly exit, a first run, or a flag this page raised itself is no death', () => {
        expect(lastSessionDiedInForeground(bootAt)).toBe(false);
        markSessionOpen('map', before);
        markOrderlyExit();
        expect(lastSessionDiedInForeground(bootAt)).toBe(false);
        markSessionOpen('dashboard', bootAt + 1);
        expect(lastSessionDiedInForeground(bootAt)).toBe(false);
        // A death counted by an EARLIER boot does not hold the start back now.
        markSessionOpen('map', before - 60_000);
        detectAbnormalExit(before);
        markSessionOpen('dashboard', bootAt + 1);
        expect(lastSessionDiedInForeground(bootAt)).toBe(false);
        windowOf(1080, 810);
        expect(opensWithGlassBesideChart(undefined)).toBe(true);
    });

    it('a flag left by another build is a reinstall (Xcode stops the running app), as the watch reads it', () => {
        addBuildScript('OLDBUILD01');
        markSessionOpen('map', before);
        document.querySelectorAll('script[data-test-build]').forEach((el) => el.remove());
        addBuildScript('NEWBUILD02');
        expect(lastSessionDiedInForeground(bootAt)).toBe(false);
        // The same build left it: a death.
        document.querySelectorAll('script[data-test-build]').forEach((el) => el.remove());
        addBuildScript('OLDBUILD01');
        expect(lastSessionDiedInForeground(bootAt)).toBe(true);
    });
});

describe("the start opens Obs without overwriting the last session's crumb", () => {
    beforeEach(() => {
        vi.resetModules();
        localStorage.clear();
    });

    it('a kill on the Log is still booked to the Log, and then the crumb names the chart', async () => {
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'details', at: Date.now() - 60_000 }));
        const kill = await import('../services/webContentKill');
        kill.markSessionOpen('details', Date.now() - 60_000);
        const ui = await import('../stores/uiStore');

        ui.showBootView('map');
        expect(ui.useUIStore.getState().currentView).toBe('map');
        expect(ui.useUIStore.getState().previousView).toBe('dashboard');
        expect(ui.readLastView()?.view).toBe('details');

        // The session watch, as useAppBootstrap runs it.
        const died = kill.detectAbnormalExit();
        ui.sessionCrumbConsumed();
        expect(died?.view).toBe('details');
        expect(kill.readAbnormalExit()?.view).toBe('details');
        expect(ui.readLastView()?.view).toBe('map');
    });

    it('once the watch has read the crumb, a late start (settings loaded slowly) writes it at once', async () => {
        const ui = await import('../stores/uiStore');
        ui.sessionCrumbConsumed();
        ui.showBootView('map');
        expect(ui.readLastView()?.view).toBe('map');
    });

    it("a real navigation before the watch reads keeps its own crumb, not the start's", async () => {
        const ui = await import('../stores/uiStore');
        ui.showBootView('map');
        ui.useUIStore.getState().setPage('details');
        ui.sessionCrumbConsumed();
        expect(ui.readLastView()?.view).toBe('details');
    });
});

describe('screenHoldsTwoPages', () => {
    it('is a screen 1024 or more on its long side, whichever way up it is held', () => {
        screenOf(810, 1080);
        expect(screenHoldsTwoPages()).toBe(true);
        screenOf(1440, 900);
        expect(screenHoldsTwoPages()).toBe(true);
        screenOf(430, 932);
        expect(screenHoldsTwoPages()).toBe(false);
        screenOf(390, 844);
        expect(screenHoldsTwoPages()).toBe(false);
    });
});

describe('Settings → Preferences: Start with The Glass beside the chart', () => {
    const props = {
        onSave: vi.fn(),
        onLocationSelect: vi.fn(),
        onDetectLocation: vi.fn(),
        onShowFactoryReset: vi.fn(),
    };

    async function renderPreferences(settingsOver: Record<string, unknown> = {}) {
        vi.stubGlobal('__BUILD_STAMP__', '2026-10-13 00:00Z');
        const { GeneralTab } = await import('../components/settings/GeneralTab');
        const { DEFAULT_SETTINGS } = await import('../stores/settingsStore');
        props.onSave.mockClear();
        return render(
            React.createElement(GeneralTab, { settings: { ...DEFAULT_SETTINGS, ...settingsOver }, ...props }),
        );
    }

    it('is on by default on a tablet, says what it does, and switching it off saves false', async () => {
        screenOf(810, 1080);
        const { DEFAULT_SETTINGS } = await import('../stores/settingsStore');
        expect(DEFAULT_SETTINGS.glassBesideChartAtStart).not.toBe(false);
        await renderPreferences();
        const toggle = screen.getByRole('switch', { name: 'Start with The Glass beside the chart' });
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        const row = toggle.parentElement as HTMLElement;
        expect(row.textContent).toMatch(/landscape/i);
        expect(row.textContent).toMatch(/Hold The Glass/);
        // A global app: nothing national in the words.
        expect(row.textContent).not.toMatch(/Australia|Queensland|BOM/);
        fireEvent.click(toggle);
        expect(props.onSave).toHaveBeenCalledWith({ glassBesideChartAtStart: false });
    });

    it('stays off once switched off, and switching it on saves true', async () => {
        screenOf(1366, 1024);
        await renderPreferences({ glassBesideChartAtStart: false });
        const toggle = screen.getByRole('switch', { name: 'Start with The Glass beside the chart' });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(toggle);
        expect(props.onSave).toHaveBeenCalledWith({ glassBesideChartAtStart: true });
    });

    it('is not offered on a phone, whose screen never holds two pages', async () => {
        screenOf(390, 844);
        await renderPreferences();
        expect(screen.queryByRole('switch', { name: 'Start with The Glass beside the chart' })).toBeNull();
    });
});

describe('App.tsx: the start, once', () => {
    const app = readFileSync(resolve(process.cwd(), 'App.tsx'), 'utf8');
    const start = app.slice(app.indexOf('// Tablets and wide windows start'), app.indexOf('const toggleSplitView'));

    it('asks once, after settings load, and only from a cold Glass start', () => {
        expect(start).toContain(
            'opensWithGlassBesideChart(settings.glassBesideChartAtStart, settings.screenOrientation)',
        );
        expect(start).toMatch(/if \(splitStartCheckedRef\.current \|\| settingsLoading\) return;/);
        expect(start).toMatch(/splitStartCheckedRef\.current = true;/);
        expect(start).toMatch(/currentView !== 'dashboard'/);
    });

    it("pins the split for this run and opens Obs, without rewriting the hold's saved choice", () => {
        expect(start).toContain('setSplitViewEnabled(true);');
        // A boot step, not a navigation: setPage would overwrite the crumb
        // the session watch has yet to read.
        expect(start).toContain("showBootView('map');");
        expect(start).not.toContain('setPage(');
        expect(start).not.toContain('rememberSplitView');
        expect(start).not.toContain('thalassa_split_view');
    });

    it('the bootstrap hands the crumb over only once the session watch has read it', () => {
        const boot = readFileSync(resolve(process.cwd(), 'hooks/useAppBootstrap.ts'), 'utf8');
        const armed = boot.indexOf('armSessionWatch(crumb?.view ?? null);');
        expect(armed).toBeGreaterThan(-1);
        expect(boot.indexOf('sessionCrumbConsumed();', armed)).toBeGreaterThan(armed);
    });
});
