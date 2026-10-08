import React, { useId, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal, type OverlayLayer } from '../ui/OverlayPortal';

/**
 * The frame every Plan Your Day screen shares (build 124): a centred card
 * clear of the tab bar (the house modal rule, GuardianPage's padding), a
 * header that never scrolls, a body that may scroll only when it must (large
 * text), and a footer that never scrolls. Focus is trapped while it is the
 * top screen; Escape and ✕ close it.
 */
export function TodayModal({
    title,
    sub,
    layer = 'nested',
    active = true,
    onClose,
    closeLabel = 'Close',
    headerBody,
    headerExtra,
    footer,
    className = '',
    children,
}: {
    title: string;
    sub?: React.ReactNode;
    /** Under the title, inside the header (screen 1's place button). */
    headerBody?: React.ReactNode;
    layer?: OverlayLayer;
    /** False while a nested screen is open over this one. */
    active?: boolean;
    onClose: () => void;
    closeLabel?: string;
    headerExtra?: React.ReactNode;
    footer?: React.ReactNode;
    className?: string;
    children: React.ReactNode;
}) {
    const titleId = useId();
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(active, { initialFocusRef: closeRef, onEscape: onClose });
    return (
        <OverlayPortal layer={layer} role="presentation" className="today-overlay">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={`today-card ${className}`.trim()}
            >
                <header className="today-head">
                    <div className="today-title">
                        <h2 id={titleId}>{title}</h2>
                        {sub && <p className="today-sub">{sub}</p>}
                        {headerBody}
                    </div>
                    {headerExtra}
                    <button
                        ref={closeRef}
                        type="button"
                        className="today-icon"
                        aria-label={closeLabel}
                        onClick={onClose}
                    >
                        <span aria-hidden="true">✕</span>
                    </button>
                </header>
                <div className="today-body">{children}</div>
                {footer}
            </div>
        </OverlayPortal>
    );
}
