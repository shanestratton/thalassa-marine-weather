/**
 * UndoToast — Shows a temporary "Item deleted" banner with an Undo button.
 *
 * Automatically dismisses after `duration` ms unless user clicks Undo.
 * Renders as a fixed bottom bar so it doesn't block the UI.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';

interface UndoToastProps {
    message: string;
    isOpen: boolean;
    duration?: number;
    onUndo: () => void;
    onDismiss: () => void;
}

export const UndoToast: React.FC<UndoToastProps> = ({
    message,
    isOpen,
    duration = 5000,
    onUndo,
    onDismiss,
}) => {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [progress, setProgress] = useState(100);
    const startRef = useRef(0);
    const frameRef = useRef<number>(0);

    const animate = useCallback(() => {
        const elapsed = Date.now() - startRef.current;
        const pct = Math.max(0, 100 - (elapsed / duration) * 100);
        setProgress(pct);
        if (pct > 0) {
            frameRef.current = requestAnimationFrame(animate);
        }
    }, [duration]);

    useEffect(() => {
        if (!isOpen) {
            setProgress(100);
            return;
        }
        startRef.current = Date.now();
        frameRef.current = requestAnimationFrame(animate);
        timerRef.current = setTimeout(onDismiss, duration);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
        };
    }, [isOpen, duration, onDismiss, animate]);

    if (!isOpen) return null;

    return (
        <div
            className="fixed left-4 right-4 z-[9999] animate-slide-up"
            style={{ bottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}
        >
            <div className="bg-slate-800 border border-white/10 rounded-2xl px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur-xl">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                        <span className="text-sm font-bold text-white truncate">{message}</span>
                    </div>
                    <button
                        onClick={() => {
                            if (timerRef.current) clearTimeout(timerRef.current);
                            if (frameRef.current) cancelAnimationFrame(frameRef.current);
                            onUndo();
                        }}
                        className="shrink-0 px-4 py-1.5 bg-amber-500/20 text-amber-400 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-amber-500/30 active:scale-95 transition-all"
                    >
                        Undo
                    </button>
                </div>
                {/* Progress bar */}
                <div className="mt-2 h-0.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-amber-500/40 rounded-full transition-none"
                        style={{ width: `${progress}%` }}
                    />
                </div>
            </div>
        </div>
    );
};
