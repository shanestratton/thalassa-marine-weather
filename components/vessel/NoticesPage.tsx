/**
 * NoticesPage — Notice to Mariners browse view.
 *
 * Fetches active broadcast warnings from NGA MSI (NAVAREA IV/XII +
 * HYDROLANT/HYDROPAC/HYDROARC) and lists them grouped by area with an
 * expandable full-text view per notice. Results are cached for 6 hours
 * in localStorage so repeat opens are instant.
 *
 * Scope: MVP surfaces NGA-issued warnings only. National hydrographic
 * offices (UKHO, AHS, LINZ, CHS, etc.) will be added as additional
 * sources behind the same list.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { triggerHaptic } from '../../utils/system';
import { NoticeToMarinersService, labelFor, type Notice } from '../../services/NoticeToMarinersService';
import { GpsService } from '../../services/GpsService';

interface NoticesPageProps {
    onBack: () => void;
}

type AreaFilter = 'all' | '4' | '12' | 'C' | 'P' | 'A' | 'X';

/** "Near me" radius in nautical miles. NotM coordinates outside this
 *  distance from the vessel's current position are hidden when the
 *  Near-me filter is on. 500 NM covers ~1 week of cruising at 5 kt —
 *  generous for awareness without flooding the list with irrelevance. */
const NEAR_ME_RADIUS_NM = 500;

function distanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R_NM = 3440.065;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Minimum distance (NM) from `pos` to any coordinate parsed out of
 *  the notice's body. Returns Infinity when the notice has no parsed
 *  coordinates — those notices are excluded by Near-me. */
function minNoticeDistanceNM(notice: Notice, pos: { lat: number; lon: number }): number {
    if (notice.coordinates.length === 0) return Infinity;
    let min = Infinity;
    for (const c of notice.coordinates) {
        const d = distanceNM(c.lat, c.lon, pos.lat, pos.lon);
        if (d < min) min = d;
    }
    return min;
}

const FILTERS: Array<{ id: AreaFilter; label: string; short: string; color: string }> = [
    { id: 'all', label: 'All', short: 'All', color: '#22d3ee' },
    { id: '4', label: 'NAVAREA IV', short: 'IV', color: '#0ea5e9' },
    { id: '12', label: 'NAVAREA XII', short: 'XII', color: '#0ea5e9' },
    { id: 'C', label: 'HYDROLANT', short: 'LANT', color: '#a855f7' },
    { id: 'P', label: 'HYDROPAC', short: 'PAC', color: '#f59e0b' },
    { id: 'A', label: 'HYDROARC', short: 'ARC', color: '#14b8a6' },
    { id: 'X', label: 'NAVAREA X', short: 'X', color: '#fbbf24' }, // AHO / JRCC AUSTRALIA
];

function formatIssued(d: Date | null): string {
    if (!d) return '—';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export const NoticesPage: React.FC<NoticesPageProps> = ({ onBack }) => {
    const [notices, setNotices] = useState<Notice[]>(() => NoticeToMarinersService.getCached().notices);
    const [loading, setLoading] = useState(notices.length === 0);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<AreaFilter>('all');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [fetchedAt, setFetchedAt] = useState<number>(() => NoticeToMarinersService.getCached().fetchedAt);
    // Near-me filter — on by default. NGA publishes for US-assigned
    // areas, so without this the list is a global firehose with 300+
    // notices that have nothing to do with the user's actual cruising
    // area. The filter applies only once we have a vessel position;
    // until then we show everything.
    const [nearMe, setNearMe] = useState(true);
    const [vesselPos, setVesselPos] = useState<{ lat: number; lon: number } | null>(null);
    useEffect(() => {
        GpsService.getCurrentPosition({ staleLimitMs: 5 * 60_000, timeoutSec: 8 })
            .then((pos) => {
                if (pos) setVesselPos({ lat: pos.latitude, lon: pos.longitude });
            })
            .catch(() => {
                // No position available — Near-me will be a no-op.
            });
    }, []);

    const load = useCallback(async (force: boolean) => {
        if (force) setRefreshing(true);
        else setLoading((n) => n || true);
        setError(null);
        try {
            const list = await NoticeToMarinersService.refresh(force);
            setNotices(list);
            setFetchedAt(NoticeToMarinersService.getCached().fetchedAt);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to fetch notices';
            // If we have cached data, show it with a softer error indicator.
            const cached = NoticeToMarinersService.getCached();
            if (cached.notices.length > 0) {
                setNotices(cached.notices);
                setFetchedAt(cached.fetchedAt);
                setError(`Offline — showing cached notices`);
            } else {
                setError(msg);
            }
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        // Kick off fetch on mount; honours 6h cache.
        load(false);
    }, [load]);

    const handleRefresh = () => {
        triggerHaptic('medium');
        load(true);
    };

    const toggleExpand = (id: string) => {
        triggerHaptic('light');
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // ── Filtering ──
    const filtered = useMemo(() => {
        let list = filter === 'all' ? notices : notices.filter((n) => n.navArea === filter);
        if (nearMe && vesselPos) {
            list = list.filter((n) => minNoticeDistanceNM(n, vesselPos) <= NEAR_ME_RADIUS_NM);
        }
        return list;
    }, [notices, filter, nearMe, vesselPos]);

    const countsByArea = useMemo(() => {
        const c: Record<string, number> = {};
        for (const n of notices) c[n.navArea] = (c[n.navArea] || 0) + 1;
        return c;
    }, [notices]);

    // Count for the Near-me chip — how many of the area-filtered set
    // are within the radius. Shown as the chip's count badge.
    const nearMeCount = useMemo(() => {
        if (!vesselPos) return 0;
        const areaFiltered = filter === 'all' ? notices : notices.filter((n) => n.navArea === filter);
        return areaFiltered.filter((n) => minNoticeDistanceNM(n, vesselPos) <= NEAR_ME_RADIUS_NM).length;
    }, [notices, filter, vesselPos]);

    return (
        <div
            className="w-full h-full flex flex-col"
            style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
        >
            <PageHeader
                title="Notices to Mariners"
                subtitle={
                    fetchedAt
                        ? `Updated ${new Date(fetchedAt).toLocaleTimeString(undefined, {
                              hour: '2-digit',
                              minute: '2-digit',
                          })} • ${notices.length} active`
                        : 'Live broadcast warnings'
                }
                onBack={onBack}
                action={
                    <button
                        onClick={handleRefresh}
                        disabled={refreshing}
                        aria-label="Refresh notices"
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center press disabled:opacity-50"
                    >
                        <svg
                            className={`w-5 h-5 text-gray-300 ${refreshing ? 'animate-spin' : ''}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                            />
                        </svg>
                    </button>
                }
            />

            {/* ── Filter chips ── */}
            <div className="shrink-0 px-4 pb-2 overflow-x-auto no-scrollbar">
                <div className="flex gap-2">
                    {/* Near-me toggle — first chip so it's the primary
                        affordance. Disabled until we have a GPS fix. */}
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setNearMe((v) => !v);
                        }}
                        disabled={!vesselPos}
                        title={!vesselPos ? 'Waiting for GPS fix…' : `Within ${NEAR_ME_RADIUS_NM} NM of your position`}
                        className="shrink-0 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-widest transition-all disabled:opacity-40"
                        style={{
                            background: nearMe && vesselPos ? '#10b98124' : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${nearMe && vesselPos ? '#10b98166' : 'rgba(255,255,255,0.08)'}`,
                            color: nearMe && vesselPos ? '#10b981' : '#9ca3af',
                        }}
                    >
                        📍 Near me <span className="opacity-60 ml-1">{vesselPos ? nearMeCount : '…'}</span>
                    </button>
                    {FILTERS.map((f) => {
                        const active = filter === f.id;
                        const count = f.id === 'all' ? notices.length : countsByArea[f.id] || 0;
                        return (
                            <button
                                key={f.id}
                                onClick={() => {
                                    triggerHaptic('light');
                                    setFilter(f.id);
                                }}
                                className="shrink-0 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-widest transition-all"
                                style={{
                                    background: active ? `${f.color}24` : 'rgba(255,255,255,0.04)',
                                    border: `1px solid ${active ? f.color + '66' : 'rgba(255,255,255,0.08)'}`,
                                    color: active ? f.color : '#9ca3af',
                                }}
                            >
                                {f.short} <span className="opacity-60 ml-1">{count}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Content ── */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-2">
                {loading && notices.length === 0 ? (
                    <div className="space-y-3">
                        {[0, 1, 2, 3].map((i) => (
                            <ShimmerBlock key={i} className="h-24 rounded-2xl" />
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <EmptyState
                        title={
                            error
                                ? 'Could not load notices'
                                : nearMe && vesselPos
                                  ? `No active notices within ${NEAR_ME_RADIUS_NM} NM`
                                  : filter === 'all'
                                    ? 'No active notices'
                                    : `No active ${labelFor(filter)} notices`
                        }
                        description={
                            error
                                ? error
                                : nearMe && vesselPos
                                  ? `Currently sourced from NGA MSI (NAVAREA IV/XII + HYDROLANT/PAC/ARC) and AMSA (NAVAREA X, Australia). UK (UKHO), NZ (LINZ) and other national hydrographic offices aren’t included yet — coming soon. Tap “📍 Near me” to turn the radius filter off and see everything we have.`
                                  : 'Sources: NGA (US-managed waters), AMSA (NAVAREA X). National hydrographic offices for other regions will be added in future updates.'
                        }
                        actionLabel={error ? 'Retry' : undefined}
                        onAction={error ? () => load(true) : undefined}
                    />
                ) : (
                    <div className="space-y-3">
                        {error && (
                            <div className="px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300 font-bold uppercase tracking-widest text-center">
                                {error}
                            </div>
                        )}
                        {filtered.map((n) => (
                            <NoticeCard
                                key={n.id}
                                notice={n}
                                expanded={expanded.has(n.id)}
                                onToggle={() => toggleExpand(n.id)}
                            />
                        ))}
                        <div className="pt-3 pb-4 text-center text-[10px] text-gray-500 uppercase tracking-widest">
                            Source: NGA Maritime Safety Information
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// ── Card ──────────────────────────────────────────────────────────────────

interface NoticeCardProps {
    notice: Notice;
    expanded: boolean;
    onToggle: () => void;
}

const AREA_COLORS: Record<string, string> = {
    '4': '#0ea5e9',
    '12': '#0ea5e9',
    C: '#a855f7',
    P: '#f59e0b',
    A: '#14b8a6',
};

const NoticeCard: React.FC<NoticeCardProps> = ({ notice, expanded, onToggle }) => {
    const color = AREA_COLORS[notice.navArea] || '#9ca3af';
    return (
        <button
            onClick={onToggle}
            className="w-full text-left rounded-2xl transition-all active:scale-[0.995]"
            style={{
                background: 'rgba(20, 25, 35, 0.6)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
        >
            <div className="p-3.5">
                <div className="flex items-center gap-2 mb-1.5">
                    <span
                        className="px-1.5 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest"
                        style={{ background: `${color}24`, color }}
                    >
                        {notice.areaLabel}
                    </span>
                    <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                        {notice.msgYear}/{notice.msgNumber}
                    </span>
                    <span className="flex-1" />
                    <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                        {formatIssued(notice.issueDateParsed)}
                    </span>
                </div>
                <h3 className="text-[13px] font-black text-white tracking-wide leading-snug">{notice.title}</h3>
                {notice.coordinates.length > 0 && (
                    <p className="mt-1 text-[10px] text-gray-400 font-bold uppercase tracking-widest">
                        {notice.coordinates.length === 1 ? `1 position` : `${notice.coordinates.length} positions`}
                    </p>
                )}
                {expanded && (
                    <div className="mt-3 pt-3 border-t border-white/5">
                        <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">
                            {notice.text.trim()}
                        </pre>
                        {notice.authority && (
                            <p className="mt-2 text-[10px] text-gray-500 italic">Authority: {notice.authority}</p>
                        )}
                    </div>
                )}
            </div>
        </button>
    );
};
