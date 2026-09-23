import React, { useEffect, useId, useRef } from 'react';
import './TrialTracerShell.css';

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
    useEffect(() => {
        if (!expanded && bodyRef.current?.contains(document.activeElement)) {
            buttonRef.current?.focus({ preventScroll: true });
        }
    }, [expanded]);
    return (
        <section
            className={`trial-tracer-shell ${className}`.trim()}
            aria-label={label}
            data-expanded={expanded}
            data-status-tone={statusTone}
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
