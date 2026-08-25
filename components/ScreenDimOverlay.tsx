/**
 * ScreenDimOverlay — app-wide chartplotter-style dimming (Shane 2026-08-26,
 * generalised same day from the anchor-watch-only first cut: "across the
 * entire app… only if the app is in always on mode").
 *
 * Something holds KeepAwake all night, and on an OLED phone the lit screen
 * — not the GPS — is the biggest battery draw. A black overlay is a real
 * power saver there (unlit pixels cost ~nothing) without a native
 * brightness plugin this close to beta.
 *
 * Behaviour contract (test-pinned):
 *  - Dims only after IDLE_MS without a touch, and only while `active`.
 *  - The FIRST touch on a dimmed screen wakes it and is SWALLOWED —
 *    nobody fat-fingers a button through a black screen.
 *  - `active` going false (keep-awake released, or a safety surface
 *    suppressing — MOB, anchor alarm) restores full brightness instantly.
 *  - A faint "tap to wake" stays visible so a dim screen never reads as
 *    a crashed app.
 *
 * ScreenDimHost owns the app-wide arming: KeepAwake.isKeptAwake() polled
 * (every holder counts, none rewired), the Aesthetics preference, and the
 * suppression registry. Sits just under the night-vision scrim, far above
 * ordinary UI, deliberately below `critical` — alarms outrank it in z AND
 * un-dim it via suppression.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NIGHT_SCRIM_Z_INDEX } from './ui/OverlayPortal';
import { SCREEN_DIM_CHANGED_EVENT, isScreenDimSuppressed, readScreenDimSettings } from '../services/screenDim';

export const WATCH_DIM_IDLE_MS = 20_000;
export const SCREEN_DIM_Z_INDEX = NIGHT_SCRIM_Z_INDEX - 1;
const KEEP_AWAKE_POLL_MS = 5_000;

export const ScreenDimOverlay: React.FC<{ active: boolean; opacityPercent: number }> = ({ active, opacityPercent }) => {
    const [dimmed, setDimmed] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dimmedRef = useRef(false);
    dimmedRef.current = dimmed;

    const armIdleTimer = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setDimmed(true), WATCH_DIM_IDLE_MS);
    }, []);

    useEffect(() => {
        if (!active) {
            if (timerRef.current) clearTimeout(timerRef.current);
            setDimmed(false);
            return;
        }
        armIdleTimer();
        // Any interaction while lit re-arms the countdown. The dimmed case
        // is handled by the overlay's own capture handler below, so this
        // listener only ever sees touches on a lit screen.
        const onInteract = () => {
            if (!dimmedRef.current) armIdleTimer();
        };
        window.addEventListener('pointerdown', onInteract, { passive: true });
        return () => {
            window.removeEventListener('pointerdown', onInteract);
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [active, armIdleTimer]);

    const wake = useCallback(
        (event: React.SyntheticEvent) => {
            // Swallow the waking touch — it must not reach whatever control
            // happens to sit underneath the black.
            event.preventDefault();
            event.stopPropagation();
            setDimmed(false);
            armIdleTimer();
        },
        [armIdleTimer],
    );

    if (!active) return null;
    const opacity = dimmed ? Math.min(0.98, Math.max(0, opacityPercent / 100)) : 0;
    return (
        <div
            data-testid="watch-dim-overlay"
            aria-hidden={!dimmed}
            onPointerDown={dimmed ? wake : undefined}
            onTouchStart={dimmed ? wake : undefined}
            className={`fixed inset-0 flex items-end justify-center bg-black transition-opacity duration-1000 ${
                dimmed ? 'pointer-events-auto' : 'pointer-events-none'
            }`}
            style={{ opacity, zIndex: SCREEN_DIM_Z_INDEX }}
        >
            <p className="mb-14 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/20">tap to wake</p>
        </div>
    );
};

/**
 * App-root host: arms the overlay whenever (a) the Aesthetics preference is
 * on, (b) ANY holder keeps the screen awake, and (c) no safety surface
 * suppresses. Mounted once in App.tsx beside the night-vision scrim.
 */
export const ScreenDimHost: React.FC = () => {
    const [settings, setSettings] = useState(readScreenDimSettings);
    const [keptAwake, setKeptAwake] = useState(false);
    const [suppressed, setSuppressed] = useState(isScreenDimSuppressed);

    useEffect(() => {
        const onChange = () => {
            setSettings(readScreenDimSettings());
            setSuppressed(isScreenDimSuppressed());
        };
        window.addEventListener(SCREEN_DIM_CHANGED_EVENT, onChange);
        return () => window.removeEventListener(SCREEN_DIM_CHANGED_EVENT, onChange);
    }, []);

    useEffect(() => {
        if (!settings.enabled) {
            setKeptAwake(false);
            return;
        }
        let disposed = false;
        const probe = async () => {
            try {
                const { KeepAwake } = await import('@capacitor-community/keep-awake');
                const result = await KeepAwake.isKeptAwake();
                if (!disposed) setKeptAwake(Boolean(result?.isKeptAwake));
            } catch {
                // Web / plugin unavailable: never arm on a guess.
                if (!disposed) setKeptAwake(false);
            }
        };
        void probe();
        const interval = setInterval(() => void probe(), KEEP_AWAKE_POLL_MS);
        const onVisible = () => void probe();
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            disposed = true;
            clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [settings.enabled]);

    return <ScreenDimOverlay active={settings.enabled && keptAwake && !suppressed} opacityPercent={settings.level} />;
};
