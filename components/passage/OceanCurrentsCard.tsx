/**
 * OceanCurrentsCard — Surface current briefing for passage planning.
 *
 * Shows NOAA CoastWatch surface-current data along the planned route.
 * Segments rated: favourable ↗️ / adverse ↙️ / cross ↔️.
 * "Enhance" button downloads the requested route-corridor data from NOAA ERDDAP.
 * Red → Green when skipper acknowledges the briefing.
 */

import React, { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { OceanCurrentService, type CurrentBriefing } from '../../services/OceanCurrentService';
import { useSettings } from '../../context/SettingsContext';
import { type Voyage } from '../../services/VoyageService';
import { triggerHaptic } from '../../utils/system';
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';
import {
    useReadinessIdentityScope,
    useScopedReadinessStorageState,
    useSingleCheckSync,
} from '../../hooks/useReadinessSync';
import { isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import {
    isAcknowledgementFresh,
    currentReviewFingerprint,
    isCurrentAcknowledgementRecord,
    passageDataFingerprint,
    passageRouteFingerprint,
    type CurrentAcknowledgementRecord,
} from '../../services/passageEnvironmentReadiness';

interface OceanCurrentsCardProps {
    voyageId?: string;
    departure?: { lat: number; lon: number };
    destination?: { lat: number; lon: number };
    routeCoordinates?: Array<{ lat: number; lon: number }>;
    distanceNM?: number;
    activeVoyage?: Voyage | null;
    onReviewedChange?: (ready: boolean) => void;
}

const STORAGE_KEY = 'thalassa_currents_ack';

export const OceanCurrentsCard: React.FC<OceanCurrentsCardProps> = ({
    voyageId,
    departure,
    destination,
    routeCoordinates,
    distanceNM,
    onReviewedChange,
}) => {
    const identityScope = useReadinessIdentityScope();
    const [briefing, setBriefing] = useState<CurrentBriefing | null>(null);
    const [briefingInputFingerprint, setBriefingInputFingerprint] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [enhancing, setEnhancing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestGenerationRef = useRef(0);
    const acknowledgementMutationRef = useRef(0);
    const [acknowledgement, setAcknowledgement] = useScopedReadinessStorageState<unknown>(STORAGE_KEY, voyageId, null);

    // Coordinates
    const depLat = departure?.lat ?? null;
    const depLon = departure?.lon ?? null;
    const destLat = destination?.lat ?? null;
    const destLon = destination?.lon ?? null;

    const hasCoords = depLat != null && depLon != null && destLat != null && destLon != null;

    // Course bearing
    let courseBearing = 0;
    if (hasCoords) {
        courseBearing = calculateBearing(depLat!, depLon!, destLat!, destLon!);
    }

    // Route distance + vessel speed
    // Reads from settings.vessel (canonical store from onboarding) —
    // was reading from VesselProfileService.load() which lived in a
    // separate localStorage key and could diverge from the user's
    // actual vessel profile.
    const dist = distanceNM ?? (hasCoords ? calculateDistance(depLat!, depLon!, destLat!, destLon!) : 0);
    const { settings } = useSettings();
    const speed = settings.vessel?.cruisingSpeed || 6;
    const routeFingerprint = useMemo(
        () => passageRouteFingerprint(routeCoordinates, departure, destination),
        [routeCoordinates, departure, destination],
    );
    const currentInputFingerprint = passageDataFingerprint('ocean-current-card-input', {
        departure,
        destination,
        courseBearing,
        distanceNm: dist,
        cruisingSpeedKts: speed,
    });
    const reviewFingerprint =
        briefing?.availability === 'available' && briefingInputFingerprint === currentInputFingerprint
            ? currentReviewFingerprint({
                  routeFingerprint,
                  cruisingSpeedKts: speed,
                  distanceNm: dist,
                  courseBearingDeg: courseBearing,
              })
            : null;
    // The READINESS tick is bound to the ROUTE and the 7-day TTL — never to
    // the live briefing (Shane 2026-08-26: "refuse to stay green" — the old
    // compare demanded an available, input-matching briefing before it even
    // consulted the stored ack, so a slow or stale CMEMS feed greyed a valid
    // acknowledgement). Creating an ack still requires the live briefing;
    // holding one needs the same route, acknowledged within the week.
    const acknowledged =
        isCurrentAcknowledgementRecord(acknowledgement) &&
        acknowledgement.routeFingerprint === routeFingerprint &&
        isAcknowledgementFresh(acknowledgement.acknowledgedAt);

    useLayoutEffect(() => {
        requestGenerationRef.current += 1;
        acknowledgementMutationRef.current += 1;
        setBriefing(null);
        setBriefingInputFingerprint(null);
        setLoading(false);
        setEnhancing(false);
        setError(null);
    }, [identityScope, voyageId]);

    useEffect(
        () => () => {
            requestGenerationRef.current += 1;
        },
        [],
    );

    // Supabase sync — the ack is per-voyage so this is a single-check
    // sync (one row per voyage). A checked row is restored only when it carries
    // the fingerprinted review record; legacy boolean-only rows fail closed.
    const { syncSingleCheck } = useSingleCheckSync(voyageId, 'ocean_currents', 'acknowledged');
    useEffect(() => {
        if (!voyageId) return;
        const operationScope = identityScope;
        const mutationAtLoadStart = acknowledgementMutationRef.current;
        let cancelled = false;
        void import('../../services/ReadinessCheckService')
            .then(({ ReadinessCheckService }) => ReadinessCheckService.loadCardChecks(voyageId, 'ocean_currents'))
            .then((checks) => {
                if (
                    cancelled ||
                    !isAuthIdentityScopeCurrent(operationScope) ||
                    acknowledgementMutationRef.current !== mutationAtLoadStart
                ) {
                    return;
                }
                const remote = checks.acknowledged;
                if (remote?.checked && isCurrentAcknowledgementRecord(remote.metadata)) {
                    setAcknowledgement(remote.metadata);
                }
            })
            .catch(() => {
                /* scoped local record remains authoritative while offline */
            });
        return () => {
            cancelled = true;
        };
    }, [identityScope, voyageId, setAcknowledgement]);

    useEffect(() => {
        onReviewedChange?.(acknowledged);
    }, [acknowledged, onReviewedChange]);

    const fetchCurrents = useCallback(
        async (enhance = false) => {
            if (!hasCoords) return;
            const operationScope = identityScope;
            const operationGeneration = ++requestGenerationRef.current;
            const isOperationCurrent = () =>
                isAuthIdentityScopeCurrent(operationScope) && requestGenerationRef.current === operationGeneration;
            enhance ? setEnhancing(true) : setLoading(true);
            setError(null);

            try {
                const bbox = {
                    south: Math.min(depLat!, destLat!),
                    north: Math.max(depLat!, destLat!),
                    west: Math.min(depLon!, destLon!),
                    east: Math.max(depLon!, destLon!),
                };
                const data = await OceanCurrentService.fetchCurrents(bbox, courseBearing, dist, speed, enhance);
                if (!isOperationCurrent()) return;
                setBriefing(data);
                setBriefingInputFingerprint(currentInputFingerprint);
            } catch {
                if (isOperationCurrent()) setError('Failed to fetch current data');
            } finally {
                if (isOperationCurrent()) {
                    setLoading(false);
                    setEnhancing(false);
                }
            }
        },
        [
            identityScope,
            hasCoords,
            depLat,
            depLon,
            destLat,
            destLon,
            courseBearing,
            dist,
            speed,
            currentInputFingerprint,
        ],
    );

    // Auto-fetch on mount
    useEffect(() => {
        if (hasCoords) void fetchCurrents(false);
    }, [hasCoords, fetchCurrents]);

    const handleAcknowledge = useCallback(() => {
        if (!voyageId || !reviewFingerprint || briefing?.availability !== 'available') return;
        acknowledgementMutationRef.current += 1;
        const record: CurrentAcknowledgementRecord = {
            version: 1,
            fingerprint: reviewFingerprint,
            routeFingerprint,
            // Stored for provenance/telemetry only — deliberately NOT part
            // of the matching fingerprint.
            dataFingerprint: briefing.dataFingerprint,
            acknowledgedAt: new Date().toISOString(),
        };
        setAcknowledgement(record);
        triggerHaptic('medium');
        // Mirror to Supabase so the ack follows the skipper to other
        // devices. Fire-and-forget — the UI has already advanced; if
        // the server write fails the next session re-syncs from
        // localStorage on this device.
        syncSingleCheck(true, { ...record });
    }, [voyageId, reviewFingerprint, briefing, routeFingerprint, setAcknowledgement, syncSingleCheck]);

    const segmentIcon = (type: string) => {
        switch (type) {
            case 'favourable':
                return '↗️';
            case 'adverse':
                return '↙️';
            default:
                return '↔️';
        }
    };

    const segmentColor = (type: string) => {
        switch (type) {
            case 'favourable':
                return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
            case 'adverse':
                return 'text-red-400 bg-red-500/10 border-red-500/20';
            default:
                return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
        }
    };

    return (
        <div className="space-y-4">
            {/* No coordinates */}
            {!hasCoords && (
                <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-xl p-4 text-center">
                    <p className="text-2xl mb-2">🌀</p>
                    <p className="text-xs text-gray-400">
                        Plan a route first to analyse ocean currents along your passage.
                    </p>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 text-center">
                    <div className="w-8 h-8 border-2 border-cyan-400/20 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-xs text-gray-400">Fetching NOAA CoastWatch surface currents...</p>
                </div>
            )}

            {/* Error */}
            {error && !loading && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2">
                    <span className="text-lg">⚠️</span>
                    <div className="flex-1">
                        <p className="text-xs text-red-400">{error}</p>
                    </div>
                    <button onClick={() => fetchCurrents(false)} className="text-[11px] font-bold text-cyan-400">
                        Retry
                    </button>
                </div>
            )}

            {briefing?.availability === 'unavailable' && !loading && (
                <div role="alert" className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 space-y-2">
                    <div className="flex items-start gap-2">
                        <span className="text-lg">⚠️</span>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-red-300">Current data unavailable</p>
                            <p className="text-[11px] text-red-200/75 mt-0.5">{briefing.errorMessage}</p>
                            <p className="text-[11px] text-gray-400 mt-1">
                                Provider: {briefing.provider} · no current speed has been assumed.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => fetchCurrents(false)}
                        className="w-full py-2 rounded-lg text-[11px] font-bold text-cyan-300 bg-cyan-500/10 border border-cyan-500/20"
                    >
                        Retry current briefing
                    </button>
                </div>
            )}

            {/* Results */}
            {briefing?.availability === 'available' && !loading && (
                <>
                    {/* Overview */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                        <div className="flex items-center gap-3 mb-3">
                            <span className="text-xl">🌊</span>
                            <div className="flex-1">
                                <h4 className="text-xs font-bold text-white uppercase tracking-widest">
                                    Surface Currents — {briefing.source === 'nrt' ? 'Near Real-Time' : 'Standard'}
                                </h4>
                                <p className="text-[11px] text-gray-500 mt-0.5">
                                    {briefing.provider} · {briefing.providerDataset ?? 'provider field'} ·{' '}
                                    {briefing.retrieval === 'cached' ? 'cached' : 'downloaded'}{' '}
                                    {new Date(briefing.fetchedAt).toLocaleString()}
                                </p>
                            </div>
                        </div>

                        {/* Stats grid */}
                        {briefing.coverage !== 'empty' && (
                            <div className="grid grid-cols-3 gap-2 text-center">
                                <div className="bg-white/[0.03] rounded-lg p-2">
                                    <p className="text-[11px] text-gray-500 uppercase font-bold">Avg</p>
                                    <p className="text-sm font-bold text-cyan-400">{briefing.avgSpeedKts}kt</p>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg p-2">
                                    <p className="text-[11px] text-gray-500 uppercase font-bold">Max</p>
                                    <p className="text-sm font-bold text-amber-400">{briefing.maxSpeedKts}kt</p>
                                </div>
                                <div className="bg-white/[0.03] rounded-lg p-2">
                                    <p className="text-[11px] text-gray-500 uppercase font-bold">Net Effect</p>
                                    <p
                                        className={`text-sm font-bold ${
                                            briefing.netEffectHours < 0
                                                ? 'text-emerald-400'
                                                : briefing.netEffectHours > 0
                                                  ? 'text-red-400'
                                                  : 'text-gray-400'
                                        }`}
                                    >
                                        {briefing.netEffectHours > 0 ? '+' : ''}
                                        {briefing.netEffectHours}h
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Segments */}
                    {briefing.segments.length > 0 && (
                        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                            <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3">
                                🧭 Route Segments
                            </h4>
                            <div className="space-y-2">
                                {briefing.segments.map((seg, i) => (
                                    <div
                                        key={i}
                                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${segmentColor(seg.type)}`}
                                    >
                                        <span className="text-lg">{segmentIcon(seg.type)}</span>
                                        <div className="flex-1">
                                            <p className="text-xs font-bold capitalize">{seg.type} Current</p>
                                            <p className="text-[11px] opacity-70">{seg.avgSpeedKts}kt average</p>
                                        </div>
                                        <span className="text-xs font-bold opacity-70">Leg {i + 1}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* No significant currents */}
                    {briefing.coverage === 'empty' && (
                        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 text-center">
                            <p className="text-xs font-bold text-cyan-200">Provider returned an empty current field</p>
                            <p className="text-[11px] text-gray-400 mt-1">
                                This is the authoritative NOAA response for the route, not a substituted 0-current
                                result.
                            </p>
                        </div>
                    )}

                    {briefing.coverage === 'calm' && (
                        <div className="bg-cyan-500/[0.05] border border-cyan-500/15 rounded-xl p-3 text-center">
                            <p className="text-xs text-cyan-200">
                                NOAA returned current vectors and they are calm at this field&apos;s resolution.
                            </p>
                        </div>
                    )}

                    {/* Enhance button (NRT) */}
                    {briefing.source === 'climatology' && (
                        <button
                            onClick={() => fetchCurrents(true)}
                            disabled={enhancing}
                            className="w-full py-2.5 bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs font-bold rounded-xl hover:bg-cyan-500/20 transition-all active:scale-[0.98] disabled:opacity-50"
                        >
                            {enhancing ? (
                                <span className="flex items-center justify-center gap-2">
                                    <span className="w-3 h-3 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
                                    Downloading real-time data...
                                </span>
                            ) : (
                                '🛰️ Enhance — Download Real-Time Currents'
                            )}
                        </button>
                    )}
                </>
            )}

            {/* Acknowledge */}
            <div
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                    acknowledged ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/[0.03] border-white/[0.06]'
                }`}
            >
                {acknowledged ? (
                    <>
                        <span className="text-lg">✅</span>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-emerald-400">Current briefing acknowledged</p>
                            <p className="text-[11px] text-emerald-400/60 mt-0.5">
                                {briefing?.availability === 'available'
                                    ? `${briefing.avgSpeedKts}kt avg · ${briefing.segments.length} segments analysed`
                                    : 'Briefing completed'}
                            </p>
                        </div>
                    </>
                ) : (
                    <button
                        onClick={handleAcknowledge}
                        disabled={!reviewFingerprint}
                        className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-bold text-sm rounded-xl transition-all active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Acknowledge Current Briefing
                    </button>
                )}
            </div>
            {!acknowledged && isCurrentAcknowledgementRecord(acknowledgement) && (
                <p role="status" className="text-[11px] text-amber-300 text-center">
                    The route changed or the acknowledgement expired — review and acknowledge this briefing again.
                </p>
            )}
        </div>
    );
};
