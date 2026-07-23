import React, { useId } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../theme';
import { OverlayPortal } from './ui/OverlayPortal';

export const ProcessOverlay: React.FC<{ message?: string }> = ({ message = 'Updating...' }) => {
    const messageId = useId();
    const dialogRef = useFocusTrap<HTMLDivElement>(true);

    return (
        <OverlayPortal
            ref={dialogRef}
            className="bg-slate-900/60 flex items-center justify-center animate-in fade-in duration-300"
            role="dialog"
            aria-modal="true"
            aria-labelledby={messageId}
            aria-busy="true"
        >
            <div
                className={`bg-slate-950/80 ${t.border.default} rounded-2xl p-6 shadow-2xl flex flex-col items-center gap-4 min-w-[200px]`}
            >
                <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                <span
                    id={messageId}
                    className="text-white font-bold text-sm tracking-widest uppercase animate-pulse"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                >
                    {message}
                </span>
            </div>
        </OverlayPortal>
    );
};
