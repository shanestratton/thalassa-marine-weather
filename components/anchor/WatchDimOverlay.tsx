/**
 * WatchDimOverlay — chartplotter-style screen dimming for Anchor Watch
 * (Shane 2026-08-26: "should we have an option to dim the screen and a
 * slider to show how dim… it needs to come back on the moment a punter
 * touches the screen").
 *
 * Anchor Watch holds KeepAwake all night, and on an OLED phone the lit
 * screen — not the GPS — is the biggest battery draw. A black overlay is
 * a real power saver there (unlit OLED pixels cost ~nothing) without a
 * native brightness plugin this close to beta.
 *
 * Behaviour contract:
 *  - Dims only after IDLE_MS without a touch, and only while `active`.
 *  - The FIRST touch on a dimmed screen wakes it and is SWALLOWED —
 *    nobody fat-fingers a button through a black screen.
 *  - `active` must go false in alarm state — an alarm is never dimmed.
 *    (The caller gates this; the overlay just obeys.)
 *  - A faint "tap to wake" stays visible so a dim screen never reads as
 *    a crashed app.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

export const WATCH_DIM_IDLE_MS = 20_000;

export const WatchDimOverlay: React.FC<{ active: boolean; opacityPercent: number }> = ({ active, opacityPercent }) => {
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
            className={`fixed inset-0 z-[2000] flex items-end justify-center bg-black transition-opacity duration-1000 ${
                dimmed ? 'pointer-events-auto' : 'pointer-events-none'
            }`}
            style={{ opacity }}
        >
            <p className="mb-14 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/20">tap to wake</p>
        </div>
    );
};
