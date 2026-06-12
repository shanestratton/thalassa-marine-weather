/**
 * RouteEnhancementChip — small floating pill rendered while the
 * passage-planner enhancement pipeline is running.
 *
 * Listens for the two window events `useVoyageForm` emits:
 *
 *   thalassa:passage-enhancement-start  (pipeline kicked off)
 *   thalassa:passage-enhancement-end    (everything settled)
 *
 * Self-mounts; nothing visible while idle. Renders absolutely-positioned
 * top-center so it overlays the chart without participating in layout
 * flow. Embed once at the MapHub root and it'll do the right thing
 * whichever direction the user navigates from.
 *
 * Why a separate component: keeps MapHub clean, makes the listener
 * lifecycle scoped and tied to mount/unmount, and lets us drop the
 * chip into other surfaces (RoutePlanner, voyage detail page) without
 * duplicating the wiring.
 */
import React, { useEffect, useState } from 'react';

const PHASES = [
    'Finding deep water',
    'Threading the channel',
    'Checking the weather window',
    'Marking the turns',
    'Tidying the track',
];

export const RouteEnhancementChip: React.FC = () => {
    const [active, setActive] = useState(false);
    const [phaseIdx, setPhaseIdx] = useState(0);

    useEffect(() => {
        const onStart = () => {
            setActive(true);
            setPhaseIdx(0);
        };
        const onEnd = () => setActive(false);
        window.addEventListener('thalassa:passage-enhancement-start', onStart);
        window.addEventListener('thalassa:passage-enhancement-end', onEnd);
        return () => {
            window.removeEventListener('thalassa:passage-enhancement-start', onStart);
            window.removeEventListener('thalassa:passage-enhancement-end', onEnd);
        };
    }, []);

    // Rotate the phrase so the chip doesn't feel frozen during the
    // longer steps. 2s cadence — slow enough to read, fast enough to
    // signal progress.
    useEffect(() => {
        if (!active) return;
        const id = setInterval(() => {
            setPhaseIdx((i) => (i + 1) % PHASES.length);
        }, 2000);
        return () => clearInterval(id);
    }, [active]);

    // Self-dismiss watchdog: if the end event never fires (a pipeline
    // await stalled behind a dead socket — CapacitorHttp ignores
    // AbortSignal on device), hide the chip after 3 minutes instead of
    // spinning forever. The normal end event flips `active` and the
    // cleanup clears the timer; ditto on unmount.
    useEffect(() => {
        if (!active) return;
        const id = setTimeout(() => setActive(false), 180_000);
        return () => clearTimeout(id);
    }, [active]);

    if (!active) return null;

    return (
        <div
            className="pointer-events-none fixed inset-x-0 z-[2500] flex justify-center animate-in fade-in slide-in-from-top-2 duration-200"
            style={{ top: 'calc(env(safe-area-inset-top) + 8px)' }}
            role="status"
            aria-live="polite"
        >
            <div className="pointer-events-auto inline-flex items-center gap-3 px-4 py-2 rounded-full bg-slate-900/95 border border-violet-500/30 backdrop-blur-md shadow-[0_0_25px_rgba(168,85,247,0.20)]">
                <div className="flex gap-1">
                    <span className="block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" />
                </div>
                <span className="text-[11px] font-mono tracking-wide text-violet-200">{PHASES[phaseIdx]}…</span>
            </div>
        </div>
    );
};
