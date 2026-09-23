import React, { useId } from 'react';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';
import './TrialWaypointEditor.css';

export interface TrialWaypointEditorProps {
    waypointNumber: number;
    coordinates: [number, number];
    moving: boolean;
    candidate: [number, number] | null;
    lockedReason?: string;
    error?: string;
    onBeginMove: () => void;
    onConfirmMove: () => void;
    onCancelMove: () => void;
    onClose: () => void;
    onFocus: () => void;
    onUndo?: () => void;
}

function Position({ coordinates }: { coordinates: [number, number] }) {
    return (
        <span className="trial-waypoint-position">
            <span>{formatLatDegMin(coordinates[1])}</span>
            <span>{formatLonDegMin(coordinates[0])}</span>
        </span>
    );
}

/** Tap-place-confirm editing UI only. The workspace validates and replaces
 * geometry, invalidates previous checks, and owns locked canal/profile pins. */
export function TrialWaypointEditor({
    waypointNumber,
    coordinates,
    moving,
    candidate,
    lockedReason,
    error,
    onBeginMove,
    onConfirmMove,
    onCancelMove,
    onClose,
    onFocus,
    onUndo,
}: TrialWaypointEditorProps) {
    const titleId = useId();
    const reasonId = useId();
    return (
        <section className="trial-waypoint-editor" aria-labelledby={titleId}>
            <header className="trial-waypoint-editor-heading">
                <h3 id={titleId}>Waypoint {waypointNumber}</h3>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close waypoint editor"
                    className="trial-waypoint-close"
                >
                    ×
                </button>
            </header>
            <div
                className="trial-waypoint-editor-body"
                onWheel={(event) => event.stopPropagation()}
                onTouchMove={(event) => event.stopPropagation()}
            >
                <Position coordinates={coordinates} />
                {lockedReason && (
                    <p id={reasonId} className="trial-waypoint-caution">
                        {lockedReason}
                    </p>
                )}
                {moving && (
                    <>
                        <p className="trial-waypoint-instruction">Tap chart to place waypoint.</p>
                        <div className="trial-waypoint-candidate" aria-live="polite">
                            {candidate ? (
                                <>
                                    <span>New position</span>
                                    <Position coordinates={candidate} />
                                </>
                            ) : (
                                'Choose a new position on the chart.'
                            )}
                        </div>
                        <p className="trial-waypoint-caution">
                            Moving restarts chart checks. Provider checks no longer apply.
                        </p>
                    </>
                )}
                {error && (
                    <p role="alert" className="trial-waypoint-error">
                        {error}
                    </p>
                )}
            </div>
            <footer className="trial-waypoint-editor-actions">
                {moving ? (
                    <>
                        <button
                            type="button"
                            className="trial-waypoint-primary"
                            onClick={onConfirmMove}
                            disabled={!candidate || !!lockedReason}
                        >
                            Confirm move
                        </button>
                        <button type="button" onClick={onCancelMove}>
                            Cancel
                        </button>
                    </>
                ) : (
                    <>
                        <button type="button" onClick={onFocus}>
                            Show on chart
                        </button>
                        <button
                            type="button"
                            className="trial-waypoint-primary"
                            onClick={onBeginMove}
                            disabled={!!lockedReason}
                            aria-describedby={lockedReason ? reasonId : undefined}
                        >
                            Move
                        </button>
                    </>
                )}
            </footer>
            {!moving && onUndo && (
                <button type="button" className="trial-waypoint-undo" onClick={onUndo}>
                    ↶ Undo last move
                </button>
            )}
        </section>
    );
}
