/**
 * FloatPlanSheet — review, format and share the shore-contact plan.
 *
 * The safety data remains plain text so it is searchable, copyable and useful
 * on a weak connection. Presentation adapts before sharing: compact ASCII for
 * SMS, native emphasis for WhatsApp, a full email brief, or neutral text for
 * any other app.
 */

import React, { useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
    createFloatPlanSharePayload,
    createFloatPlanShareUrl,
    floatPlanTimeZoneLabel,
    trackDistanceNM,
    validateFloatPlan,
    type FloatPlanChannel,
    type FloatPlanInput,
    type FloatPlanRoute,
} from '../../services/floatPlan';
import { loadSavedTraces } from '../../services/routeTracer';
import type { Voyage } from '../../services/VoyageService';
import { useSettingsStore } from '../../stores/settingsStore';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';
import {
    collapseGeneratedTraceEndpointPair,
    formatStoredPlannedRouteName,
} from '../../services/shiplog/plannedRouteNaming';
import { destNameFromRouteName, stripLegBadge } from '../../services/routeTracer';
import { vesselCrewAboard } from '../../services/units';

const log = createLogger('FloatPlanSheet');

const HOUR_MS = 3_600_000;
const DEFAULT_OVERDUE_BUFFER_H = 4;
const OVERDUE_FRACTION = 0.1;
const MIN_OVERDUE_BUFFER_MS = HOUR_MS;

export interface FloatPlanPreset {
    route: FloatPlanRoute;
    departureMs: number;
    etaMs?: number | null;
    personsOnBoard?: number;
}

interface FloatPlanSheetProps {
    /** Active/draft voyage source used by Cast Off. */
    voyage?: Voyage;
    /** Passage-planner source used before a Voyage row exists. */
    preset?: FloatPlanPreset;
    onClose: () => void;
}

interface TransferFailure {
    action: 'copy' | 'share';
    message: string;
}

const CHANNEL_OPTIONS: Array<{
    id: FloatPlanChannel;
    label: string;
    detail: string;
    accent: string;
}> = [
    { id: 'sms', label: 'Text', detail: 'Compact · ASCII', accent: 'sky' },
    { id: 'whatsapp', label: 'WhatsApp', detail: 'Bold · scannable', accent: 'emerald' },
    { id: 'email', label: 'Email', detail: 'Full detail', accent: 'amber' },
    { id: 'generic', label: 'More', detail: 'Any sharing app', accent: 'slate' },
];

function toLocalInput(ms: number): string {
    const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 16);
}

function channelIcon(channel: FloatPlanChannel): React.ReactNode {
    const common = 'h-5 w-5';
    if (channel === 'email') {
        return (
            <svg
                className={common}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5v10.5H3.75z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 7.5 7.5 5.25 7.5-5.25" />
            </svg>
        );
    }
    if (channel === 'generic') {
        return (
            <svg
                className={common}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
            >
                <circle cx="18" cy="5" r="2.25" />
                <circle cx="6" cy="12" r="2.25" />
                <circle cx="18" cy="19" r="2.25" />
                <path strokeLinecap="round" d="m8 11 7.8-4.6M8 13l7.8 4.6" />
            </svg>
        );
    }
    return (
        <svg
            className={common}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20.25 11.5a8.25 8.25 0 0 1-11.9 7.4L4 20l1.15-4.1A8.25 8.25 0 1 1 20.25 11.5Z"
            />
            {channel === 'whatsapp' ? (
                <path strokeLinecap="round" d="M9 8.25c.55 3.1 2.2 4.75 5.25 5.5" />
            ) : (
                <path strokeLinecap="round" d="M8.5 10.25h7M8.5 13.5h4.75" />
            )}
        </svg>
    );
}

function whatsappLine(line: string): React.ReactNode {
    if (!line) return <span aria-hidden="true">&nbsp;</span>;
    return line.split(/(\*[^*]+\*|_[^_]+_)/g).map((part, index) => {
        if (part.startsWith('*') && part.endsWith('*')) return <strong key={index}>{part.slice(1, -1)}</strong>;
        if (part.startsWith('_') && part.endsWith('_')) return <em key={index}>{part.slice(1, -1)}</em>;
        return <React.Fragment key={index}>{part.replace(/\\([*_~`])/g, '$1')}</React.Fragment>;
    });
}

function FloatPlanPreview({ channel, title, text }: { channel: FloatPlanChannel; title: string; text: string }) {
    const lines = text.split('\n');

    if (channel === 'email') {
        return (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 text-slate-900 shadow-xl shadow-black/20">
                <div className="border-b border-slate-200 bg-white px-4 py-3">
                    <div className="mb-2 flex gap-1.5" aria-hidden="true">
                        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                    </div>
                    <p className="text-xs font-semibold text-slate-500">Subject</p>
                    <p className="mt-0.5 text-sm font-bold leading-snug text-slate-900">{title}</p>
                </div>
                <div className="whitespace-pre-wrap px-4 py-4 font-sans text-[13px] leading-relaxed">{text}</div>
            </div>
        );
    }

    if (channel === 'whatsapp') {
        return (
            <div className="rounded-2xl border border-emerald-500/20 bg-[#0b141a] p-3 shadow-xl shadow-black/20">
                <div className="ml-auto max-w-[95%] rounded-2xl rounded-tr-sm bg-[#005c4b] px-3.5 py-3 text-[13px] leading-relaxed text-white shadow-md">
                    {lines.map((line, index) => (
                        <div key={index}>{whatsappLine(line)}</div>
                    ))}
                </div>
            </div>
        );
    }

    if (channel === 'sms') {
        return (
            <div className="rounded-2xl border border-sky-500/20 bg-slate-950 p-3 shadow-xl shadow-black/20">
                <div className="ml-auto max-w-[96%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-600 px-3.5 py-3 font-sans text-[13px] leading-relaxed text-white shadow-md">
                    {text}
                </div>
            </div>
        );
    }

    return (
        <div className="whitespace-pre-wrap rounded-2xl border border-white/10 bg-slate-950 px-4 py-4 font-sans text-[13px] leading-relaxed text-slate-200 shadow-xl shadow-black/20">
            {text}
        </div>
    );
}

export const FloatPlanSheet: React.FC<FloatPlanSheetProps> = ({ voyage, preset, onClose }) => {
    const vessel = useSettingsStore((state) => state.settings.vessel);
    const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

    const departureMs = useMemo(() => {
        if (preset) return preset.departureMs;
        const value = voyage?.departure_time ? new Date(voyage.departure_time).getTime() : Number.NaN;
        return Number.isFinite(value) ? value : Date.now();
    }, [preset, voyage?.departure_time]);

    const etaMs = useMemo(() => {
        if (preset) return Number.isFinite(preset.etaMs) ? Number(preset.etaMs) : null;
        const value = voyage?.eta ? new Date(voyage.eta).getTime() : Number.NaN;
        return Number.isFinite(value) ? value : null;
    }, [preset, voyage?.eta]);

    const passageMs = etaMs && etaMs > departureMs ? etaMs - departureMs : null;
    const overdueBufferMs = passageMs
        ? Math.max(MIN_OVERDUE_BUFFER_MS, passageMs * OVERDUE_FRACTION)
        : DEFAULT_OVERDUE_BUFFER_H * HOUR_MS;
    const [overdueMs, setOverdueMs] = useState<number>(() => (etaMs ?? departureMs) + overdueBufferMs);
    const [whoToCall, setWhoToCall] = useState('');
    const [contactAboard, setContactAboard] = useState(() => vessel?.contactPhone?.trim() || '');
    const [personsOnBoard, setPersonsOnBoard] = useState<number>(
        () => preset?.personsOnBoard || voyage?.crew_count || vesselCrewAboard(vessel),
    );
    // USCG-style persons roster (2026-08-26): names beat a bare count when a
    // coordinator decides what to send. Optional — empty rows are dropped.
    const [personsRoster, setPersonsRoster] = useState<Array<{ name: string; note: string }>>([]);
    const [provisionsDays, setProvisionsDays] = useState<number>(0);
    const [channel, setChannel] = useState<FloatPlanChannel>('whatsapp');
    const [sharedChannel, setSharedChannel] = useState<FloatPlanChannel | null>(null);
    const [copied, setCopied] = useState(false);
    const [transferFailure, setTransferFailure] = useState<TransferFailure | null>(null);

    const savedWaypoints = useMemo(() => {
        if (preset?.route.waypoints) return preset.route.waypoints;
        if (!voyage?.saved_route_id) return undefined;
        try {
            const trace = loadSavedTraces().find((item) => item.id === voyage.saved_route_id);
            return trace?.points.map((point) => ({ lat: point.lat, lon: point.lon }));
        } catch {
            return undefined;
        }
    }, [preset, voyage?.saved_route_id]);

    const route = useMemo<FloatPlanRoute>(() => {
        if (preset) return { ...preset.route, waypoints: preset.route.waypoints ?? savedWaypoints };
        // Legacy voyage rows can carry the generated "<title> — start/end"
        // pair in name and both ports (Shane 2026-08-26: the float plan
        // repeated the artefact). Collapse at display time; real endpoints
        // pass through untouched.
        const collapsed = collapseGeneratedTraceEndpointPair(voyage?.departure_port, voyage?.destination_port);
        const collapsedBase = collapsed ? stripLegBadge(collapsed) : null;
        const collapsedDest = collapsed ? destNameFromRouteName(collapsed) : null;
        return {
            name: formatStoredPlannedRouteName(voyage?.voyage_name) ?? voyage?.voyage_name,
            from: collapsed
                ? collapsedDest && collapsedBase
                    ? collapsedBase.slice(0, collapsedBase.length - collapsedDest.length).replace(/[\s—–-]+$/, '')
                    : collapsed
                : (voyage?.departure_port ?? undefined),
            to: collapsed ? (collapsedDest ?? undefined) : (voyage?.destination_port ?? undefined),
            distanceNM: savedWaypoints && savedWaypoints.length >= 2 ? trackDistanceNM(savedWaypoints) : undefined,
            waypoints: savedWaypoints,
        };
    }, [preset, voyage?.voyage_name, voyage?.departure_port, voyage?.destination_port, savedWaypoints]);

    const input = useMemo<FloatPlanInput>(
        () => ({
            vessel,
            route,
            departureMs,
            etaMs,
            overdueMs,
            personsOnBoard,
            personsRoster: personsRoster.filter((person) => person.name.trim().length > 0),
            provisionsDays: provisionsDays > 0 ? provisionsDays : undefined,
            whoToCall: whoToCall.trim() || undefined,
            contactAboard: contactAboard.trim() || undefined,
            timeZone,
        }),
        [
            vessel,
            route,
            departureMs,
            etaMs,
            overdueMs,
            personsOnBoard,
            personsRoster,
            provisionsDays,
            whoToCall,
            contactAboard,
            timeZone,
        ],
    );

    const payload = useMemo(() => createFloatPlanSharePayload(input, channel), [input, channel]);
    const validation = useMemo(() => validateFloatPlan(input), [input]);
    const canShare = validation.errors.length === 0;
    const platform = Capacitor.getPlatform();
    const shareUrl = createFloatPlanShareUrl(payload, platform === 'ios' || platform === 'android' ? platform : 'web');

    const safetyGear: { label: string; value: string | null }[] = [
        { label: 'EPIRB', value: vessel?.epirbHexId ? `Hex ${vessel.epirbHexId}` : null },
        { label: 'Liferaft', value: vessel?.liferaftCapacity ? `${vessel.liferaftCapacity} person` : null },
        { label: 'Flares', value: vessel?.flaresExpiry ? `Expires ${vessel.flaresExpiry}` : null },
        { label: 'Other', value: vessel?.safetyNotes?.trim() || null },
    ];
    const missingGear = safetyGear.filter((item) => !item.value && item.label !== 'Other');

    const copyPlan = async () => {
        if (!canShare) return;
        triggerHaptic('light');
        setTransferFailure(null);
        setCopied(false);
        try {
            await navigator.clipboard.writeText(payload.text);
            setCopied(true);
        } catch (error) {
            log.warn('float plan copy failed', error);
            setTransferFailure({
                action: 'copy',
                message: 'Copy failed. Try again, or select the plan text below and copy it manually.',
            });
        }
    };

    const shareMore = async () => {
        if (!canShare) return;
        triggerHaptic('medium');
        setTransferFailure(null);
        try {
            const { Share } = await import('@capacitor/share');
            await Share.share({
                title: payload.title,
                text: payload.text,
                dialogTitle: 'Share formatted float plan',
            });
            setSharedChannel(channel);
        } catch (error) {
            // A dismissed native share sheet rejects too; do not claim delivery.
            log.warn('float plan share dismissed or failed', error);
            setTransferFailure({
                action: 'share',
                message: 'Sharing was not completed. Try again, or select the plan text below and copy it manually.',
            });
        }
    };

    const routeFrom = route.from?.trim() || 'Departure';
    const routeTo = route.to?.trim() || 'Destination';
    const distance =
        route.distanceNM || (savedWaypoints && savedWaypoints.length >= 2 ? trackDistanceNM(savedWaypoints) : null);
    const channelLabel = CHANNEL_OPTIONS.find((option) => option.id === channel)?.label || 'Share';
    const directAction = channel === 'email' ? 'Compose email' : channel === 'sms' ? 'Open Messages' : 'Open WhatsApp';

    return (
        <section className="space-y-4" data-testid="float-plan-sheet" aria-label="Float plan sharing">
            <div className="relative overflow-hidden rounded-2xl border border-sky-500/20 bg-gradient-to-br from-slate-900 via-slate-900 to-sky-950/80 p-4 shadow-xl shadow-black/20">
                <div
                    className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-sky-400/10 blur-2xl"
                    aria-hidden="true"
                />
                <div className="relative flex items-start justify-between gap-3">
                    <div>
                        <div className="mb-1 flex items-center gap-2">
                            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300">
                                <svg
                                    className="h-5 w-5"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M12 3 5.5 5.75v5.5c0 4.1 2.7 7.75 6.5 9.25 3.8-1.5 6.5-5.15 6.5-9.25v-5.5L12 3Z"
                                    />
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="m9.25 11.75 1.75 1.75 3.75-4"
                                    />
                                </svg>
                            </span>
                            <div>
                                <p className="text-xs font-black uppercase tracking-[0.16em] text-sky-300">
                                    Float plan
                                </p>
                                <p className="text-xs text-slate-400">Sensitive shore-contact handoff</p>
                            </div>
                        </div>
                        <h3 className="mt-3 text-lg font-black text-white">
                            {vessel?.name?.trim() || 'Unnamed vessel'}
                        </h3>
                    </div>
                    <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-200">
                        Check audience
                    </span>
                </div>

                <div className="relative mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
                    <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">From</p>
                        <p className="truncate text-sm font-bold text-white">{routeFrom}</p>
                    </div>
                    <svg
                        className="h-5 w-5 text-sky-400"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" d="M4 12h15M14 7l5 5-5 5" />
                    </svg>
                    <div className="min-w-0 text-right">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">To</p>
                        <p className="truncate text-sm font-bold text-white">{routeTo}</p>
                    </div>
                </div>

                <div className="relative mt-3 flex flex-wrap gap-2 text-xs font-semibold text-slate-300">
                    {distance && distance > 0 && (
                        <span className="rounded-lg bg-white/5 px-2.5 py-1.5">{distance.toFixed(0)} NM</span>
                    )}
                    <span className="rounded-lg bg-white/5 px-2.5 py-1.5">{personsOnBoard || 0} aboard</span>
                    <span className="rounded-lg bg-white/5 px-2.5 py-1.5">
                        {floatPlanTimeZoneLabel(overdueMs, timeZone)}
                    </span>
                </div>
            </div>

            <div className="rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/[0.12] to-red-500/[0.05] p-4 shadow-lg shadow-amber-950/10">
                <div className="mb-3 flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-400/15 text-amber-300">
                        <svg
                            className="h-5 w-5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.9}
                            aria-hidden="true"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 8v4.25m0 3.25h.01M10.3 4.7 2.9 17.5a1.5 1.5 0 0 0 1.3 2.25h15.6a1.5 1.5 0 0 0 1.3-2.25L13.7 4.7a1.96 1.96 0 0 0-3.4 0Z"
                            />
                        </svg>
                    </span>
                    <div>
                        <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-300">Raise the alarm</p>
                        <p className="mt-0.5 text-sm font-semibold leading-snug text-white">
                            If your shore contact has not heard from you by this time
                        </p>
                    </div>
                </div>
                <label htmlFor="float-overdue" className="mb-1.5 block text-xs font-bold text-amber-100">
                    No contact by
                </label>
                <input
                    id="float-overdue"
                    type="datetime-local"
                    value={toLocalInput(overdueMs)}
                    onChange={(event) => {
                        const value = new Date(event.target.value).getTime();
                        if (Number.isFinite(value)) setOverdueMs(value);
                    }}
                    className="min-h-11 w-full rounded-xl border border-amber-300/20 bg-black/30 px-3 py-2.5 text-sm font-bold text-white outline-none [color-scheme:dark] focus:border-amber-300"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-amber-100/70">
                    {passageMs
                        ? `Suggested buffer: ${(overdueBufferMs / HOUR_MS).toFixed(1).replace(/\.0$/, '')} h after ETA (10% of passage time).`
                        : `Suggested buffer: ${DEFAULT_OVERDUE_BUFFER_H} hours after departure because no ETA is set.`}
                </p>

                <label htmlFor="float-who" className="mb-1.5 mt-3 block text-xs font-bold text-amber-100">
                    Rescue contact and phone number <span aria-hidden="true">*</span>
                </label>
                <input
                    id="float-who"
                    type="text"
                    value={whoToCall}
                    onChange={(event) => setWhoToCall(event.target.value)}
                    placeholder="Marine Rescue Bundaberg · 07 4159 4600"
                    aria-describedby="float-who-help"
                    required
                    className="min-h-11 w-full rounded-xl border border-amber-300/20 bg-black/30 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-amber-300"
                />
                <p id="float-who-help" className="mt-1.5 text-[11px] leading-relaxed text-amber-100/70">
                    Enter the exact local number to call, for example “Marine Rescue Bundaberg · 07 4159 4600” or “Call
                    000 and ask for Water Police”. This is required before sharing.
                </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div>
                    <label htmlFor="float-contact-aboard" className="mb-1.5 block text-xs font-bold text-slate-300">
                        How can they reach you?
                    </label>
                    <input
                        id="float-contact-aboard"
                        type="text"
                        value={contactAboard}
                        onChange={(event) => setContactAboard(event.target.value)}
                        placeholder="VHF 16 · sat phone · mobile"
                        className="min-h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-sky-400"
                    />
                </div>
                <div>
                    <span className="mb-1.5 block text-xs font-bold text-slate-300">People aboard</span>
                    <div className="flex h-11 items-center rounded-xl border border-white/10 bg-white/5">
                        <button
                            type="button"
                            aria-label="Remove one person aboard"
                            onClick={() => setPersonsOnBoard((value) => Math.max(0, value - 1))}
                            className="flex h-11 w-11 items-center justify-center rounded-l-xl text-xl font-light text-slate-300 hover:bg-white/5 active:bg-white/10"
                        >
                            −
                        </button>
                        <output
                            className="min-w-10 px-2 text-center text-base font-black text-white"
                            aria-live="polite"
                        >
                            {personsOnBoard}
                        </output>
                        <button
                            type="button"
                            aria-label="Add one person aboard"
                            onClick={() => setPersonsOnBoard((value) => Math.min(99, value + 1))}
                            className="flex h-11 w-11 items-center justify-center rounded-r-xl text-xl font-light text-slate-300 hover:bg-white/5 active:bg-white/10"
                        >
                            +
                        </button>
                    </div>
                </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4" data-testid="float-plan-roster">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-300">Persons onboard</p>
                    <span className="text-[11px] font-semibold text-slate-500">Names help a coordinator</span>
                </div>
                <div className="space-y-2">
                    {personsRoster.map((person, index) => (
                        <div key={index} className="flex items-center gap-2">
                            <input
                                type="text"
                                aria-label={`Person ${index + 1} name`}
                                value={person.name}
                                onChange={(event) =>
                                    setPersonsRoster((rows) =>
                                        rows.map((row, i) =>
                                            i === index ? { ...row, name: event.target.value } : row,
                                        ),
                                    )
                                }
                                placeholder="Name"
                                className="min-h-11 w-1/2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-sky-400"
                            />
                            <input
                                type="text"
                                aria-label={`Person ${index + 1} note`}
                                value={person.note}
                                onChange={(event) =>
                                    setPersonsRoster((rows) =>
                                        rows.map((row, i) =>
                                            i === index ? { ...row, note: event.target.value } : row,
                                        ),
                                    )
                                }
                                placeholder="Role · age · medical"
                                className="min-h-11 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-sky-400"
                            />
                            <button
                                type="button"
                                aria-label={`Remove person ${index + 1}`}
                                onClick={() => setPersonsRoster((rows) => rows.filter((_, i) => i !== index))}
                                className="flex h-11 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-white/5"
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={() => setPersonsRoster((rows) => [...rows, { name: '', note: '' }])}
                        className="min-h-11 w-full rounded-xl border border-dashed border-white/15 text-sm font-semibold text-slate-300 hover:bg-white/5"
                    >
                        + Add person
                    </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                    <label htmlFor="float-provisions-days" className="text-xs font-bold text-slate-300">
                        Food &amp; water aboard (days)
                    </label>
                    <input
                        id="float-provisions-days"
                        type="text"
                        inputMode="numeric"
                        value={provisionsDays > 0 ? String(provisionsDays) : ''}
                        onChange={(event) => {
                            const parsed = parseInt(event.target.value.replace(/\D/g, ''), 10);
                            setProvisionsDays(Number.isFinite(parsed) ? Math.min(365, parsed) : 0);
                        }}
                        placeholder="—"
                        className="min-h-11 w-20 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-center text-sm text-white outline-none placeholder:text-slate-500 focus:border-sky-400"
                    />
                </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4" data-testid="float-plan-safety">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-300">
                        Safety details included
                    </p>
                    <span className="text-[11px] font-semibold text-slate-500">From Vessel settings</span>
                </div>
                <div className="flex flex-wrap gap-2">
                    {safetyGear
                        .filter((item) => item.value)
                        .map((item) => (
                            <span
                                key={item.label}
                                className="rounded-lg border border-emerald-400/15 bg-emerald-400/[0.08] px-2.5 py-1.5 text-[11px] leading-snug text-emerald-100"
                            >
                                <strong>{item.label}</strong> · {item.value}
                            </span>
                        ))}
                    {safetyGear.every((item) => !item.value) && (
                        <p className="text-xs text-slate-400">No safety equipment has been recorded yet.</p>
                    )}
                </div>
                {missingGear.length > 0 && (
                    <p className="mt-2 text-[11px] leading-relaxed text-amber-300">
                        Missing {missingGear.map((item) => item.label).join(' and ')} — add these under Settings →
                        Vessel → Safety.
                    </p>
                )}
            </div>

            {validation.errors.length > 0 && (
                <div className="rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-3" role="alert">
                    <p className="text-xs font-black uppercase tracking-wide text-red-300">
                        Finish these before sharing
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-red-100">
                        {validation.errors.map((error) => (
                            <li key={error}>{error}</li>
                        ))}
                    </ul>
                </div>
            )}

            {validation.warnings.length > 0 && (
                <div
                    className="rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-3 py-3"
                    role="status"
                    aria-label="Float plan safety warnings"
                >
                    <p className="text-xs font-black uppercase tracking-wide text-amber-300">
                        Check these safety details
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-amber-100">
                        {validation.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                        ))}
                    </ul>
                </div>
            )}

            <div>
                <div className="mb-2 flex items-end justify-between gap-2">
                    <div>
                        <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-300">Format for</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                            The preview and wording change with the channel.
                        </p>
                    </div>
                    {payload.smsSegments && (
                        <span className="text-[11px] font-semibold text-sky-300">
                            ≈ {payload.smsSegments} SMS parts
                        </span>
                    )}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Float plan format">
                    {CHANNEL_OPTIONS.map((option) => {
                        const active = channel === option.id;
                        const activeClass =
                            option.accent === 'emerald'
                                ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200'
                                : option.accent === 'amber'
                                  ? 'border-amber-400/50 bg-amber-400/10 text-amber-200'
                                  : option.accent === 'sky'
                                    ? 'border-sky-400/50 bg-sky-400/10 text-sky-200'
                                    : 'border-slate-300/30 bg-white/10 text-white';
                        return (
                            <button
                                key={option.id}
                                type="button"
                                aria-pressed={active}
                                onClick={() => {
                                    triggerHaptic('light');
                                    setChannel(option.id);
                                    setCopied(false);
                                    setTransferFailure(null);
                                }}
                                className={`min-h-[58px] rounded-xl border px-3 py-2.5 text-left transition active:scale-[0.98] ${active ? activeClass : 'border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.06]'}`}
                            >
                                <span className="flex items-center gap-2">
                                    {channelIcon(option.id)}
                                    <span>
                                        <span className="block text-xs font-black text-current">{option.label}</span>
                                        <span className="mt-0.5 block text-[11px] leading-tight opacity-70">
                                            {option.detail}
                                        </span>
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div data-testid="float-plan-preview">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-300">
                        {channelLabel} preview
                    </p>
                    <span className="text-[11px] tabular-nums text-slate-500">{payload.characterCount} characters</span>
                </div>
                <FloatPlanPreview channel={channel} title={payload.title} text={payload.text} />
            </div>

            <div className="rounded-xl border border-sky-400/15 bg-sky-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-sky-100/80">
                Ask your shore contact to reply <strong className="text-white">RECEIVED</strong>. Opening a share app
                does not confirm delivery.
            </div>

            {transferFailure && (
                <div
                    className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-3"
                    role="alert"
                    aria-live="assertive"
                    data-testid="float-plan-transfer-failure"
                >
                    <p className="text-xs font-bold leading-relaxed text-red-100">{transferFailure.message}</p>
                    <button
                        type="button"
                        onClick={transferFailure.action === 'copy' ? copyPlan : shareMore}
                        className="mt-2 min-h-11 rounded-lg border border-red-300/30 bg-red-300/10 px-3 text-xs font-black uppercase tracking-wide text-red-100"
                    >
                        {transferFailure.action === 'copy' ? 'Retry copy' : 'Retry sharing'}
                    </button>
                    <label
                        htmlFor="float-plan-manual-copy"
                        className="mb-1.5 mt-3 block text-[11px] font-bold text-red-100"
                    >
                        Manual copy fallback
                    </label>
                    <textarea
                        id="float-plan-manual-copy"
                        readOnly
                        value={payload.text}
                        onFocus={(event) => event.currentTarget.select()}
                        rows={8}
                        className="w-full resize-y rounded-lg border border-red-200/20 bg-black/30 p-2 font-mono text-xs leading-relaxed text-white outline-none focus:border-red-200/50"
                    />
                </div>
            )}

            <div className="grid grid-cols-[auto_1fr] gap-2 border-t border-white/[0.06] pt-1">
                <button
                    type="button"
                    onClick={copyPlan}
                    disabled={!canShare}
                    className="min-h-12 rounded-xl border border-white/10 bg-white/5 px-4 text-xs font-black uppercase tracking-wide text-slate-200 transition hover:bg-white/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35"
                >
                    {copied ? 'Copied ✓' : 'Copy'}
                </button>
                {channel === 'generic' ? (
                    <button
                        type="button"
                        onClick={shareMore}
                        disabled={!canShare}
                        className="min-h-12 rounded-xl bg-gradient-to-r from-sky-500 to-cyan-400 px-4 text-xs font-black uppercase tracking-[0.1em] text-slate-950 shadow-lg shadow-sky-500/20 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        Share formatted plan
                    </button>
                ) : (
                    <a
                        href={canShare && shareUrl ? shareUrl : undefined}
                        target={channel === 'whatsapp' && !Capacitor.isNativePlatform() ? '_blank' : undefined}
                        rel={channel === 'whatsapp' ? 'noopener noreferrer' : undefined}
                        aria-disabled={!canShare}
                        onClick={(event) => {
                            if (!canShare || !shareUrl) {
                                event.preventDefault();
                                return;
                            }
                            triggerHaptic('medium');
                            setSharedChannel(channel);
                        }}
                        className={`flex min-h-12 items-center justify-center rounded-xl px-4 text-xs font-black uppercase tracking-[0.1em] shadow-lg transition active:scale-[0.98] ${canShare ? 'bg-gradient-to-r from-sky-500 to-cyan-400 text-slate-950 shadow-sky-500/20' : 'pointer-events-none bg-white/10 text-slate-500 shadow-none'}`}
                    >
                        {directAction}
                    </a>
                )}
            </div>

            <div className="flex min-h-11 items-center justify-between gap-3">
                <button
                    type="button"
                    onClick={onClose}
                    className="min-h-11 px-2 text-xs font-bold text-slate-400 hover:text-white"
                >
                    {sharedChannel ? 'Done' : 'Cancel'}
                </button>
                <p className="text-right text-[11px] text-slate-500" aria-live="polite">
                    {sharedChannel
                        ? `Opened ${CHANNEL_OPTIONS.find((item) => item.id === sharedChannel)?.label ?? 'sharing'} · awaiting RECEIVED`
                        : channel === 'generic'
                          ? 'Thalassa does not upload this plan. Verify recipients and audience in the destination app.'
                          : 'Thalassa does not upload this plan. Verify the recipient before sending.'}
                </p>
            </div>
        </section>
    );
};
