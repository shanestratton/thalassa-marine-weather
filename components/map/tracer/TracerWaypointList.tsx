/**
 * TracerWaypointList — the tracer card's body: the empty-state help text when
 * no pins are down, otherwise the tide panel followed by one row per waypoint
 * carrying that leg's verdict.
 *
 * Extracted from MapHub verbatim. This is the largest single block of the card
 * and the one with real derivation in it, so a few things must survive intact:
 *
 * NOT A SCROLLER. The card body scrolls as one column. A nested scroller here
 * traps the wheel and re-creates the ~40px sliver that clipped the tide rows
 * mid-glyph (Shane 2026-07-28: "it has no room to grow"). Do not add
 * overflow-y-auto, flex-1, or a wrapper <div> — the root must stay a direct
 * flex item of the card's scroller, or the `shrink-0` on it stops applying and
 * the clipping comes back. A Fragment emits no DOM, so it is safe.
 *
 * THE OFF-BY-ONE IS REAL. A row for pin `i` shows the verdict for the leg that
 * ARRIVES at it, so it reads legVerdicts[i-1] and tideLabels[i-1]. Those two
 * are different shapes on purpose — an array and a Record<number, string> —
 * and must not be "normalised" into one lookup.
 *
 * mapRef is passed as the REF OBJECT, never mapRef.current. Taking .current at
 * render time captures a null map on the first pass and every leg-row tap
 * silently no-ops.
 *
 * Index keys (key={i}, key="p0") are kept exactly as they were. They are a
 * known wart, but changing them in the same commit as a file move would make
 * any regression unattributable.
 */

import React from 'react';
import type mapboxgl from 'mapbox-gl';
import { triggerHaptic } from '../../../utils/system';
import { TracerTidePanel } from '../TracerTidePanel';
import type { TraceLegVerdict } from '../../../services/routeTracer';

export interface TracerWaypointListProps {
    capturedCoords: { lat: number; lon: number }[];
    /** Verdict for the leg ARRIVING at pin i lives at index i-1. */
    legVerdicts: Array<TraceLegVerdict | null>;
    /** Same i-1 offset as legVerdicts, but a Record — not an array. */
    tideLabels: Record<number, string>;
    /** The route's shallowest point, else its last pin. */
    tideAnchor: { lat: number; lon: number } | null;
    departureMs: number | null;
    departureLabel: string | null;
    /** The ref OBJECT — passing .current strands the fly-to on a null map. */
    mapRef: React.RefObject<mapboxgl.Map | null>;
    pulseMarkHalo: (p: { lat: number; lon: number }) => void;
}

export const TracerWaypointList: React.FC<TracerWaypointListProps> = ({
    capturedCoords,
    legVerdicts,
    tideLabels,
    tideAnchor,
    departureMs,
    departureLabel,
    mapRef,
    pulseMarkHalo,
}) => {
    return (
        <>
            {capturedCoords.length === 0 ? (
                <div className="shrink-0 px-3 py-3 text-[11px] leading-snug text-gray-400">
                    Tap the chart along your intended track — each leg is checked for depth, markers and land as you go.
                    Zoom right in for tight channels. Drag a pin to nudge it; tap a pin to delete it or insert after it.
                    <div className="pt-1">
                        <span className="text-emerald-300">●</span> good water ·{' '}
                        <span className="text-amber-300">●</span> check it · <span className="text-red-400">●</span>{' '}
                        no-go at low tide
                    </div>
                </div>
            ) : (
                // No longer its own scroller. The card body scrolls as
                // one column now, so a nested scroller here would trap
                // the wheel and re-create the 40px sliver that clipped
                // the tide rows mid-glyph (Shane 2026-07-28: "it has
                // no room to grow").
                <div className="shrink-0 space-y-1 px-3 py-2">
                    {/* Tide rides INSIDE the scroller, not above it.
                        As a pinned sibling it ate the waypoint
                        list's slack and pushed Save off the card
                        entirely — this card is fixed-height by
                        design and the list is its only flex-1
                        child, so anything added outside the
                        scroller comes straight out of the list.
                        -mx-3 cancels the scroller's padding so the
                        panel's own rules still meet the edges. */}
                    <div className="-mx-3 -mt-2 mb-1">
                        <TracerTidePanel anchor={tideAnchor} departureMs={departureMs} />
                        {departureLabel ? (
                            <p
                                data-testid="tracer-departure-window"
                                className="border-t border-white/10 px-3 py-2 text-[10px] font-bold leading-snug text-emerald-300"
                            >
                                {departureLabel}
                            </p>
                        ) : null}
                    </div>
                    {capturedCoords.map((c, i) => {
                        if (i === 0)
                            return (
                                <div key="p0" className="font-mono text-[10px] text-gray-500">
                                    <span className="text-amber-400">1.</span> {c.lat.toFixed(5)}, {c.lon.toFixed(5)}
                                </div>
                            );
                        const v = legVerdicts[i - 1];
                        const dot = !v
                            ? 'text-gray-500'
                            : v.grade === 'danger'
                              ? 'text-red-400'
                              : v.grade === 'caution'
                                ? 'text-amber-300'
                                : 'text-emerald-300';
                        // A clear leg normally reads "clear — N m least",
                        // but a green 'info' note (e.g. "Red mark to your
                        // port — correct side heading in") takes its place
                        // so a right mark-pass shows its confirmation.
                        const infoNote = v?.issues.find((iss) => iss.severity === 'info');
                        const msg = !v
                            ? 'checking…'
                            : v.grade === 'clear'
                              ? infoNote
                                  ? infoNote.message
                                  : v.minDepthM !== null
                                    ? `clear — ${v.minDepthM.toFixed(1)} m least`
                                    : 'clear'
                              : (v.issues.find((iss) => iss.severity !== 'info')?.message ?? v.grade);
                        // Tap a leg row → fly to the MARK it's
                        // about (haloed) when there is one, else
                        // the problem spot / leg midpoint.
                        const firstIssue = v?.issues[0];
                        const spot = firstIssue?.mark ??
                            firstIssue?.at ??
                            v?.minAt ?? {
                                lat: (capturedCoords[i - 1].lat + c.lat) / 2,
                                lon: (capturedCoords[i - 1].lon + c.lon) / 2,
                            };
                        return (
                            <div
                                key={i}
                                onClick={() => {
                                    const m = mapRef.current;
                                    if (!m) return;
                                    triggerHaptic('light');
                                    m.flyTo({
                                        center: [spot.lon, spot.lat],
                                        zoom: Math.max(m.getZoom(), 15),
                                        duration: 700,
                                    });
                                    if (firstIssue?.mark) pulseMarkHalo(firstIssue.mark);
                                }}
                                className="cursor-pointer active:opacity-70"
                            >
                                <div className="flex items-start gap-1.5 text-[11px] leading-tight">
                                    <span className={`${dot} font-black`}>
                                        {v?.grade === 'danger' ? '⛔' : v?.grade === 'caution' ? '⚠' : '●'}
                                    </span>
                                    <span className="text-gray-200">
                                        <span className="font-mono text-gray-400">
                                            {i}→{i + 1}
                                        </span>{' '}
                                        {msg}
                                    </span>
                                </div>
                                {v && (tideLabels[i - 1] || v.nudge || v.issues.length > 1) && (
                                    <div className="pl-4 text-[10px] leading-tight text-gray-400">
                                        {v.issues.slice(1).map((iss, k) => (
                                            <div
                                                key={k}
                                                onClick={(e) => {
                                                    const tgt = iss.mark ?? iss.at;
                                                    const m = mapRef.current;
                                                    if (!tgt || !m) return;
                                                    e.stopPropagation();
                                                    triggerHaptic('light');
                                                    m.flyTo({
                                                        center: [tgt.lon, tgt.lat],
                                                        zoom: Math.max(m.getZoom(), 15),
                                                        duration: 700,
                                                    });
                                                    if (iss.mark) pulseMarkHalo(iss.mark);
                                                }}
                                                className={
                                                    iss.mark || iss.at
                                                        ? 'cursor-pointer underline decoration-dotted underline-offset-2 active:opacity-70'
                                                        : undefined
                                                }
                                            >
                                                · {iss.message}
                                            </div>
                                        ))}
                                        {tideLabels[i - 1] && <div>🌊 {tideLabels[i - 1]}</div>}
                                        {v.nudge && <div>💡 {v.nudge}</div>}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
};
