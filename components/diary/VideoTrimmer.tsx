/**
 * VideoTrimmer — "I don't fucken think so" (Shane, 2026-08-31).
 *
 * A movie longer than the diary's minute lands here instead of a rejection.
 * The bar shows the whole movie with the edges darkened and a light window
 * exactly one minute wide; drag the window to the best minute and press the
 * button. The cut is lossless (services/videoTrim), so it takes seconds and
 * loses nothing but the footage outside the window.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { trimVideoLossless } from '../../services/videoTrim';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('VideoTrimmer');

const WINDOW_SEC = 60;

interface VideoTrimmerProps {
    file: File;
    durationSec: number;
    onDone: (trimmed: Blob) => void;
    onCancel: () => void;
}

function fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

export const VideoTrimmer: React.FC<VideoTrimmerProps> = ({ file, durationSec, onDone, onCancel }) => {
    const [startSec, setStartSec] = useState(0);
    const [cutting, setCutting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const dragging = useRef(false);

    // One object URL for the whole session; the preview seeks within it.
    const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
    useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

    const maxStart = Math.max(0, durationSec - WINDOW_SEC);
    const windowFrac = Math.min(1, WINDOW_SEC / durationSec);
    const startFrac = durationSec > 0 ? startSec / durationSec : 0;

    const seekPreview = useCallback((sec: number) => {
        const v = videoRef.current;
        if (v && Number.isFinite(sec)) v.currentTime = sec;
    }, []);

    const moveTo = useCallback(
        (clientX: number) => {
            const bar = barRef.current;
            if (!bar) return;
            const rect = bar.getBoundingClientRect();
            const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            // The drag point is the CENTRE of the window — grabbing the light
            // part and dragging it is the whole gesture.
            const next = Math.min(maxStart, Math.max(0, frac * durationSec - WINDOW_SEC / 2));
            setStartSec(next);
            seekPreview(next);
        },
        [durationSec, maxStart, seekPreview],
    );

    // While previewing, loop inside the chosen minute so what plays is what ships.
    const onTimeUpdate = useCallback(() => {
        const v = videoRef.current;
        if (!v || dragging.current) return;
        if (v.currentTime > startSec + WINDOW_SEC || v.currentTime < startSec - 0.5) {
            v.currentTime = startSec;
        }
    }, [startSec]);

    const cut = useCallback(async () => {
        setCutting(true);
        setError(null);
        try {
            videoRef.current?.pause();
            const result = await trimVideoLossless(file, startSec, WINDOW_SEC);
            triggerHaptic('medium');
            onDone(result.blob);
        } catch (err) {
            // A file the demuxer cannot read is a fact worth stating, with the
            // road round it — not a spinner that never ends.
            log.warn('trim failed', err);
            setError('Could not cut this file on the phone. Trim it to a minute in the Photos app, then add it again.');
            setCutting(false);
        }
    }, [file, startSec, onDone]);

    return (
        // Centred, never a bottom sheet (Shane's standing rule, 2026-08-31:
        // "it needs to a: be centred on the screen, and b: if it is too far
        // down the screen, it needs to clear the menu area"). The overlay's
        // bottom padding reserves the tab-bar band so even a tall card sits
        // clear of the menu, and the card itself scrolls internally rather
        // than ever pushing its buttons off-screen.
        <div
            className="fixed inset-0 z-1200 flex items-center justify-center bg-black/80 p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            role="dialog"
            aria-modal="true"
        >
            <div className="w-full max-w-md max-h-full overflow-y-auto rounded-3xl border border-violet-500/25 bg-slate-950 p-4">
                <p className="text-sm font-black uppercase tracking-[0.14em] text-violet-300">
                    That movie is {fmt(durationSec)}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                    The diary takes one minute. Drag the bright window to the best minute — the preview plays exactly
                    what will be kept.
                </p>

                <video
                    ref={videoRef}
                    src={previewUrl}
                    playsInline
                    muted
                    autoPlay
                    loop
                    onTimeUpdate={onTimeUpdate}
                    className="mt-3 max-h-56 w-full rounded-xl bg-black"
                />

                {/* ── The bar ── */}
                <div
                    ref={barRef}
                    className="relative mt-4 h-12 touch-none select-none overflow-hidden rounded-xl bg-slate-800"
                    onPointerDown={(e) => {
                        dragging.current = true;
                        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                        moveTo(e.clientX);
                    }}
                    onPointerMove={(e) => {
                        if (dragging.current) moveTo(e.clientX);
                    }}
                    onPointerUp={() => {
                        dragging.current = false;
                        seekPreview(startSec);
                    }}
                    onPointerCancel={() => {
                        dragging.current = false;
                    }}
                    aria-label="Choose which minute to keep"
                >
                    {/* darkened edges */}
                    <div className="absolute inset-y-0 left-0 bg-black/70" style={{ width: `${startFrac * 100}%` }} />
                    <div
                        className="absolute inset-y-0 right-0 bg-black/70"
                        style={{ width: `${Math.max(0, (1 - startFrac - windowFrac) * 100)}%` }}
                    />
                    {/* the light minute */}
                    <div
                        className="absolute inset-y-0 rounded-lg border-2 border-violet-400 bg-violet-400/20 shadow-[0_0_12px_rgba(167,139,250,0.45)]"
                        style={{ left: `${startFrac * 100}%`, width: `${windowFrac * 100}%` }}
                    >
                        <div className="flex h-full items-center justify-center gap-1">
                            <span className="h-4 w-0.5 rounded-sm bg-violet-200/70" />
                            <span className="h-6 w-0.5 rounded-sm bg-violet-200/70" />
                            <span className="h-4 w-0.5 rounded-sm bg-violet-200/70" />
                        </div>
                    </div>
                </div>
                <div className="mt-1.5 flex justify-between text-[11px] font-semibold tabular-nums text-gray-500">
                    <span>0:00</span>
                    <span className="text-violet-300">
                        keeping {fmt(startSec)}–{fmt(Math.min(durationSec, startSec + WINDOW_SEC))}
                    </span>
                    <span>{fmt(durationSec)}</span>
                </div>

                {error && (
                    <p className="mt-3 rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-300">
                        {error}
                    </p>
                )}

                <div className="mt-4 grid grid-cols-[auto_1fr] gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={cutting}
                        className="min-h-12 rounded-xl border border-white/10 bg-white/5 px-4 text-xs font-black uppercase tracking-wide text-slate-300 disabled:opacity-40"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => void cut()}
                        disabled={cutting}
                        className="min-h-12 rounded-xl bg-linear-to-r from-violet-500 to-fuchsia-500 px-4 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-violet-500/25 transition active:scale-[0.98] disabled:opacity-60"
                    >
                        {cutting ? 'Cutting…' : 'This will have to do'}
                    </button>
                </div>
            </div>
        </div>
    );
};
