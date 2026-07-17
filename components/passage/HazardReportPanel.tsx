/**
 * HazardReportPanel — surfaces ENC OBSTRN/WRECKS/UWTROC hazards
 * found within a 1 NM buffer of the most recently planned route.
 *
 * Renders as a small floating card on the map — TOP-RIGHT, under the
 * safe-area inset (`absolute right-3`; the old "bottom-left" claim was
 * comment drift, closing audit) — when there's at least one hazard. Tap to
 * expand into a full list with distance, side, depth, and CATZOC.
 *
 * Self-contained:
 *   - Subscribes to EncHazardReportService.subscribeToReport so it
 *     refreshes automatically when routing produces a new report
 *     (or clears one).
 *   - Hides itself when no report exists, no hazards in report, or
 *     the user dismisses the expanded view.
 *
 * Trip overview / PDF integration is left for a follow-up — we
 * surface this on the map where the user is already looking when
 * they finish planning.
 */

import React, { useState } from 'react';

import { useLastHazardReport } from '../../services/enc/EncHazardReportService';
import type { RouteHazardReportEntry } from '../../services/enc/EncHazardReportService';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';

// ── Helpers ────────────────────────────────────────────────────────

function hazardIcon(type: RouteHazardReportEntry['hazardType']): string {
    switch (type) {
        case 'wreck':
            return '\u{1F480}'; // skull
        case 'rock':
            return '\u{1FAA8}'; // 🪨 rock
        case 'obstruction':
            return '⚠'; // warning
        case 'coast':
            return '\u{1F3D6}'; // beach
        default:
            return '⚠';
    }
}

function hazardLabel(type: RouteHazardReportEntry['hazardType']): string {
    switch (type) {
        case 'wreck':
            return 'Wreck';
        case 'rock':
            return 'Underwater rock';
        case 'obstruction':
            return 'Obstruction';
        case 'coast':
            return 'Charted coastline';
        default:
            return 'Hazard';
    }
}

function sideLabel(side: RouteHazardReportEntry['side']): string {
    return side === 'port' ? '◐ port' : side === 'starboard' ? '◑ stbd' : '◉ on';
}

function formatDistance(nm: number): string {
    if (nm < 0.05) return '<0.05 NM';
    if (nm < 1) return `${nm.toFixed(2)} NM`;
    return `${nm.toFixed(1)} NM`;
}

function formatLatLon(p: { lat: number; lon: number }): string {
    const lat = `${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? 'E' : 'W'}`;
    return `${lat} ${lon}`;
}

// ── Component ──────────────────────────────────────────────────────

interface HazardReportPanelProps {
    /** Hide the panel even if a report exists — used when passage
     *  mode is off (no route on screen). */
    visible: boolean;
    /**
     * Optional click handler. When supplied, each hazard row in
     * the expanded list becomes tappable and dispatches the
     * representative point — typically wired by the map host to
     * fly-to that lat/lon. When omitted, rows are non-interactive.
     */
    onHazardClick?: (entry: RouteHazardReportEntry) => void;
}

export const HazardReportPanel: React.FC<HazardReportPanelProps> = ({ visible, onHazardClick }) => {
    const report = useLastHazardReport();
    const [expanded, setExpanded] = useState(false);

    const advisories = report?.advisories ?? [];

    if (!visible) return null;
    if (!report || (report.entries.length === 0 && advisories.length === 0)) return null;

    const total = report.entries.length;
    // A 'caution' advisory = the route crosses water with NO confirmed depth
    // (route+warn policy). It outranks hazards in the headline because it's the
    // one thing the skipper can't see on the chart at all.
    const cautions = advisories.filter((a) => a.severity === 'caution');
    const hasCaution = cautions.length > 0;
    // Headline from the STRUCTURED advisory kind (2026-07-17 audit: the old
    // substring matching silently degraded when prose changed, and
    // first-caution-wins hid co-present cautions when collapsed). Prose
    // matching remains ONLY as a fallback for kind-less advisories.
    const KIND_HEADLINES: Record<string, string> = {
        'no-data': 'Unverified depth on route',
        'not-validated': 'Route NOT verified',
        exhaustion: 'Route not fully verified',
        'draft-clamp': 'Draft exceeds depth model',
        'caution-crossing': 'Route crosses a prohibited area',
        'tide-constrained': 'Tide-constrained leg',
        'gebco-share': 'Depths verified on ocean bathymetry',
        'lateral-clearance': 'Route grazes charted hazard',
        'segment-check-failed': 'Thin-islet check did not run',
    };
    const firstCaution = cautions[0];
    const baseHeadline = !firstCaution
        ? null
        : (firstCaution.kind && KIND_HEADLINES[firstCaution.kind]) ||
          (firstCaution.text.includes('NO depth data')
              ? 'Unverified depth on route'
              : firstCaution.text.includes('draft')
                ? 'Draft exceeds depth model'
                : 'Route caution — verify visually');
    // Co-present cautions surface in the collapsed header instead of hiding
    // behind the first one.
    const cautionHeadline =
        baseHeadline && cautions.length > 1 ? `${baseHeadline} +${cautions.length - 1} more` : baseHeadline;
    const headline = hasCaution
        ? cautionHeadline!
        : total === 0
          ? 'Route advisory — verify visually'
          : total === 1
            ? '1 hazard near route'
            : `${total} hazards near route`;
    // Red frame + icon when depth is unverified; amber otherwise.
    const accent = hasCaution
        ? { border: 'border-red-500/50', ring: 'border-red-500/40', title: 'text-red-300', icon: '🛑' }
        : { border: 'border-amber-500/40', ring: 'border-amber-500/30', title: 'text-amber-300', icon: '⚠' };

    return (
        <div
            className="absolute z-[600] right-3"
            style={{
                top: 'calc(env(safe-area-inset-top) + 96px)',
                maxWidth: 'min(320px, calc(100vw - 24px))',
            }}
            role="region"
            aria-label="ENC hazards near route"
            aria-live="polite"
        >
            <button
                onClick={() => setExpanded((x) => !x)}
                aria-expanded={expanded}
                className={`w-full rounded-xl border ${accent.border} bg-black/75 backdrop-blur-md px-3 py-2 text-left hover:bg-black/85 transition-colors active:scale-[0.98]`}
            >
                <div className="flex items-center gap-2">
                    <span className="text-base">{accent.icon}</span>
                    <div className="flex-1 min-w-0">
                        <p className={`text-[12px] font-bold ${accent.title} leading-tight`}>{headline}</p>
                        <p
                            className={`text-[12px] ${hasCaution ? 'text-red-300/80' : 'text-amber-300/70'} leading-tight`}
                        >
                            {hasCaution
                                ? // Route+warn: the no-data caution text rides IN the collapsed
                                  // header so an unverified-depth route can't be missed without
                                  // expanding (audit: no-data was a silent soft advisory).
                                  firstCaution?.text
                                : total > 0
                                  ? `within ${report.bufferNm.toFixed(1)} NM · ENC vector data${
                                        advisories.length > 0
                                            ? ` · ⚠ ${advisories.length} advisor${advisories.length === 1 ? 'y' : 'ies'}`
                                            : ''
                                    }`
                                  : `${advisories.length} advisor${advisories.length === 1 ? 'y' : 'ies'} · tap to read`}
                        </p>
                    </div>
                    <svg
                        className={`w-3 h-3 text-amber-300/70 transition-transform ${expanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                </div>
            </button>

            {expanded && (
                <div
                    className="mt-1 rounded-xl border border-amber-500/30 bg-black/85 backdrop-blur-md px-3 py-2 max-h-[60vh] overflow-y-auto"
                    role="list"
                >
                    {advisories.length > 0 && (
                        <div className="mb-1.5 pb-1.5 border-b border-amber-500/20" role="listitem">
                            {advisories.map((a, i) => {
                                const caution = a.severity === 'caution';
                                return (
                                    <div key={`adv-${i}`} className="flex items-start gap-2 py-1">
                                        <span className="text-sm shrink-0 mt-0.5">{caution ? '🛑' : '⚠'}</span>
                                        <p
                                            className={`text-[12px] leading-snug ${
                                                caution ? 'text-red-200 font-semibold' : 'text-amber-100'
                                            }`}
                                        >
                                            {a.text}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {report.entries.map((entry, i) => {
                        const lowConf = isLowConfidenceCatzoc(entry.catzoc);
                        const interactive = !!onHazardClick;
                        const Wrapper: React.ElementType = interactive ? 'button' : 'div';
                        return (
                            <Wrapper
                                key={`${entry.cellId}-${entry.representativePoint.lat}-${entry.representativePoint.lon}-${i}`}
                                className={`w-full text-left py-1.5 border-b border-amber-500/10 last:border-b-0 ${
                                    interactive
                                        ? 'cursor-pointer hover:bg-amber-500/[0.04] active:bg-amber-500/[0.08] active:scale-[0.99] transition-colors -mx-1 px-1 rounded'
                                        : ''
                                }`}
                                role="listitem"
                                onClick={interactive ? () => onHazardClick?.(entry) : undefined}
                                aria-label={
                                    interactive
                                        ? `Show ${entry.description ?? hazardLabel(entry.hazardType)} on map`
                                        : undefined
                                }
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-sm shrink-0 mt-0.5">{hazardIcon(entry.hazardType)}</span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[12px] font-bold text-amber-100 leading-tight">
                                            {entry.description ?? hazardLabel(entry.hazardType)}
                                            <span className="ml-1.5 font-normal text-amber-300/80">
                                                {formatDistance(entry.distanceNm)} {sideLabel(entry.side)}
                                            </span>
                                        </p>
                                        <p className="text-[12px] text-amber-200/75 leading-tight font-mono">
                                            {formatLatLon(entry.representativePoint)}
                                        </p>
                                        <div className="text-[12px] text-amber-200/70 leading-tight mt-0.5">
                                            {entry.minDepthM != null && <span>{entry.minDepthM.toFixed(1)} m </span>}
                                            <span className="font-mono">{entry.cellId}</span>
                                            <span> · {entry.sourceHO}</span>
                                            {entry.catzoc != null && (
                                                <span
                                                    className={`ml-1 ${lowConf ? 'text-amber-300' : 'text-emerald-300/70'}`}
                                                >
                                                    · CATZOC {CATZOC_LABELS[entry.catzoc]}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </Wrapper>
                        );
                    })}
                    {total > 0 && (
                        <p className="mt-2 text-[12px] text-amber-300/70 italic">
                            From {report.cellsConsulted} ENC cell{report.cellsConsulted === 1 ? '' : 's'}. Verify
                            visually before relying on these positions.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default HazardReportPanel;
