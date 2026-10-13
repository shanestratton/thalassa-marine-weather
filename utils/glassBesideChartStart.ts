/**
 * Tablets and wide windows start with The Glass beside Obs (Shane 2026-10-13,
 * build 128): "on the ipads etc that have a screen wide enough for two pages at
 * once, can we auto start with the Glass page and the Obs page together. that
 * is from the moment they start the app, if it is in the correct size and if it
 * is in landscape".
 *
 * The split's own gate is width alone, 1024 px (App.tsx), so a long press can
 * still pin it in a wide portrait window; the start asks for landscape too.
 * Settings → Preferences can switch the start off (UserSettings
 * .glassBesideChartAtStart, unset = on: our recommendation, recorded).
 */
import { Capacitor } from '@capacitor/core';
import type { ScreenOrientationType } from '../types/units';
import { ABNORMAL_EXITS_KEY, SESSION_OPEN_KEY, buildFingerprint } from './sessionFlag';

/** Wide enough for two panes, and on its side. */
export const GLASS_BESIDE_CHART_QUERY = '(min-width: 1024px) and (orientation: landscape)';

/**
 * Whether this start opens with The Glass pinned beside Obs.
 *
 * Settings → Orientation locks the screen a moment AFTER this is asked
 * (settingsStore manageScreenEffects, native only), so where the lock turns the
 * screen it decides, not the way the device happens to be held: Portrait never
 * splits, Landscape asks only whether the long side holds two panes.
 *
 * Never straight after a foreground death: the chart is the usual killer, and
 * reopening it at once is the crash loop the boot policy stands off from
 * (services/webContentKill.ts). That start is The Glass alone, as today.
 */
export function opensWithGlassBesideChart(
    preference: boolean | undefined,
    orientationLock: ScreenOrientationType | undefined = 'auto',
    lockTurnsScreen: boolean = Capacitor.isNativePlatform(),
): boolean {
    if (preference === false || typeof window === 'undefined') return false;
    try {
        if (lastSessionDiedInForeground()) return false;
        if (lockTurnsScreen && orientationLock === 'portrait') return false;
        if (lockTurnsScreen && orientationLock === 'landscape') {
            return Math.max(window.innerWidth, window.innerHeight) >= 1024;
        }
        return window.matchMedia(GLASS_BESIDE_CHART_QUERY).matches;
    } catch {
        return false;
    }
}

/**
 * Did the last session die in the foreground? Read straight from the session
 * watch's own flag, because the start can be asked before that watch has run
 * (a warm boot paints on the first frame) or after (settings loaded late):
 * still raised from before this page loaded, or already counted by this boot.
 * A flag left by another build is a reinstall (Xcode stops the running app),
 * not a death, exactly as the watch reads it.
 */
export function lastSessionDiedInForeground(
    bootAt: number = performance.timeOrigin || Date.now() - performance.now(),
): boolean {
    const read = (key: string) => {
        try {
            const raw = localStorage.getItem(key);
            return raw ? (JSON.parse(raw) as { at?: unknown; build?: unknown }) : null;
        } catch {
            return null;
        }
    };
    const open = read(SESSION_OPEN_KEY);
    if (open && typeof open.at === 'number' && open.at < bootAt) {
        const now = buildFingerprint();
        return !(typeof open.build === 'string' && now && open.build !== now);
    }
    const counted = read(ABNORMAL_EXITS_KEY);
    return !!counted && typeof counted.at === 'number' && counted.at >= bootAt;
}

/**
 * A screen that can show two pages when held on its side: 1024 px or more on
 * its long side (every iPad, a desktop), never a phone. Preferences offers the
 * start switch only here.
 */
export function screenHoldsTwoPages(): boolean {
    if (typeof window === 'undefined' || !window.screen) return false;
    return Math.max(window.screen.width || 0, window.screen.height || 0) >= 1024;
}
