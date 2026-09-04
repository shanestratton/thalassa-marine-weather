/**
 * Drag a fixed-position pill anywhere on screen, and remember where.
 *
 * Shane 2026-09-04: "can we make the music pill moveable. it is always hiding
 * buttons that i need to click… just make it so we can drag it anywhere on the
 * page." Anchored bottom-right, it sat over the chart's own controls.
 *
 * Two things make this feel right rather than fiddly:
 *
 *  - A MOVEMENT THRESHOLD. The pill is also a button — tapping it opens Music,
 *    and it carries pause and dismiss. Until the finger has travelled a few
 *    pixels this is a tap, not a drag, so the controls keep working exactly as
 *    before. `consumedTap()` lets the click handler know a drag happened and
 *    swallow the click that follows it.
 *
 *  - CLAMPED, ALWAYS. A pill dragged off-screen — or left near an edge before
 *    a rotation — would be unreachable with no way back, so every position is
 *    clamped into the viewport on drop AND on resize.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PillPosition {
    x: number;
    y: number;
}

const MARGIN = 8;
const DRAG_THRESHOLD_PX = 6;

function clamp(pos: PillPosition, el: HTMLElement | null): PillPosition {
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 60;
    return {
        x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
        y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
    };
}

export function useDraggablePill(storageKey: string) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<PillPosition | null>(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return null;
            const p = JSON.parse(raw) as PillPosition;
            return Number.isFinite(p?.x) && Number.isFinite(p?.y) ? p : null;
        } catch {
            return null;
        }
    });
    const [dragging, setDragging] = useState(false);
    const startRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
    const movedRef = useRef(false);

    // A pill parked near an edge must not be stranded off-screen by a rotation.
    useEffect(() => {
        const onResize = () => setPosition((p) => (p ? clamp(p, ref.current) : null));
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
        };
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        const el = ref.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        startRef.current = { px: e.clientX, py: e.clientY, ox: box.left, oy: box.top };
        movedRef.current = false;
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const start = startRef.current;
        if (!start) return;
        const dx = e.clientX - start.px;
        const dy = e.clientY - start.py;
        if (!movedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (!movedRef.current) {
            movedRef.current = true;
            setDragging(true);
            // Only capture once it IS a drag, so a plain tap is untouched.
            (e.target as Element).setPointerCapture?.(e.pointerId);
        }
        setPosition(clamp({ x: start.ox + dx, y: start.oy + dy }, ref.current));
    }, []);

    const onPointerUp = useCallback(
        (e: React.PointerEvent) => {
            startRef.current = null;
            if (!movedRef.current) return;
            setDragging(false);
            (e.target as Element).releasePointerCapture?.(e.pointerId);
            setPosition((p) => {
                if (!p) return p;
                const next = clamp(p, ref.current);
                try {
                    localStorage.setItem(storageKey, JSON.stringify(next));
                } catch {
                    /* private mode — it still moved for this session */
                }
                return next;
            });
        },
        [storageKey],
    );

    /** True once, if the click that follows came from a drag and must be ignored. */
    const consumedTap = useCallback(() => {
        if (!movedRef.current) return false;
        movedRef.current = false;
        return true;
    }, []);

    return { ref, position, dragging, consumedTap, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}
