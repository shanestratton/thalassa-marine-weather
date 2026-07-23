/**
 * ChildCard — Collapsible sub-card used in Passage Planning.
 *
 * Shows a tappable row in the list that opens to a full-screen overlay.
 */
import React, { useId, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';

const COLOR_MAP: Record<string, { bg: string; border: string; text: string; iconBg: string }> = {
    amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400', iconBg: 'bg-amber-500/15' },
    sky: { bg: 'bg-sky-500/10', border: 'border-sky-500/20', text: 'text-sky-400', iconBg: 'bg-sky-500/15' },
    emerald: {
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/20',
        text: 'text-emerald-400',
        iconBg: 'bg-emerald-500/15',
    },
    violet: {
        bg: 'bg-violet-500/10',
        border: 'border-violet-500/20',
        text: 'text-violet-400',
        iconBg: 'bg-violet-500/15',
    },
};

interface ChildCardProps {
    icon: string;
    title: string;
    subtitle: string;
    color: string;
    isOpen: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}

export const ChildCard: React.FC<ChildCardProps> = ({ icon, title, subtitle, color, isOpen, onToggle, children }) => {
    const c = COLOR_MAP[color] || COLOR_MAP.amber;
    const id = useId();
    const dialogId = `${id}-dialog`;
    const titleId = `${id}-title`;
    const subtitleId = `${id}-subtitle`;
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap(isOpen, {
        initialFocusRef: closeButtonRef,
        onEscape: onToggle,
    });

    return (
        <>
            {/* ── Tappable Row (always visible in the passage planning list) ── */}
            <button
                type="button"
                onClick={onToggle}
                className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all active:scale-[0.98] ${
                    isOpen ? c.border + ' ' + c.bg : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                }`}
                aria-expanded={isOpen}
                aria-label={`${title} — ${subtitle}`}
                aria-controls={dialogId}
                aria-haspopup="dialog"
            >
                <div
                    className={`w-11 h-11 rounded-xl ${c.iconBg} border ${c.border} flex items-center justify-center text-xl flex-shrink-0`}
                >
                    {icon}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-base font-semibold text-white">{title}</p>
                    <p className={`text-xs ${c.text} opacity-70`}>{subtitle}</p>
                </div>
                <svg
                    className="w-3.5 h-3.5 text-gray-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
            </button>

            {/* ── Full-Screen Overlay (portal to escape will-change-transform) ── */}
            {isOpen && (
                <OverlayPortal
                    ref={dialogRef}
                    id={dialogId}
                    className="bg-slate-950 flex flex-col"
                    style={{ paddingTop: 'env(safe-area-inset-top)' }}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={subtitleId}
                >
                    {/* Header with back chevron */}
                    <div
                        className={`flex items-center gap-3 px-4 py-3 border-b ${c.border} bg-slate-950/95 backdrop-blur-xl flex-shrink-0`}
                    >
                        <button
                            type="button"
                            ref={closeButtonRef}
                            onClick={onToggle}
                            className="p-2 -ml-2 rounded-xl hover:bg-white/5 transition-colors active:scale-90"
                            aria-label={`Close ${title} and return to passage planning`}
                        >
                            <svg
                                className="w-5 h-5 text-white"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <div
                            className={`w-11 h-11 rounded-xl ${c.iconBg} border ${c.border} flex items-center justify-center text-xl flex-shrink-0`}
                        >
                            {icon}
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 id={titleId} className="text-sm font-bold text-white">
                                {title}
                            </h2>
                            <p id={subtitleId} className={`text-xs ${c.text} opacity-70`}>
                                {subtitle}
                            </p>
                        </div>
                    </div>

                    {/* Scrollable content */}
                    <div
                        className="flex-1 overflow-y-auto overscroll-contain"
                        style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
                    >
                        {children}
                    </div>
                </OverlayPortal>
            )}
        </>
    );
};
