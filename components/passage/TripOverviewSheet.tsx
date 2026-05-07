/**
 * TripOverviewSheet — whole-trip overview for multi-leg passages.
 *
 * The leg picker chains saved drafts into multi-leg trips so the
 * skipper can plan one leg at a time without losing the bigger
 * picture. This sheet IS that bigger picture: every leg in the trip,
 * the totals, country/visa info, watch-schedule options, provisioning
 * notes, and an "Export PDF" button that produces the on-paper plan.
 *
 * Doesn't replace the per-leg planning surface — it complements it.
 * The user still picks a single leg to dive into weather/meals/etc;
 * the trip view is for the high-level captain's brief that goes
 * out to crew + family before departure.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import type { Voyage } from '../../services/VoyageService';
import { triggerHaptic } from '../../utils/system';
import {
    buildTripOverview,
    enrichTripWithLiveData,
    getCountrySnippets,
    type EnrichedTripOverview,
    type LegForecast,
    type TripOverview,
} from '../../services/TripOverviewService';
import { useSettings } from '../../context/SettingsContext';

interface TripOverviewSheetProps {
    isOpen: boolean;
    onClose: () => void;
    /** Ordered chain of voyages — leg 1 → leg N. Already chained by
     *  the LegPickerDropdown's destination-matching logic. */
    legs: Voyage[];
    /** Optional explicit trip name; defaults to "<first dep> → <last arr>". */
    tripName?: string;
}

function formatDuration(hours: number): string {
    if (!Number.isFinite(hours) || hours <= 0) return '—';
    if (hours < 24) return `${hours.toFixed(1)}h`;
    const days = Math.floor(hours / 24);
    const rem = Math.round(hours % 24);
    return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

function formatDate(iso?: string | null): string {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleDateString('en-AU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        });
    } catch {
        return '—';
    }
}

export const TripOverviewSheet: React.FC<TripOverviewSheetProps> = ({ isOpen, onClose, legs, tripName }) => {
    const { settings } = useSettings();
    const [exporting, setExporting] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    /** Enriched overview — populated asynchronously after the sheet
     *  opens. Holds per-leg forecasts + the trip-level departure
     *  window. While null, the sheet renders the synchronous template
     *  view; once it lands, real numbers appear in the leg cards. */
    const [enriched, setEnriched] = useState<EnrichedTripOverview | null>(null);
    const [enriching, setEnriching] = useState(false);

    const baseOverview: TripOverview | null = useMemo(() => {
        if (legs.length === 0) return null;
        return buildTripOverview(legs, {
            tripName,
            crewCount: settings.vessel?.crewCount,
        });
    }, [legs, tripName, settings.vessel?.crewCount]);

    // Fetch live data when the sheet opens (and re-fetch when the
    // underlying trip changes). Fire-and-forget — the template view
    // renders immediately, the enrichment swaps in when it lands.
    // Cancellation flag protects against the user closing + re-opening
    // mid-fetch, which would otherwise leak a stale enrichment in.
    useEffect(() => {
        if (!isOpen || !baseOverview) {
            setEnriched(null);
            setEnriching(false);
            return;
        }
        let cancelled = false;
        setEnriched(null);
        setEnriching(true);
        (async () => {
            try {
                const result = await enrichTripWithLiveData(baseOverview);
                if (cancelled) return;
                if (result.enrichedAt) setEnriched(result);
            } finally {
                if (!cancelled) setEnriching(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen, baseOverview]);

    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 3000);
        return () => clearTimeout(t);
    }, [toast]);

    if (!isOpen || !baseOverview) return null;

    /** Render-time overview — prefer the enriched copy when we have one. */
    const overview: EnrichedTripOverview = enriched ?? baseOverview;
    const countrySnippets = getCountrySnippets(overview.countries);
    const legsForRender = overview.legsWithForecast ?? overview.legs;

    const handleExportPdf = async () => {
        triggerHaptic('medium');
        setExporting(true);
        try {
            // If the user fires the export before the in-flight
            // enrichment has resolved, force a fresh fetch + await it
            // so the PDF carries the live forecast. The on-screen sheet
            // already shows what it has; this just guarantees the PDF
            // never goes out template-only when network was reachable.
            let toRender: EnrichedTripOverview = enriched ?? baseOverview!;
            if (!enriched?.enrichedAt) {
                try {
                    toRender = await enrichTripWithLiveData(baseOverview!);
                    if (toRender.enrichedAt) setEnriched(toRender);
                } catch {
                    /* fall through to template-only */
                }
            }
            const { generateTripPdf } = await import('../../services/TripPdfService');
            const blob = generateTripPdf(toRender, { vesselName: settings.vessel?.name });
            const filename = `Trip · ${toRender.name.replace(/\s*→\s*/g, ' to ')}.pdf`;

            // On native iOS: write to cache, then share via system sheet.
            // On web: trigger a regular download.
            if (Capacitor.isNativePlatform()) {
                const reader = new FileReader();
                const dataUrl: string = await new Promise((resolve, reject) => {
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(blob);
                });
                const base64 = dataUrl.split(',')[1];
                const result = await Filesystem.writeFile({
                    path: filename,
                    data: base64,
                    directory: Directory.Cache,
                });
                await Share.share({
                    title: `Trip plan: ${overview.name}`,
                    url: result.uri,
                    dialogTitle: 'Share trip plan',
                });
            } else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
            setToast('PDF ready');
        } catch (e) {
            const msg = e instanceof Error ? e.message : '';
            if (msg.includes('cancel') || msg.includes('dismissed')) {
                // user cancelled the share sheet — silent
            } else {
                console.warn('[TripOverviewSheet] PDF export failed:', e);
                setToast('PDF export failed');
            }
        }
        setExporting(false);
    };

    return (
        <div className="fixed inset-0 z-[10000] bg-black/80 flex items-stretch justify-center" onClick={onClose}>
            <div
                className="w-full max-w-lg bg-[#0a0e14] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between p-4 border-b border-white/[0.06] shrink-0">
                    <div className="min-w-0">
                        <p className="text-[11px] font-bold text-sky-400/70 uppercase tracking-widest">Trip Overview</p>
                        <h2 className="text-lg font-black text-white truncate mt-0.5">{overview.name}</h2>
                        {(overview.earliestDepartureIso || overview.latestArrivalIso) && (
                            <p className="text-[11px] text-gray-400 mt-0.5">
                                {formatDate(overview.earliestDepartureIso)} → {formatDate(overview.latestArrivalIso)}
                            </p>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="w-9 h-9 rounded-full bg-white/5 text-gray-400 flex items-center justify-center hover:bg-white/10 shrink-0 ml-2"
                        aria-label="Close trip overview"
                    >
                        ✕
                    </button>
                </div>

                {/* Stats banner */}
                <div className="grid grid-cols-4 gap-2 px-4 py-3 border-b border-white/[0.06] shrink-0">
                    <Stat label="Legs" value={overview.legs.length.toString()} color="text-sky-300" />
                    <Stat label="Total NM" value={overview.totalDistanceNm.toFixed(0)} color="text-emerald-300" />
                    <Stat label="Duration" value={formatDuration(overview.totalDurationHours)} color="text-amber-300" />
                    <Stat label="Countries" value={overview.countries.length.toString() || '—'} color="text-cyan-300" />
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-5">
                    {/* Live data status badge — visible while we fetch
                        the per-leg forecasts + best departure window
                        from WeatherWindowService + fetchFastWeather, OR
                        once the fetch lands so the user knows they're
                        looking at real numbers. */}
                    {enriching && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-500/[0.06] border border-sky-500/15">
                            <div className="w-3 h-3 border-2 border-sky-400/60 border-t-transparent rounded-full animate-spin" />
                            <span className="text-[11px] text-sky-200">Fetching live forecasts…</span>
                        </div>
                    )}
                    {!enriching && enriched?.enrichedAt && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15">
                            <span className="text-base leading-none">✓</span>
                            <span className="text-[11px] text-emerald-200">
                                Live forecast loaded ·{' '}
                                {new Date(enriched.enrichedAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })}
                            </span>
                        </div>
                    )}

                    {/* Best departure window — only when WeatherWindowService
                        produced a usable result for the trip's first
                        leg. Shows the top-rated 6h window across the
                        next 16 days, scored Go/Marginal/Wait. */}
                    {enriched?.bestDepartureWindow && (
                        <Section
                            title="Best Departure Window"
                            subtitle="Top-rated 6 h window across the next 16 days for the first leg's departure point."
                        >
                            <div
                                className={`rounded-xl p-3 border ${
                                    enriched.bestDepartureWindow.rating === 'go'
                                        ? 'bg-emerald-500/10 border-emerald-500/25'
                                        : enriched.bestDepartureWindow.rating === 'marginal'
                                          ? 'bg-amber-500/10 border-amber-500/25'
                                          : 'bg-red-500/10 border-red-500/25'
                                }`}
                            >
                                <div className="flex items-center gap-2">
                                    <span className="text-base">
                                        {enriched.bestDepartureWindow.rating === 'go'
                                            ? '✅'
                                            : enriched.bestDepartureWindow.rating === 'marginal'
                                              ? '⚠️'
                                              : '❌'}
                                    </span>
                                    <span className="text-sm font-black text-white">
                                        {enriched.bestDepartureWindow.label}
                                    </span>
                                    <span className="ml-auto text-[11px] font-bold text-white/70 tabular-nums">
                                        {enriched.bestDepartureWindow.score}/100
                                    </span>
                                </div>
                                <p className="text-[11px] text-white/70 mt-1.5 leading-snug">
                                    {enriched.bestDepartureWindow.description}
                                </p>
                            </div>
                        </Section>
                    )}

                    {/* Itinerary */}
                    <Section title="Itinerary" subtitle="Each leg — plan one at a time from the leg picker.">
                        <div className="space-y-2">
                            {legsForRender.map((leg) => {
                                const enrichedLeg = leg as typeof leg & {
                                    forecast?: LegForecast;
                                    realDistanceNm?: number;
                                };
                                const forecast = enrichedLeg.forecast;
                                const realNm = enrichedLeg.realDistanceNm;
                                const displayNm = typeof realNm === 'number' && realNm > 0 ? realNm : leg.distanceNm;
                                return (
                                    <div
                                        key={leg.legNumber}
                                        className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-2"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="w-9 h-9 rounded-full bg-sky-500/15 border border-sky-500/25 flex items-center justify-center shrink-0">
                                                <span className="text-[11px] font-black text-sky-300">
                                                    L{leg.legNumber}
                                                </span>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-bold text-white truncate">
                                                    {leg.departurePort} → {leg.arrivalPort}
                                                </p>
                                                <p className="text-[11px] text-gray-400 mt-0.5">
                                                    {[
                                                        displayNm > 0 ? `${displayNm.toFixed(0)} NM` : null,
                                                        leg.durationHours > 0
                                                            ? formatDuration(leg.durationHours)
                                                            : null,
                                                        leg.departureDateIso
                                                            ? `Depart ${formatDate(leg.departureDateIso)}`
                                                            : null,
                                                        leg.arrivalCountry,
                                                    ]
                                                        .filter(Boolean)
                                                        .join(' · ')}
                                                </p>
                                            </div>
                                        </div>
                                        {forecast && (
                                            <div className="flex flex-wrap gap-2 pt-2 border-t border-white/[0.05] text-[11px] text-gray-300">
                                                <span>
                                                    💨{' '}
                                                    <span className="font-mono font-bold text-white">
                                                        {forecast.windDirection} {forecast.windSpeedKt}
                                                    </span>
                                                    {forecast.windGustKt ? `/${forecast.windGustKt}` : ''} kt
                                                </span>
                                                {forecast.waveHeightM !== null && (
                                                    <span>
                                                        🌊{' '}
                                                        <span className="font-mono font-bold text-white">
                                                            {forecast.waveHeightM.toFixed(1)}
                                                        </span>{' '}
                                                        m
                                                    </span>
                                                )}
                                                <span className="capitalize">{forecast.condition}</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </Section>

                    {/* Country / visa snippets */}
                    {countrySnippets.length > 0 && (
                        <Section
                            title="Customs, Visas & Biosecurity"
                            subtitle="Per country detected on the route. Confirm with your agent + the consulate before departure."
                        >
                            <div className="space-y-2">
                                {countrySnippets.map((s) => (
                                    <div
                                        key={s.country}
                                        className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-1.5"
                                    >
                                        <p className="text-sm font-bold text-sky-300">{s.country}</p>
                                        <p className="text-[11px] text-gray-300">
                                            <span className="text-gray-500">Visa: </span>
                                            {s.visa}
                                        </p>
                                        <p className="text-[11px] text-amber-200/80">
                                            <span className="text-gray-500">Biosecurity: </span>
                                            {s.biosecurity}
                                        </p>
                                        <p className="text-[11px] text-gray-400">
                                            <span className="text-gray-500">Ports of entry: </span>
                                            {s.portsOfEntry}
                                        </p>
                                        {s.notes && <p className="text-[11px] text-gray-500 italic">{s.notes}</p>}
                                    </div>
                                ))}
                            </div>
                        </Section>
                    )}

                    {/* Hint about the rest */}
                    <Section title="Captain's Brief" subtitle="The PDF below includes the full preparation pack.">
                        <ul className="text-[11px] text-gray-400 space-y-1.5 list-none">
                            <Hint
                                glyph="🌬"
                                label="Best time to sail"
                                detail="Region-aware seasonal advice + weather window thresholds."
                            />
                            <Hint
                                glyph="👥"
                                label="Crew & watch schedules"
                                detail="Recommendations tuned to your crew count."
                            />
                            <Hint
                                glyph="🥫"
                                label="Provisioning"
                                detail="Pre-cook list + pantry powerhouses + stowage tips."
                            />
                            <Hint
                                glyph="🛠"
                                label="Vessel prep checklist"
                                detail="Rigging, sails, engine, deck, through-hulls."
                            />
                            <Hint
                                glyph="🛟"
                                label="Safety equipment"
                                detail="PFDs, life raft, EPIRB, flares, grab bag, comms."
                            />
                            <Hint
                                glyph="🏥"
                                label="Medical kit"
                                detail="OTC, prescription tier, tropical-specific add-ons."
                            />
                        </ul>
                    </Section>
                </div>

                {/* Toast */}
                {toast && (
                    <div className="px-4 py-2 text-center text-[11px] font-bold text-sky-300 border-t border-white/[0.06] animate-in fade-in shrink-0">
                        {toast}
                    </div>
                )}

                {/* Footer — Export PDF */}
                <div className="border-t border-white/[0.06] p-3 shrink-0">
                    <button
                        onClick={handleExportPdf}
                        disabled={exporting}
                        className="w-full py-3 rounded-xl bg-gradient-to-r from-sky-500 to-cyan-500 text-white text-sm font-black uppercase tracking-[0.15em] shadow-lg shadow-sky-500/20 hover:shadow-sky-500/40 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {exporting ? '⏳ Generating…' : '📄 Export Trip Plan as PDF'}
                    </button>
                    <p className="text-center text-[10px] text-gray-500 mt-2">
                        Suggested itinerary only — confirm pilotage on official charts before sailing.
                    </p>
                </div>
            </div>
        </div>
    );
};

const Stat: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
    <div className="text-center">
        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">{label}</p>
        <p className={`text-sm font-black tabular-nums mt-0.5 ${color}`}>{value}</p>
    </div>
);

const Section: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({
    title,
    subtitle,
    children,
}) => (
    <div className="space-y-2">
        <div className="px-1">
            <h3 className="text-[11px] font-bold text-sky-300 uppercase tracking-widest">{title}</h3>
            {subtitle && <p className="text-[11px] text-gray-500 leading-snug mt-0.5">{subtitle}</p>}
        </div>
        {children}
    </div>
);

const Hint: React.FC<{ glyph: string; label: string; detail: string }> = ({ glyph, label, detail }) => (
    <li className="flex items-start gap-2">
        <span className="text-base shrink-0 leading-none">{glyph}</span>
        <span className="leading-snug">
            <span className="text-white font-bold">{label}</span> · {detail}
        </span>
    </li>
);
