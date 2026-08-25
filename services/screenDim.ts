/**
 * screenDim — app-wide screen dimming while the app is in always-on mode
 * (Shane 2026-08-26: "can we have the dim across the entire app… it should
 * work exactly the same but right throughout the entire app, and only if
 * the app is in always on mode").
 *
 * "Always on" is detected, not declared: KeepAwake.isKeptAwake() answers
 * for EVERY holder (anchor watch, MOB, future ones) without rewiring any
 * of them. The overlay arms only while something holds the screen awake.
 *
 * SUPPRESSION: a safety surface that must never dim registers a token —
 * an active MOB session and an anchor-drag alarm hold one for their whole
 * lifetime. Suppression wins over everything; releasing re-arms the idle
 * timer, never an instant dim.
 *
 * The preference is a device display setting (like theme) in plain
 * localStorage. Reads fall back to the short-lived anchor-page keys from
 * the first iteration of this feature so nobody loses their choice.
 */

export const SCREEN_DIM_ENABLED_KEY = 'thalassa_screen_dim_enabled';
export const SCREEN_DIM_LEVEL_KEY = 'thalassa_screen_dim_level';
export const SCREEN_DIM_CHANGED_EVENT = 'thalassa:screen-dim-changed';

const LEGACY_ENABLED_KEY = 'thalassa_watch_dim_enabled';
const LEGACY_LEVEL_KEY = 'thalassa_watch_dim_level';

export interface ScreenDimSettings {
    enabled: boolean;
    /** Overlay opacity percent, 50–95. */
    level: number;
}

export function readScreenDimSettings(): ScreenDimSettings {
    try {
        const enabledRaw = localStorage.getItem(SCREEN_DIM_ENABLED_KEY) ?? localStorage.getItem(LEGACY_ENABLED_KEY);
        const levelRaw = Number(localStorage.getItem(SCREEN_DIM_LEVEL_KEY) ?? localStorage.getItem(LEGACY_LEVEL_KEY));
        return {
            enabled: enabledRaw === '1',
            level: Number.isFinite(levelRaw) && levelRaw >= 50 && levelRaw <= 95 ? levelRaw : 80,
        };
    } catch {
        return { enabled: false, level: 80 };
    }
}

export function writeScreenDimSettings(settings: ScreenDimSettings): void {
    try {
        localStorage.setItem(SCREEN_DIM_ENABLED_KEY, settings.enabled ? '1' : '0');
        localStorage.setItem(SCREEN_DIM_LEVEL_KEY, String(settings.level));
    } catch {
        /* display preference only — losing it is harmless */
    }
    try {
        window.dispatchEvent(new CustomEvent(SCREEN_DIM_CHANGED_EVENT));
    } catch {
        /* non-browser context */
    }
}

// ── Suppression registry ──────────────────────────────────────────────────
const suppressors = new Set<string>();

/** Hold full brightness while `token` is registered (MOB, anchor alarm). */
export function suppressScreenDim(token: string): void {
    suppressors.add(token);
    notifySuppressionChange();
}

export function releaseScreenDim(token: string): void {
    if (suppressors.delete(token)) notifySuppressionChange();
}

export function isScreenDimSuppressed(): boolean {
    return suppressors.size > 0;
}

function notifySuppressionChange(): void {
    try {
        window.dispatchEvent(new CustomEvent(SCREEN_DIM_CHANGED_EVENT));
    } catch {
        /* non-browser context */
    }
}

/** Test-only: order-decoupled suites. */
export function __resetScreenDimForTest(): void {
    suppressors.clear();
}
