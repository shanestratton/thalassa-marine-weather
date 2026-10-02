import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import './TrialTracerShell.css';

/** Below this much room for the scrolling body, the whole card scrolls as one
 * (2026-10-02). On Linux fonts the 1024 split's wrapped status and warning
 * squeezed the body to a 16 px band, so a focused field could not be shown
 * (CI 36920384778); an iPad split pane wraps the same way. */
export const TRACER_MIN_BODY_PX = 160;

/** The rows that keep their height whether the body or the card scrolls. */
const FIXED_ROWS = [
    ':scope > .trial-tracer-heading',
    ':scope > .trial-tracer-status',
    ':scope > .trial-tracer-warning',
    ':scope > .trial-tracer-expanded > .trial-tracer-navigation',
    ':scope > .trial-tracer-expanded > .trial-tracer-footer',
].join(', ');

/** True when the card's fixed rows leave the body less than the minimum. The
 * fixed rows keep their height in both layouts, so this cannot oscillate. */
export function tracerNeedsSingleScroll(cardHeight: number, fixedRowsHeight: number): boolean {
    return cardHeight > 0 && cardHeight - fixedRowsHeight < TRACER_MIN_BODY_PX;
}

export type TrialTracerTone = 'neutral' | 'working' | 'caution' | 'danger';

export interface TrialTracerShellProps {
    expanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
    /** The trial/navigation qualification stays visible when the card folds. */
    warning: React.ReactNode;
    status?: React.ReactNode;
    statusTone?: TrialTracerTone;
    navigation?: React.ReactNode;
    footer?: React.ReactNode;
    collapsedControls?: React.ReactNode;
    panelId?: string;
    toggleRef?: React.Ref<HTMLButtonElement>;
    className?: string;
    label?: string;
}

/** Manual Tracer's presentation, without borrowing its route activation,
 * plotting, provider or safety state. The workspace owns every action/claim. */
export function TrialTracerShell({
    expanded,
    onToggle,
    children,
    warning,
    status,
    statusTone = 'neutral',
    navigation,
    footer,
    collapsedControls,
    panelId,
    toggleRef,
    className = '',
    label = 'Autorouting controls',
}: TrialTracerShellProps) {
    const generatedId = useId();
    const bodyId = panelId ?? generatedId;
    const bodyRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const shellRef = useRef<HTMLElement>(null);
    const [singleScroll, setSingleScroll] = useState(false);
    const hasStatus = Boolean(status);
    const hasNavigation = Boolean(navigation);
    const hasFooter = Boolean(footer);
    useEffect(() => {
        if (!expanded && bodyRef.current?.contains(document.activeElement)) {
            buttonRef.current?.focus({ preventScroll: true });
        }
    }, [expanded]);
    // A short card (split pane, keyboard, landscape, wide fonts) scrolls as
    // ONE container: status, tabs, body and actions together. The fold handle
    // and 'Not for navigation' stay pinned (an ordinary phone with the
    // keyboard up lands here too, mid route entry), and nothing is hidden.
    useLayoutEffect(() => {
        const shell = shellRef.current;
        if (!expanded || !shell) {
            setSingleScroll(false);
            return;
        }
        const measure = () => {
            let fixed = 0;
            shell.querySelectorAll<HTMLElement>(FIXED_ROWS).forEach((row) => (fixed += row.offsetHeight));
            // The CSS pins 'Not for navigation' just under the fold handle in
            // single-scroll, and keeps a focused field clear of both.
            const heading = shell.querySelector<HTMLElement>(':scope > .trial-tracer-heading')?.offsetHeight ?? 0;
            const warningRow = shell.querySelector<HTMLElement>(':scope > .trial-tracer-warning')?.offsetHeight ?? 0;
            if (heading > 0) {
                shell.style.setProperty('--tracer-heading-h', `${heading}px`);
                shell.style.setProperty('--tracer-pinned-h', `${heading + warningRow}px`);
            }
            setSingleScroll(tracerNeedsSingleScroll(shell.clientHeight, fixed));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(shell);
        shell.querySelectorAll(FIXED_ROWS).forEach((row) => observer.observe(row));
        return () => observer.disconnect();
    }, [expanded, hasStatus, hasNavigation, hasFooter]);
    const stopScrollChaining = singleScroll
        ? {
              onWheel: (event: React.WheelEvent) => event.stopPropagation(),
              onTouchMove: (event: React.TouchEvent) => event.stopPropagation(),
          }
        : {};
    return (
        <section
            ref={shellRef}
            className={`trial-tracer-shell ${className}`.trim()}
            aria-label={label}
            data-expanded={expanded}
            data-status-tone={statusTone}
            data-single-scroll={singleScroll ? 'true' : undefined}
            {...stopScrollChaining}
        >
            <div className="trial-tracer-heading">
                <button
                    ref={(element) => {
                        buttonRef.current = element;
                        if (typeof toggleRef === 'function') toggleRef(element);
                        else if (toggleRef)
                            (toggleRef as React.MutableRefObject<HTMLButtonElement | null>).current = element;
                    }}
                    type="button"
                    onClick={onToggle}
                    aria-expanded={expanded}
                    aria-controls={bodyId}
                    aria-label={expanded ? 'Collapse tracer panel' : 'Expand tracer panel'}
                    className="trial-tracer-toggle"
                >
                    <span className="trial-tracer-chevron" aria-hidden="true">
                        {expanded ? '▾' : '▸'}
                    </span>
                    <span className="trial-tracer-title">
                        <span aria-hidden="true">● </span>Tracer
                    </span>
                    <span className="trial-tracer-badge">Auto · Trial</span>
                </button>
            </div>
            {status && (
                <div className="trial-tracer-status" role="status">
                    {status}
                </div>
            )}
            <div className="trial-tracer-warning">{warning}</div>
            <div ref={bodyRef} id={bodyId} hidden={!expanded} className="trial-tracer-expanded">
                {navigation && <div className="trial-tracer-navigation">{navigation}</div>}
                <div
                    className="trial-tracer-body"
                    onWheel={(event) => event.stopPropagation()}
                    onTouchMove={(event) => event.stopPropagation()}
                >
                    {children}
                </div>
                {footer && <div className="trial-tracer-footer">{footer}</div>}
            </div>
            {!expanded && collapsedControls && <div className="trial-tracer-folded-controls">{collapsedControls}</div>}
        </section>
    );
}
