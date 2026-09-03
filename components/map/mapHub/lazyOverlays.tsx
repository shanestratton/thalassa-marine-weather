/**
 * MapHub — lazy-loaded overlay chunks and their loading fallbacks.
 *
 * Moved out of MapHub.tsx as-is during the MapHub break-up. These are
 * module-scope declarations with no closure over the component, so the move
 * is a pure text relocation: the chunks are still created when MapHub's
 * module graph loads, and each component type stays a stable identity.
 *
 * The import specifiers gained one `../` because this file sits a directory
 * deeper; nothing else about them changed.
 */
import React from 'react';
import { lazyRetry } from '../../../utils/lazyRetry';

// ── Lazy-loaded overlay components (split into separate chunks) ──
export const ConsensusMatrix = lazyRetry(
    () => import('../ConsensusMatrix').then((m) => ({ default: m.ConsensusMatrix })),
    'ConsensusMatrix',
);
export const VesselSearch = lazyRetry(
    () => import('../VesselSearch').then((m) => ({ default: m.VesselSearch })),
    'VesselSearch',
);
export const AisLegend = lazyRetry(() => import('../AisLegend').then((m) => ({ default: m.AisLegend })), 'AisLegend');
export const CmemsAttribution = lazyRetry(
    () => import('../CmemsAttribution').then((m) => ({ default: m.CmemsAttribution })),
    'CmemsAttribution',
);
export const ChartKeyPanel = lazyRetry(
    () => import('../ChartKeyPanel').then((module) => ({ default: module.ChartKeyPanel })),
    'ChartKeyPanel',
);
export const AisGuardAlert = lazyRetry(
    () => import('../AisGuardAlert').then((m) => ({ default: m.AisGuardAlert })),
    'AisGuardAlert',
);
export const GhostShip = lazyRetry(() => import('../GhostShip').then((m) => ({ default: m.GhostShip })), 'GhostShip');
export const RouteLegend = lazyRetry(
    () => import('../RouteLegend').then((m) => ({ default: m.RouteLegend })),
    'RouteLegend',
);
export const PassageDataPanel = lazyRetry(
    () => import('../PassageDataPanel').then((m) => ({ default: m.PassageDataPanel })),
    'PassageDataPanel',
);
export const OfflineAreaModal = lazyRetry(
    () => import('../OfflineAreaModal').then((m) => ({ default: m.OfflineAreaModal })),
    'OfflineAreaModal',
);
// Route review is an intentional, post-planning step. Keeping its report UI
// out of the initial chart chunk makes first map paint cheaper without
// compromising the review path once the skipper asks for it.
export const TraceReportModal = lazyRetry(
    () => import('../TraceReportModal').then((m) => ({ default: m.TraceReportModal })),
    'TraceReportModal',
);
export const TraceReportLoading: React.FC = () => (
    <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-10050 flex items-center justify-center bg-black/60 px-4 text-center text-sm font-bold text-sky-200"
    >
        Opening route report…
    </div>
);
export const RouteTrackPicker = lazyRetry(
    () => import('../RouteTrackPicker').then((m) => ({ default: m.RouteTrackPicker })),
    'RouteTrackPicker',
);
export const RouteTrackPickerLoading: React.FC<{ label: string }> = ({ label }) => (
    <div
        role="status"
        aria-live="polite"
        className="fixed left-1/2 top-20 z-185 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-900/95 px-4 py-3 text-center text-xs font-bold text-sky-200 shadow-xl"
    >
        {label}
    </div>
);
export const MapWeatherControls = lazyRetry(
    () => import('../MapWeatherControls').then((m) => ({ default: m.MapWeatherControls })),
    'MapWeatherControls',
);
export const StormPicker = lazyRetry(
    () => import('../StormPicker').then((m) => ({ default: m.StormPicker })),
    'StormPicker',
);
export const StormPickerLoading: React.FC = () => (
    <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-9999 flex items-center justify-center bg-black/60 px-4 text-center text-sm font-bold text-red-100"
    >
        Opening storm picker…
    </div>
);
