/**
 * The quick log, built for a thumb under way (Shane 2026-10-05: "go with your
 * picks, call it sightings").
 *
 *   1. "What did you see?" Eight big group tiles. ONE TAP LOGS: the tile
 *      saves the sighting on this phone at once, timed when the sheet opened,
 *      with whatever position and context have arrived (a later fix is
 *      attached; with none after 60 s it waits as 'needs position' and is
 *      never sent without one).
 *   2. "Whale logged". Everything after the tap edits the saved sighting:
 *      the keep-your-distance card for whales and dolphins, likely species
 *      (or the full list), how many, a calf, a photo, who sees it. Done sends
 *      it (when it can). The top-right corner, where a thumb goes to dismiss,
 *      SAVES and closes here too; Undo sits in the footer beside Done, so a
 *      reflex tap in a seaway never throws the whale away.
 *
 * No toasts (Shane hates them): the sheet confirms in place. The position is
 * the boat's GPS chain; when a boat is set up but none of its receivers
 * answers, an amber line says, BEFORE the tap, that the phone will stand in
 * and the sighting will be marked as phone GPS.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { distanceCardFor } from '../../services/sightings/approachRules';
import { isCoarsePublic, likelyFirst, loadCatalogue, type SightingCatalogue } from '../../services/sightings/catalogue';
import {
    captureSightingContext,
    type CloudOwner,
    type SightingContext,
} from '../../services/sightings/sightingContext';
import {
    attachSightingContext,
    awaitSightingPosition,
    chooseDefaultVisibility,
    chooseSightingVessel,
    cloudOwnerFor,
    deleteSighting,
    editSighting,
    loadVisibilityChoice,
    logSighting,
    rememberVisibilityChoice,
    setSightingDisplayName,
} from '../../services/sightings/sightingService';
import { getLocalSighting } from '../../services/sightings/sightingStore';
import { scheduleSightingDrain } from '../../services/sightings/sightingSync';
import {
    SIGHTING_GROUPS,
    SIGHTING_GROUP_LABELS,
    SIGHTING_LIMITS,
    type LocalSighting,
    type SightingGroup,
    type SightingRow,
    type SightingVisibility,
} from '../../services/sightings/types';
import { useSightingsSession, type SightingsSession } from '../../hooks/sightings/useSightingsSession';
import { KeepYourDistanceCard } from './KeepYourDistanceCard';
import { SightingsSheet } from './SightingsSheet';
import { GroupChip, SightingIcon } from './SightingGlyphs';
import { SpeciesPicker, rememberRecentSpecies } from './SpeciesPicker';
import { VisibilityPicker } from './VisibilityPicker';
import { CALF_GROUPS, CalfAndPhotos, CountStepper } from './RefineControls';
import { compassPoint, forecastCredit, formatClock, formatPosition, POSITION_SOURCE_LABEL } from './sightingsFormat';

export interface QuickLogDeps {
    /** `vesselOwner` names the boat whose cloud row may stand in (asked when that lane is reached). */
    captureContext: (vesselOwner?: () => Promise<CloudOwner>) => Promise<SightingContext>;
    loadCatalogue: () => Promise<SightingCatalogue | null>;
    /** This phone's recording voyage and its boat, or null when not recording. */
    resolveRecording: () => Promise<{ voyageId: string | null; boatId: string | null } | null>;
    /** The name crew see on the byline. */
    observerDisplay: () => Promise<string | null>;
}

async function defaultRecording() {
    try {
        const { ShipLogService } = await import('../../services/ShipLogService');
        const voyageId = (await ShipLogService.resolveActiveVoyageId()) ?? null;
        if (!voyageId) return null;
        return { voyageId, boatId: (await ShipLogService.resolveActiveBoatId()) ?? null };
    } catch {
        return null;
    }
}

async function defaultObserverDisplay(): Promise<string | null> {
    try {
        const { useAuthStore } = await import('../../stores/authStore');
        const name = useAuthStore.getState().user?.user_metadata?.display_name;
        return typeof name === 'string' && name.trim()
            ? name.trim().slice(0, SIGHTING_LIMITS.observerDisplayMax)
            : null;
    } catch {
        return null;
    }
}

const DEFAULT_DEPS: QuickLogDeps = {
    captureContext: (vesselOwner) => captureSightingContext(undefined, { vesselOwner }),
    loadCatalogue: () => loadCatalogue(),
    resolveRecording: defaultRecording,
    observerDisplay: defaultObserverDisplay,
};

/** Who a Crew sighting reaches, in words. */
export function crewAudience(session: SightingsSession, vesselOwnerId: string | null): string {
    if (!vesselOwnerId) return 'nobody yet';
    if (vesselOwnerId === session.userId) {
        const name = session.ownBoatName ? `the ${session.ownBoatName}` : 'your boat';
        const n = session.ownCrewCount ?? 0;
        return n > 0 ? `you and your ${n} crew on ${name}` : `anyone you add as crew on ${name}`;
    }
    const boat = session.crewVessels.find((v) => v.ownerId === vesselOwnerId);
    return `the skipper and crew of ${boat?.vesselName ? `the ${boat.vesselName}` : 'that boat'}`;
}

/** "Sea 24.1 °C", "Depth 18 m", "Wind 14 kn SE", "Waves 1.2 m", "6.2 kn · 042°". */
export function contextChips(row: SightingRow): string[] {
    const chips: string[] = [];
    if (row.sea_temp_c !== null) chips.push(`Sea ${row.sea_temp_c.toFixed(1)} °C`);
    if (row.water_depth_m !== null) chips.push(`Depth ${Math.round(row.water_depth_m * 10) / 10} m`);
    if (row.wind_speed_kts !== null) {
        chips.push(`Wind ${Math.round(row.wind_speed_kts)} kn ${compassPoint(row.wind_dir_deg)}`.trim());
    }
    if (row.wave_height_m !== null) chips.push(`Waves ${row.wave_height_m.toFixed(1)} m`);
    if (row.sog_kts !== null) {
        const cog = row.cog_deg !== null ? ` · ${String(Math.round(row.cog_deg)).padStart(3, '0')}°` : '';
        chips.push(`${row.sog_kts.toFixed(1)} kn${cog}`);
    }
    return chips;
}

/** "Wind and waves from the forecast. Forecast data: ECMWF" (the CC-BY credit), or null when none is. */
export function forecastNote(row: SightingRow): string | null {
    const fields = [
        row.sea_temp_c !== null && row.sea_temp_source === 'forecast' ? 'sea temperature' : null,
        row.wind_speed_kts !== null && row.wind_source === 'forecast' ? 'wind' : null,
        row.wave_height_m !== null ? 'waves' : null,
    ].filter((f): f is string => !!f);
    if (fields.length === 0) return null;
    const list = fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}` : fields[0];
    return `${list[0].toUpperCase()}${list.slice(1)} from the forecast. ${forecastCredit(row.wx_model)}`;
}

const PositionLine: React.FC<{ context: SightingContext | null; pending: boolean }> = ({ context, pending }) => {
    if (pending || !context) {
        return (
            <p className="mt-1 flex min-h-[32px] items-center gap-1.5 text-[13px] font-semibold sg-muted" role="status">
                <SightingIcon name="pin" className="h-3.5 w-3.5" />
                Finding the boat’s position…
            </p>
        );
    }
    const p = context.position;
    if (context.boatSilent) {
        return (
            <p className="sg-amber mt-2 px-3 py-2 text-[13px] leading-snug" role="status">
                <b className="sg-amber-strong">Boat GPS isn’t answering.</b>{' '}
                {p
                    ? 'A tap now logs with this phone’s position, marked as phone GPS.'
                    : 'A tap still logs it; it waits on this phone for a position before it is sent.'}
            </p>
        );
    }
    if (!p) {
        return (
            <p className="sg-amber mt-2 px-3 py-2 text-[13px] leading-snug" role="status">
                <b className="sg-amber-strong">No position yet.</b> A tap still logs it; it waits on this phone for a
                position before it is sent.
            </p>
        );
    }
    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="status">
            <span
                className="sg-toggle inline-flex min-h-[32px] items-center gap-1 rounded-full px-2.5 text-[12.5px] font-bold"
                data-on="true"
            >
                <SightingIcon name="pin" className="h-3.5 w-3.5" />
                {p.ashore ? 'Ashore · phone GPS' : POSITION_SOURCE_LABEL[p.source]}
            </span>
            <span className="sg-toggle inline-flex min-h-[32px] items-center rounded-full px-2.5 text-[12.5px] font-bold tabular-nums">
                {formatPosition(p.latitude, p.longitude)}
            </span>
        </div>
    );
};

export interface QuickLogSheetProps {
    /** Epoch ms of the tap that opened the sheet: the sighting's time. */
    openedAt: number;
    onClose: () => void;
    onLogged?: (id: string) => void;
    deps?: Partial<QuickLogDeps>;
}

export const QuickLogSheet: React.FC<QuickLogSheetProps> = ({ openedAt, onClose, onLogged, deps: depsIn }) => {
    const deps = useMemo(() => ({ ...DEFAULT_DEPS, ...depsIn }), [depsIn]);
    const session = useSightingsSession();
    const signedIn = !!session.userId;
    // The latest session, for the owner question the context capture asks later.
    const sessionRef = useRef(session);
    sessionRef.current = session;

    const contextPromise = useRef<Promise<SightingContext> | null>(null);
    const [context, setContext] = useState<SightingContext | null>(null);
    const [contextPending, setContextPending] = useState(true);
    const [catalogue, setCatalogue] = useState<SightingCatalogue | null>(null);
    const recording = useRef<Promise<{ voyageId: string | null; boatId: string | null } | null> | null>(null);
    const [choices, setChoices] = useState<Partial<Record<SightingGroup, SightingVisibility | null>>>({});

    const [record, setRecord] = useState<LocalSighting | null>(null);
    const [busy, setBusy] = useState(false);
    const [positionState, setPositionState] = useState<'pending' | 'attached' | 'needs-position'>('pending');
    const [picking, setPicking] = useState(false);
    const firstTile = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        let live = true;
        recording.current = deps.resolveRecording();
        // Whose boat's cloud row may stand in: the boat this sighting will be
        // logged against, decided as the tap will decide it.
        const expectedOwner = async (): Promise<CloudOwner> => {
            const rec = await (recording.current ?? Promise.resolve(null)).catch(() => null);
            const s = sessionRef.current;
            const vessel = chooseSightingVessel({
                userId: s.userId,
                ashore: false,
                recording: rec,
                ownActiveVesselId: s.ownBoatId,
                crewingOwnerId: s.crewing?.ownerId ?? null,
                lastChoice: null,
            });
            return cloudOwnerFor(vessel.vesselOwnerId, s.userId);
        };
        const promise = deps.captureContext(expectedOwner);
        contextPromise.current = promise;
        void promise
            .then((c) => live && setContext(c))
            .catch(() => undefined)
            .finally(() => live && setContextPending(false));
        void deps.loadCatalogue().then((c) => live && setCatalogue(c));
        void Promise.all(SIGHTING_GROUPS.map((g) => loadVisibilityChoice(g).then((v) => [g, v] as const))).then(
            (pairs) => live && setChoices(Object.fromEntries(pairs)),
        );
        return () => {
            live = false;
        };
        // Once per opening.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const refresh = useCallback(
        async (id: string) => {
            const fresh = await getLocalSighting(id, session.userId);
            if (fresh) setRecord(fresh);
        },
        [session.userId],
    );

    const log = async (group: SightingGroup) => {
        if (busy || record) return;
        setBusy(true);
        try {
            void import('../../utils/system').then((m) => m.triggerHaptic('medium')).catch(() => undefined);
            let ctx = context;
            const rec = await (recording.current ?? Promise.resolve(null));
            const vessel = chooseSightingVessel({
                userId: session.userId,
                ashore: ctx?.position?.ashore === true,
                recording: rec,
                ownActiveVesselId: session.ownBoatId,
                crewingOwnerId: session.crewing?.ownerId ?? null,
                lastChoice: null,
            });
            // A cloud fix from another boat's row (the session changed under
            // the sheet) is not this boat's position: ask again for the right one.
            const wanted = cloudOwnerFor(vessel.vesselOwnerId, session.userId);
            if (ctx?.position?.source === 'cloud' && (ctx.position.cloudOwner ?? null) !== wanted) {
                ctx = null;
                contextPromise.current = deps.captureContext(async () => wanted);
            }
            const own = vessel.vesselOwnerId === session.userId;
            const boatHasCrew = !!vessel.vesselOwnerId && (own ? (session.ownCrewCount ?? 0) > 0 : true);
            const visibility = chooseDefaultVisibility({
                group,
                hasVessel: !!vessel.vesselOwnerId,
                boatHasCrew,
                lastChoice: choices[group] ?? null,
            });
            const saved = await logSighting({
                group,
                eventAt: openedAt,
                context: ctx,
                vessel,
                visibility,
                observerDisplay: signedIn ? await deps.observerDisplay() : null,
            });
            setRecord(saved);
            if (saved.row.decimal_latitude !== null) {
                setPositionState('attached');
            } else if (contextPromise.current) {
                setPositionState('pending');
                void awaitSightingPosition(saved.id, contextPromise.current).then((result) => {
                    setPositionState(result);
                    void refresh(saved.id);
                });
            }
        } finally {
            setBusy(false);
        }
    };

    const retryPosition = async () => {
        if (!record) return;
        setPositionState('pending');
        const owner = cloudOwnerFor(record.row.vessel_owner_id, session.userId);
        const promise = deps.captureContext(async () => owner);
        contextPromise.current = promise;
        const ctx = await promise.catch(() => null);
        if (ctx) setContext(ctx);
        if (ctx?.position) {
            const saved = await attachSightingContext(record.id, ctx);
            if (saved) setRecord(saved);
            setPositionState(saved?.row.decimal_latitude !== null && saved ? 'attached' : 'needs-position');
        } else {
            setPositionState('needs-position');
        }
    };

    const edit = async (change: Parameters<typeof editSighting>[1]) => {
        if (!record) return;
        const saved = await editSighting(record.id, change);
        if (saved) setRecord(saved);
        return saved;
    };

    const undo = async () => {
        if (!record) return;
        await deleteSighting(record.id);
        setRecord(null);
        setPositionState('pending');
        requestAnimationFrame(() => firstTile.current?.focus());
    };

    const done = () => {
        if (record) {
            if (signedIn) scheduleSightingDrain(0);
            onLogged?.(record.id);
        }
        onClose();
    };

    const pickSpecies = async (
        scientificName: string | null,
        vernacular: string | null,
        group?: SightingGroup,
        sensitive = false,
    ) => {
        if (!record) return;
        const saved = await edit({
            scientific_name: scientificName,
            ...(group && group !== record.row.taxon_group ? { taxon_group: group } : {}),
        });
        if (saved) {
            const named = await setSightingDisplayName(saved.id, vernacular, sensitive);
            setRecord(named ?? { ...saved, vernacularName: vernacular });
        }
    };

    // ── Species list (replaces the sheet while it is open) ──
    if (picking && record) {
        return (
            <SpeciesPicker
                group={record.row.taxon_group}
                selected={record.row.scientific_name}
                catalogueLoader={deps.loadCatalogue}
                onClose={() => setPicking(false)}
                onPick={(species) => {
                    setPicking(false);
                    void pickSpecies(
                        species?.scientificName ?? null,
                        species?.vernacularName ?? null,
                        species?.group,
                        species?.sensitive ?? false,
                    );
                }}
            />
        );
    }

    // ── Step 1: what did you see? ──
    if (!record) {
        return (
            <SightingsSheet
                title="What did you see?"
                subtitle={<span className="tabular-nums">Logged the moment you tap · {formatClock(openedAt)}</span>}
                onClose={onClose}
                closeLabel="Close without logging"
                testId="quick-log"
            >
                <PositionLine context={context} pending={contextPending} />
                <div className="mt-3 grid grid-cols-2 gap-2.5" role="group" aria-label="Log a group">
                    {SIGHTING_GROUPS.map((group, i) => (
                        <button
                            key={group}
                            ref={i === 0 ? firstTile : undefined}
                            type="button"
                            disabled={busy}
                            onClick={() => void log(group)}
                            aria-label={`Log ${SIGHTING_GROUP_LABELS[group].toLowerCase()}`}
                            className="sg-tile sg-group-tile flex items-center gap-3 px-3 text-left transition-transform active:scale-[0.97]"
                        >
                            <GroupChip group={group} size="lg" />
                            <span className="min-w-0 text-[16px] font-extrabold leading-tight text-white">
                                {SIGHTING_GROUP_LABELS[group]}
                            </span>
                        </button>
                    ))}
                </div>
                <p className="mt-3 text-center text-[12.5px] sg-muted">
                    Species, count and a photo can wait. Tap the group now.
                </p>
            </SightingsSheet>
        );
    }

    // ── Step 2: logged; refine at leisure ──
    const row = record.row;
    const group = row.taxon_group;
    const label = record.vernacularName || SIGHTING_GROUP_LABELS[group];
    const card = distanceCardFor(group, row.decimal_latitude, row.decimal_longitude);
    const chips = catalogue ? likelyFirst(catalogue, group) : [];
    const coarse = isCoarsePublic(catalogue, group, row.scientific_name, record.everSensitive);
    const sourceWord = row.position_source
        ? row.sampling_protocol.includes('shore')
            ? 'Ashore'
            : row.position_source === 'phone'
              ? 'Phone GPS'
              : 'Boat GPS'
        : positionState === 'needs-position'
          ? 'No position yet'
          : 'Finding position';
    const where = signedIn ? (record.sync.state === 'synced' ? 'sent' : 'on this phone') : 'on this phone only';

    return (
        <SightingsSheet
            title={`${label} logged`}
            subtitle={
                <span className="tabular-nums">
                    {formatClock(row.event_date)} · {sourceWord} · {where}
                </span>
            }
            leading={
                <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                >
                    <SightingIcon name="check" className="h-5 w-5" />
                </span>
            }
            // The corner a thumb goes to dismiss SAVES here (Done), never undoes.
            onClose={done}
            closeLabel="Save and close"
            testId="quick-log"
            footer={
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => void undo()}
                        className="sg-toggle sg-btn"
                        style={{ flex: '0 0 auto', minHeight: 56, paddingInline: 20 }}
                    >
                        Undo
                    </button>
                    <button type="button" onClick={done} className="sg-cta" style={{ flex: '1 1 auto', width: 'auto' }}>
                        Done
                    </button>
                </div>
            }
        >
            {positionState === 'needs-position' && row.decimal_latitude === null && (
                <div className="sg-amber mb-2 flex items-center gap-3 px-3 py-2 text-[13px] leading-snug" role="status">
                    <span className="flex-1">
                        <b className="sg-amber-strong">No position yet.</b> It stays on this phone, unsent, until it has
                        one: Retry now, or later from Sightings.
                    </span>
                    <button
                        type="button"
                        onClick={() => void retryPosition()}
                        className="min-h-[44px] shrink-0 rounded-full border border-amber-400/50 px-3 font-extrabold sg-amber-strong"
                    >
                        Retry
                    </button>
                </div>
            )}
            {card && <KeepYourDistanceCard card={card} hasCalf={row.has_calf} />}

            {/* Which species: likely first, the full list behind More… */}
            <div className="mt-3">
                <div className="mb-1.5 flex items-baseline gap-2">
                    <span id="sg-which" className="sg-eyebrow">
                        Which {SIGHTING_GROUP_LABELS[group].toLowerCase()}?
                    </span>
                    <span className="text-[12px] font-semibold sg-muted">optional</span>
                </div>
                <div
                    role="group"
                    aria-labelledby="sg-which"
                    className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
                    style={{ scrollbarWidth: 'none' }}
                >
                    {chips.map((s) => {
                        const on = row.scientific_name === s.scientificName;
                        return (
                            <button
                                key={s.scientificName}
                                type="button"
                                aria-pressed={on}
                                onClick={() => {
                                    if (on) void pickSpecies(null, null);
                                    else {
                                        void rememberRecentSpecies(s.scientificName);
                                        void pickSpecies(s.scientificName, s.vernacularName, s.group, s.sensitive);
                                    }
                                }}
                                className="sg-toggle sg-pill"
                            >
                                {on && <SightingIcon name="check" className="h-3.5 w-3.5" />}
                                {s.vernacularName}
                            </button>
                        );
                    })}
                    {row.scientific_name && !chips.some((s) => s.scientificName === row.scientific_name) && (
                        <span className="sg-toggle sg-pill" data-on="true">
                            <SightingIcon name="check" className="h-3.5 w-3.5" />
                            {record.vernacularName || row.scientific_name}
                        </span>
                    )}
                    <button type="button" onClick={() => setPicking(true)} className="sg-toggle sg-pill">
                        More…
                    </button>
                </div>
            </div>

            <div className="mt-3">
                <CountStepper
                    label="How many?"
                    hint="Best guess is fine"
                    value={row.individual_count}
                    onChange={(n) => void edit({ individual_count: n })}
                />
            </div>
            <div className="mt-3">
                <CalfAndPhotos
                    record={record}
                    showCalf={CALF_GROUPS.has(group)}
                    onCalf={() => void edit({ has_calf: !row.has_calf })}
                    onRecord={setRecord}
                />
            </div>

            <div className="mt-3">
                <VisibilityPicker
                    value={row.visibility}
                    group={group}
                    signedIn={signedIn}
                    hasVessel={!!row.vessel_owner_id}
                    crewAudience={crewAudience(session, row.vessel_owner_id)}
                    sent={record.sync.state === 'synced'}
                    coarse={coarse}
                    named={!!row.scientific_name}
                    creditPublic={row.credit_public}
                    onChange={(v) => {
                        void rememberVisibilityChoice(group, v);
                        void edit({ visibility: v });
                    }}
                    onCreditChange={(credit) => void edit({ credit_public: credit })}
                />
            </div>

            {contextChips(row).length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Logged with it">
                    {contextChips(row).map((chip) => (
                        <li
                            key={chip}
                            className="sg-toggle rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums"
                        >
                            {chip}
                        </li>
                    ))}
                </ul>
            )}
            {forecastNote(row) && <p className="mt-1.5 sg-note">{forecastNote(row)}</p>}
        </SightingsSheet>
    );
};

export default QuickLogSheet;
