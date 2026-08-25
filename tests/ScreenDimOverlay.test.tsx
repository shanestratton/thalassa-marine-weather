/**
 * ScreenDimOverlay — app-wide screen dimming (Shane 2026-08-26; generalised
 * from anchor-watch-only the same day).
 *
 * The contract that matters at 0300 on the hook: the screen dims only
 * after idle, the FIRST touch wakes it and is swallowed, and any anomaly
 * (active=false — alarm, drifting, blocked) restores full brightness
 * immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { WATCH_DIM_IDLE_MS, ScreenDimOverlay as WatchDimOverlay } from '../components/ScreenDimOverlay';

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const overlay = () => screen.getByTestId('watch-dim-overlay');

describe('WatchDimOverlay', () => {
    it('stays lit until the idle window passes, then dims to the configured level', () => {
        render(<WatchDimOverlay active opacityPercent={80} />);
        expect(overlay().style.opacity).toBe('0');
        act(() => vi.advanceTimersByTime(WATCH_DIM_IDLE_MS + 100));
        expect(overlay().style.opacity).toBe('0.8');
    });

    it('a touch while lit re-arms the countdown instead of dimming early', () => {
        render(<WatchDimOverlay active opacityPercent={80} />);
        act(() => vi.advanceTimersByTime(WATCH_DIM_IDLE_MS - 1_000));
        fireEvent.pointerDown(window);
        act(() => vi.advanceTimersByTime(WATCH_DIM_IDLE_MS - 1_000));
        expect(overlay().style.opacity).toBe('0');
        act(() => vi.advanceTimersByTime(2_000));
        expect(overlay().style.opacity).toBe('0.8');
    });

    it('the waking touch is swallowed — it must never reach a control underneath', () => {
        render(<WatchDimOverlay active opacityPercent={90} />);
        act(() => vi.advanceTimersByTime(WATCH_DIM_IDLE_MS + 100));
        expect(overlay().className).toContain('pointer-events-auto');

        const behind = vi.fn();
        window.addEventListener('pointerdown', behind);
        const event = fireEvent.pointerDown(overlay());
        window.removeEventListener('pointerdown', behind);

        // stopPropagation held the event at the overlay, and the screen woke.
        expect(event).toBe(false); // preventDefault was called
        expect(behind).not.toHaveBeenCalled();
        expect(overlay().style.opacity).toBe('0');
        expect(overlay().className).toContain('pointer-events-none');
    });

    it('active=false (alarm, drifting, blocked) restores full brightness immediately', () => {
        const { rerender } = render(<WatchDimOverlay active opacityPercent={80} />);
        act(() => vi.advanceTimersByTime(WATCH_DIM_IDLE_MS + 100));
        expect(overlay().style.opacity).toBe('0.8');
        rerender(<WatchDimOverlay active={false} opacityPercent={80} />);
        expect(screen.queryByTestId('watch-dim-overlay')).toBeNull();
    });

    it('caps opacity below total black so "tap to wake" stays visible', () => {
        render(<WatchDimOverlay active opacityPercent={100} />);
        act(() => vi.advanceTimersByTime(WATCH_DIM_IDLE_MS + 100));
        expect(Number(overlay().style.opacity)).toBeLessThanOrEqual(0.98);
        expect(overlay().textContent).toContain('tap to wake');
    });
});

describe('app-wide wiring (source tripwires)', () => {
    const read = (rel: string) => {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const { resolve } = require('node:path') as typeof import('node:path');
        return readFileSync(resolve(process.cwd(), rel), 'utf8');
    };

    it('the host mounts ONCE at the app root, beside the night scrim', () => {
        const app = read('App.tsx');
        expect(app).toContain('<ScreenDimHost />');
        const anchorPage = read('components/AnchorWatchPage.tsx');
        expect(anchorPage).not.toContain('WatchDimOverlay');
        expect(anchorPage).not.toContain('ScreenDimOverlay');
    });

    it('sits below the critical alarm tier — alarms outrank it in z', () => {
        const overlay = read('components/ScreenDimOverlay.tsx');
        expect(overlay).toContain('SCREEN_DIM_Z_INDEX = NIGHT_SCRIM_Z_INDEX - 1');
    });

    it('an anchor-drag alarm and a live MOB suppress dimming for their whole lifetime', () => {
        const anchor = read('services/AnchorWatchService.ts');
        expect(anchor).toContain("suppressScreenDim('anchor-alarm')");
        expect(anchor).toContain("releaseScreenDim('anchor-alarm')");
        const mob = read('services/MobService.ts');
        expect(mob).toContain("suppressScreenDim('mob-active')");
        expect(mob).toContain("releaseScreenDim('mob-active')");
    });

    it('the preference lives in Aesthetics and arms only via a real keep-awake probe', () => {
        const aesthetics = read('components/settings/AestheticsTab.tsx');
        expect(aesthetics).toContain('Dim While Always On');
        expect(aesthetics).toContain('writeScreenDimSettings');
        const overlay = read('components/ScreenDimOverlay.tsx');
        expect(overlay).toContain('KeepAwake.isKeptAwake()');
        // Web/plugin-missing must never arm on a guess.
        expect(overlay).toContain('setKeptAwake(false)');
    });
});
