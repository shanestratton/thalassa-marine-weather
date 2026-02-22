/**
 * SynopticScrubber — Butter-smooth custom timeline scrubber for the synoptic chart.
 *
 * Key architecture decisions:
 *   1. NO native <input type="range"> — custom div-based track/thumb
 *   2. Thumb position updated via CSS transform (direct DOM, no React re-renders during drag)
 *   3. Map frame (applyFrame) updates are RAF-throttled during drags
 *   4. React state (forecastHour) committed only on drag-end for the label
 *   5. Pointer events for cross-platform (mouse + touch) smoothness
 *   6. touch-action: none prevents browser scroll/gesture interference
 */
import React, { useRef, useCallback, useEffect, memo } from 'react';

interface SynopticScrubberProps {
    forecastHour: number;
    totalFrames: number;
    framesReady: number;
    isPlaying: boolean;
    onHourChange: (h: number) => void;
    onPlayToggle: () => void;
    onScrubStart: () => void;
    applyFrame: (h: number) => void;
    triggerHaptic: (style: 'light' | 'medium' | 'heavy') => void;
}

export const SynopticScrubber: React.FC<SynopticScrubberProps> = memo(({
    forecastHour,
    totalFrames,
    framesReady,
    isPlaying,
    onHourChange,
    onPlayToggle,
    onScrubStart,
    applyFrame,
    triggerHaptic,
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const fillRef = useRef<HTMLDivElement>(null);
    const labelRef = useRef<HTMLParagraphElement>(null);
    const sublabelRef = useRef<HTMLParagraphElement>(null);
    const isDraggingRef = useRef(false);
    const lastAppliedFrameRef = useRef(-1);
    const rafRef = useRef<number | null>(null);

    // ── Position helpers ──
    const maxFrame = totalFrames - 1;

    const clampFrame = useCallback((raw: number) => {
        return Math.max(0, Math.min(maxFrame, Math.round(raw)));
    }, [maxFrame]);

    const positionToFrame = useCallback((clientX: number) => {
        const track = trackRef.current;
        if (!track) return 0;
        const rect = track.getBoundingClientRect();
        const ratio = (clientX - rect.left) / rect.width;
        return clampFrame(ratio * maxFrame);
    }, [clampFrame, maxFrame]);

    // ── Direct DOM updates (zero React renders) ──
    const updateVisuals = useCallback((frame: number) => {
        const pct = maxFrame > 0 ? (frame / maxFrame) * 100 : 0;

        if (thumbRef.current) {
            thumbRef.current.style.left = `${pct}%`;
        }
        if (fillRef.current) {
            fillRef.current.style.width = `${pct}%`;
        }
        if (labelRef.current) {
            labelRef.current.textContent = frame === 0 ? 'Now' : `+${frame}h`;
        }
        if (sublabelRef.current) {
            sublabelRef.current.textContent = frame <= 24 ? 'Today' : 'Tomorrow';
        }
    }, [maxFrame]);

    // ── RAF-throttled frame application ──
    const scheduleApply = useCallback((frame: number) => {
        if (lastAppliedFrameRef.current === frame) return;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            lastAppliedFrameRef.current = frame;
            applyFrame(frame);
            rafRef.current = null;
        });
    }, [applyFrame]);

    // ── Pointer event handlers ──
    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        isDraggingRef.current = true;
        onScrubStart();

        // Capture pointer so moves outside the element still track
        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        const frame = positionToFrame(e.clientX);
        updateVisuals(frame);
        scheduleApply(frame);
        triggerHaptic('light');

        // Scale up thumb on grab
        if (thumbRef.current) {
            thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1.4)';
        }
    }, [positionToFrame, updateVisuals, scheduleApply, onScrubStart, triggerHaptic]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!isDraggingRef.current) return;
        e.preventDefault();

        const frame = positionToFrame(e.clientX);
        updateVisuals(frame);
        scheduleApply(frame);
    }, [positionToFrame, updateVisuals, scheduleApply]);

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;

        const frame = positionToFrame(e.clientX);
        updateVisuals(frame);
        applyFrame(frame); // Immediate final apply (no RAF delay)
        onHourChange(frame); // Commit to React state

        // Scale thumb back to normal
        if (thumbRef.current) {
            thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1)';
        }
    }, [positionToFrame, updateVisuals, applyFrame, onHourChange]);

    // ── Sync visuals when React state changes from outside (play, reset) ──
    useEffect(() => {
        if (!isDraggingRef.current) {
            updateVisuals(forecastHour);
        }
    }, [forecastHour, updateVisuals]);

    // ── Cleanup RAF on unmount ──
    useEffect(() => {
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    return (
        <div
            className="absolute left-4 right-4 z-20"
            style={{ bottom: 90 }}
        >
            <div className="bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3">
                {/* Play / Pause */}
                <button
                    onClick={onPlayToggle}
                    className="w-8 h-8 flex items-center justify-center rounded-xl bg-sky-500/20 border border-sky-500/30 shrink-0 active:scale-90 transition-transform"
                >
                    <span className="text-sm">{isPlaying ? '⏸' : '▶️'}</span>
                </button>

                {/* Custom track */}
                <div
                    ref={trackRef}
                    className="flex-1 relative h-10 flex items-center cursor-pointer"
                    style={{ touchAction: 'none' }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                >
                    {/* Track background */}
                    <div className="w-full h-1.5 bg-white/10 rounded-full relative overflow-hidden">
                        {/* Active fill */}
                        <div
                            ref={fillRef}
                            className="absolute inset-y-0 left-0 bg-sky-500/40 rounded-full"
                            style={{ width: `${maxFrame > 0 ? (forecastHour / maxFrame) * 100 : 0}%`, willChange: 'width' }}
                        />
                    </div>

                    {/* Thumb */}
                    <div
                        ref={thumbRef}
                        className="absolute top-1/2 w-5 h-5 -ml-[0.5px] bg-sky-400 rounded-full shadow-lg shadow-sky-400/30 border-2 border-white/40 pointer-events-none"
                        style={{
                            left: `${maxFrame > 0 ? (forecastHour / maxFrame) * 100 : 0}%`,
                            transform: 'translate(-50%, -50%) scale(1)',
                            transition: isDraggingRef.current ? 'none' : 'transform 0.15s ease-out',
                            willChange: 'left, transform',
                        }}
                    />

                    {/* Touch target expansion (invisible, 44px tall for accessibility) */}
                    <div className="absolute inset-0" />

                    {/* Loading progress */}
                    {framesReady < totalFrames && (
                        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/5 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-sky-500/50 rounded-full transition-all duration-200"
                                style={{ width: `${(framesReady / totalFrames) * 100}%` }}
                            />
                        </div>
                    )}
                </div>

                {/* Time label */}
                <div className="shrink-0 text-right min-w-[52px]">
                    <p ref={labelRef} className="text-xs font-black text-white">
                        {forecastHour === 0 ? 'Now' : `+${forecastHour}h`}
                    </p>
                    <p ref={sublabelRef} className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">
                        {forecastHour <= 24 ? 'Today' : 'Tomorrow'}
                    </p>
                </div>
            </div>
        </div>
    );
});

SynopticScrubber.displayName = 'SynopticScrubber';
