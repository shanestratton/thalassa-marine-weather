/**
 * The one dialog shape Sightings uses: CENTRED and clear of the tab bar (the
 * standing rule, Shane 2026-08-31: "it needs to a: be centred on the screen,
 * and b: if it is too far down the screen, it needs to clear the menu
 * area!!"), scrolling inside its own card so its buttons can never be pushed
 * off screen.
 *
 *  - Portalled out of the page (OverlayPortal), on the 'nested' layer so it
 *    also sits above the Log page's fullscreen live map.
 *  - With the keyboard up, the box centres in the band above it instead of
 *    over the tab bar (capacitor sets KeyboardResize.None, so the keyboard
 *    overlays the WebView). In a split pane the pane host already ends above
 *    the keyboard and split-pane.css gives it symmetric padding.
 *  - transform-gpu: iOS WebKit paints Leaflet's transformed layers above
 *    fixed overlays, so the callers also unmount their maps while it is open.
 */
import React, { useId, useRef } from 'react';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { SightingIcon } from './SightingGlyphs';
import './sightings.css';

export interface SightingsSheetProps {
    onClose: () => void;
    /** Visible heading; also the dialog's name. */
    title: React.ReactNode;
    /** A line under the heading. */
    subtitle?: React.ReactNode;
    /** Replaces the close button (the logged state's Undo, for one). */
    headerAction?: React.ReactNode;
    /** Drawn left of the heading. */
    leading?: React.ReactNode;
    /** The pinned foot of the card (Done); it never scrolls away. */
    footer?: React.ReactNode;
    children: React.ReactNode;
    initialFocusRef?: React.RefObject<HTMLElement | null>;
    testId?: string;
    /** Close button name. */
    closeLabel?: string;
}

export const SightingsSheet: React.FC<SightingsSheetProps> = ({
    onClose,
    title,
    subtitle,
    headerAction,
    leading,
    footer,
    children,
    initialFocusRef,
    testId,
    closeLabel = 'Close',
}) => {
    const titleId = useId();
    const titleRef = useRef<HTMLHeadingElement>(null);
    const keyboard = useKeyboardOffset(true);
    // VoiceOver and keyboards start at the heading; a touch never sees a ring
    // on a tile that could read as already chosen.
    const panelRef = useFocusTrap<HTMLElement>(true, {
        onEscape: onClose,
        initialFocusRef: initialFocusRef ?? titleRef,
    });

    return (
        <OverlayPortal
            layer="nested"
            role="presentation"
            className="sg-scope flex items-center justify-center px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]"
            style={keyboard > 0 ? { paddingBottom: `${keyboard + 12}px` } : undefined}
            onClick={onClose}
        >
            <div className="absolute inset-0 bg-black/60" aria-hidden="true" />
            <section
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                data-keyboard-focus-scope
                data-testid={testId}
                onClick={(e) => e.stopPropagation()}
                className="sg-sheet relative flex max-h-full w-full max-w-md flex-col overflow-hidden transform-gpu text-white animate-in fade-in zoom-in-95 duration-200"
            >
                <header className="flex shrink-0 items-start gap-3 px-4 pt-4 pb-2">
                    {leading}
                    <div className="min-w-0 flex-1 pt-0.5">
                        <h2
                            id={titleId}
                            ref={titleRef}
                            tabIndex={-1}
                            className="text-[clamp(17px,5vw,19px)] font-black leading-tight text-white outline-none"
                        >
                            {title}
                        </h2>
                        {subtitle && (
                            <div className="mt-0.5 text-[13px] font-semibold leading-snug sg-muted">{subtitle}</div>
                        )}
                    </div>
                    {headerAction ?? (
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={closeLabel}
                            className="sg-toggle flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full"
                        >
                            <SightingIcon name="close" className="h-[18px] w-[18px]" />
                        </button>
                    )}
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">{children}</div>
                {footer && <div className="shrink-0 px-4 pt-2 pb-4">{footer}</div>}
            </section>
        </OverlayPortal>
    );
};
