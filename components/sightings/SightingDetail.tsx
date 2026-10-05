/**
 * One sighting: what, when, where and what the boat knew at the time, each
 * value tagged with where it came from (the boat's instruments, or a forecast
 * with the model credited, as the CC-BY licence asks). Your own sighting can
 * be refined (species, count, calf, behaviour, how far off, notes, photos,
 * who sees it) or deleted. Where and when cannot change: a wrong pin is
 * deleted and logged again.
 *
 * A public row is already three hours late and on a grid when it arrives; it
 * shows only what the server gave.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { isCoarsePublic, type SightingCatalogue } from '../../services/sightings/catalogue';
import {
    deleteSighting,
    editSighting,
    retrySendingSighting,
    retrySightingPosition,
    setSightingDisplayName,
} from '../../services/sightings/sightingService';
import { getLocalSighting, loadPhotoBlob } from '../../services/sightings/sightingStore';
import { scheduleSightingDrain, sightingPhotoUrl } from '../../services/sightings/sightingSync';
import {
    OBSERVED_DISTANCES_M,
    SIGHTING_LIMITS,
    type LocalSighting,
    type ObservedDistanceM,
    type SightingEdit,
} from '../../services/sightings/types';
import type { SightingsSession } from '../../hooks/sightings/useSightingsSession';
import { SightingsSheet } from './SightingsSheet';
import { GroupChip } from './SightingGlyphs';
import { SpeciesPicker } from './SpeciesPicker';
import { VisibilityPicker } from './VisibilityPicker';
import { crewAudience } from './QuickLogSheet';
import { CALF_GROUPS, CalfAndPhotos, CountStepper, photoAudience } from './RefineControls';
import {
    agoLabel,
    areaLabel,
    compassPoint,
    countLine,
    dayLabel,
    failedReason,
    forecastCredit,
    formatClock,
    formatPosition,
    observerLabel,
    POSITION_SOURCE_LABEL,
    sightingName,
    SYNC_LABEL,
    type SightingItem,
} from './sightingsFormat';

const DISTANCE_LABEL: Record<ObservedDistanceM, string> = {
    100: '~100 m',
    500: '~500 m',
    1000: '~1 km',
    3000: '3 km+',
};

const VIS_LABEL = { private: 'Private', crew: 'Crew · live', public: 'Public · 3 h late' } as const;

/** A Retry that finds the boat's position now: on its own when the moment is recent, said plainly when it is not. */
export const RECENT_RETRY_MS = 10 * 60_000;

export function isRecentForRetry(eventDate: string, now = Date.now()): boolean {
    const at = Date.parse(eventDate);
    return Number.isFinite(at) && now - at <= RECENT_RETRY_MS;
}

/** The sighting waits, unsent, for a position: say so, and offer to add one. */
const NeedsPosition: React.FC<{ record: LocalSighting; onRecord: (r: LocalSighting) => void }> = ({
    record,
    onRecord,
}) => {
    const [state, setState] = useState<'idle' | 'busy' | 'none'>('idle');
    const recent = isRecentForRetry(record.row.event_date);
    const retry = async () => {
        setState('busy');
        const result = await retrySightingPosition(record.id);
        const fresh = await getLocalSighting(record.id, record.ownerUserId);
        if (fresh) onRecord(fresh);
        setState(result === 'attached' ? 'idle' : 'none');
        if (result === 'attached' && record.ownerUserId) scheduleSightingDrain(0);
    };
    return (
        <div className="sg-amber mt-3 px-3 py-2.5 text-[13px] leading-snug" role="status" data-testid="needs-position">
            <p>
                <b className="sg-amber-strong">No position yet.</b> It stays on this phone, unsent, until it has one.
            </p>
            {!recent && (
                <p className="mt-1">
                    Only if you haven’t moved far since {formatClock(record.row.event_date)}: the boat’s position now
                    stands in, its uncertainty widened by how far she could have gone.
                </p>
            )}
            {state === 'none' && <p className="mt-1">Still no position. Try again with a GPS fix, or delete it.</p>}
            <button
                type="button"
                disabled={state === 'busy'}
                onClick={() => void retry()}
                className="mt-2 min-h-[44px] rounded-full border border-amber-400/50 px-4 font-extrabold sg-amber-strong"
            >
                {state === 'busy' ? 'Finding the boat…' : recent ? 'Retry' : 'Use position now'}
            </button>
        </div>
    );
};

/** The server refused it (or it is too old): why, and try again when that could help. */
const NotSent: React.FC<{ record: LocalSighting; onRecord: (r: LocalSighting) => void }> = ({ record, onRecord }) => {
    const reason = failedReason(record.sync.lastError);
    return (
        <div className="sg-amber mt-3 px-3 py-2.5 text-[13px] leading-snug" role="status" data-testid="not-sent">
            <p>
                <b className="sg-amber-strong">Not sent.</b> {reason.text}
            </p>
            {reason.retryable && (
                <button
                    type="button"
                    onClick={() =>
                        void retrySendingSighting(record.id).then((saved) => {
                            if (saved) onRecord(saved);
                            if (record.ownerUserId) scheduleSightingDrain(0);
                        })
                    }
                    className="mt-2 min-h-[44px] rounded-full border border-amber-400/50 px-4 font-extrabold sg-amber-strong"
                >
                    Try again
                </button>
            )}
        </div>
    );
};

/** Photos: this phone's stripped copies first, else a one-hour signed link. */
const Photos: React.FC<{ record: LocalSighting | null; paths: string[]; audience: string }> = ({
    record,
    paths,
    audience,
}) => {
    const [urls, setUrls] = useState<string[]>([]);
    // One key for what is shown, so a new array of the same paths is not a change.
    const key = record ? record.photos.map((p) => p.blobKey ?? p.path ?? '').join('|') : paths.join('|');
    useEffect(() => {
        let live = true;
        const made: string[] = [];
        void (async () => {
            const out: string[] = [];
            const slots = record ? record.photos : paths.map((path, slot) => ({ slot, blobKey: null, path }));
            for (const p of slots) {
                const blob = p.blobKey ? await loadPhotoBlob(p.blobKey) : null;
                if (blob && typeof URL.createObjectURL === 'function') {
                    const url = URL.createObjectURL(blob);
                    made.push(url);
                    out.push(url);
                } else if (p.path) {
                    const url = await sightingPhotoUrl(p.path);
                    if (url) out.push(url);
                }
            }
            if (live) setUrls(out);
        })();
        return () => {
            live = false;
            made.forEach((u) => URL.revokeObjectURL(u));
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    if (urls.length === 0) return null;
    return (
        <div className="mt-3">
            <div className="flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {urls.map((url, i) => (
                    <img
                        key={url}
                        src={url}
                        alt={`Photo ${i + 1} of the sighting`}
                        className="h-24 w-32 shrink-0 rounded-xl object-cover"
                    />
                ))}
            </div>
            <p className="mt-1 text-[12px] sg-muted">Location data removed before upload · {audience}</p>
        </div>
    );
};

const Row: React.FC<{ label: string; value: React.ReactNode; note?: React.ReactNode }> = ({ label, value, note }) => (
    <div className="flex gap-3 py-2.5">
        <dt className="w-16 shrink-0 text-[13px] font-bold sg-muted">{label}</dt>
        <dd className="min-w-0 flex-1">
            <div className="text-[14px] font-bold tabular-nums text-white">{value}</div>
            {note && <div className="text-[12px] leading-snug sg-muted">{note}</div>}
        </dd>
    </div>
);

export interface SightingDetailProps {
    item: SightingItem;
    session: SightingsSession;
    catalogue: SightingCatalogue | null;
    onClose: () => void;
}

export const SightingDetail: React.FC<SightingDetailProps> = ({ item, session, catalogue, onClose }) => {
    const [record, setRecord] = useState<LocalSighting | null>(item.local);
    const [editing, setEditing] = useState(false);
    const [picking, setPicking] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const row = record?.row ?? item.server ?? null;
    const own = !!record && record.sync.op !== 'delete';
    const view: SightingItem = record
        ? {
              ...item,
              group: record.row.taxon_group,
              scientificName: record.row.scientific_name,
              vernacularName: record.vernacularName,
              count: record.row.individual_count,
              hasCalf: record.row.has_calf,
          }
        : item;
    const [behavior, setBehavior] = useState(row?.behavior ?? '');
    const [remarks, setRemarks] = useState(row?.occurrence_remarks ?? '');

    const edit = async (change: SightingEdit) => {
        if (!record) return null;
        const saved = await editSighting(record.id, change);
        if (saved) setRecord(saved);
        return saved;
    };

    const finishEditing = async () => {
        await edit({
            behavior: behavior.trim() || null,
            occurrence_remarks: remarks.trim() || null,
        });
        setEditing(false);
        if (session.userId) scheduleSightingDrain(0);
    };

    const remove = async () => {
        if (!record) return;
        await deleteSighting(record.id);
        onClose();
    };

    const everSensitive = !!record?.everSensitive;
    const coarse = useMemo(
        () => isCoarsePublic(catalogue, view.group, view.scientificName, everSensitive),
        [catalogue, view.group, view.scientificName, everSensitive],
    );

    if (picking && record) {
        return (
            <SpeciesPicker
                group={record.row.taxon_group}
                selected={record.row.scientific_name}
                onClose={() => setPicking(false)}
                onPick={(species) => {
                    setPicking(false);
                    void (async () => {
                        const saved = await edit({
                            scientific_name: species?.scientificName ?? null,
                            ...(species && species.group !== record.row.taxon_group
                                ? { taxon_group: species.group }
                                : {}),
                        });
                        if (saved) {
                            const named = await setSightingDisplayName(
                                saved.id,
                                species?.vernacularName ?? null,
                                species?.sensitive ?? false,
                            );
                            setRecord(named ?? { ...saved, vernacularName: species?.vernacularName ?? null });
                        }
                    })();
                }}
            />
        );
    }

    const name = sightingName(view);
    const when = `${dayLabel(view.eventDate)} ${formatClock(view.eventDate)}`;
    const by = item.publicRow
        ? `${agoLabel(view.eventDate)} · ${item.observerDisplay}`
        : `logged by ${observerLabel(item, session.userId).replace(/^You$/, 'you')}`;
    const sync = record && record.sync.state !== 'synced' ? SYNC_LABEL[record.sync.state] : null;

    return (
        <SightingsSheet
            title={name}
            subtitle={
                <span className="tabular-nums">
                    {when} · {by}
                </span>
            }
            onClose={editing ? () => void finishEditing().then(onClose) : onClose}
            closeLabel="Close sighting"
            testId="sighting-detail"
            footer={
                own ? (
                    confirmDelete ? (
                        <div className="sg-amber px-3 py-2.5" role="alertdialog" aria-label="Delete this sighting?">
                            <p className="text-[13px] leading-snug">
                                <b className="sg-amber-strong">Delete this sighting?</b> It goes from your crew’s feed
                                and the public map too.
                            </p>
                            <div className="mt-2 flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setConfirmDelete(false)}
                                    className="sg-toggle sg-btn"
                                >
                                    Keep it
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void remove()}
                                    className="min-h-[48px] flex-1 rounded-2xl bg-red-600 text-[14px] font-extrabold text-white"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    ) : editing ? (
                        <button type="button" onClick={() => void finishEditing()} className="sg-cta">
                            Done
                        </button>
                    ) : (
                        <div className="flex gap-2">
                            <button type="button" onClick={() => setEditing(true)} className="sg-toggle sg-btn">
                                Edit
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirmDelete(true)}
                                className="min-h-[48px] flex-1 rounded-2xl border border-red-400/40 bg-red-500/10 text-[14px] font-extrabold text-red-300"
                            >
                                Delete
                            </button>
                        </div>
                    )
                ) : undefined
            }
        >
            <div className="sg-card flex items-center gap-3 p-3">
                <GroupChip group={view.group} size="lg" />
                <div className="min-w-0 flex-1">
                    <div className="text-[17px] font-black leading-tight text-white">{countLine(view)}</div>
                    {view.scientificName && (
                        <div className="truncate text-[12.5px] italic sg-muted">{view.scientificName}</div>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                        {item.publicRow ? (
                            <span className="sg-toggle sg-tag">{areaLabel(item.publicRow.uncertainty_m)}</span>
                        ) : (
                            row && (
                                <span className="sg-toggle sg-tag" data-on="true">
                                    {VIS_LABEL[row.visibility]}
                                </span>
                            )
                        )}
                        {row?.behavior && !editing && <span className="sg-toggle sg-tag">{row.behavior}</span>}
                        {row?.observed_distance_m && (
                            <span className="sg-toggle sg-tag">{DISTANCE_LABEL[row.observed_distance_m]} off</span>
                        )}
                        {sync && (
                            <span className="rounded-full border border-amber-400/40 px-2 py-0.5 text-[11.5px] font-bold text-amber-300">
                                {sync}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {editing && record ? (
                <div className="mt-3 space-y-3" data-testid="sighting-edit">
                    <button
                        type="button"
                        onClick={() => setPicking(true)}
                        className="sg-toggle flex min-h-[48px] w-full items-center justify-between rounded-2xl px-4 text-[14px] font-bold"
                    >
                        <span>Species</span>
                        <span className="truncate pl-3 sg-muted">{record.vernacularName || 'Not sure'} ›</span>
                    </button>
                    <CountStepper
                        label="How many"
                        value={record.row.individual_count}
                        onChange={(n) => void edit({ individual_count: n })}
                    />
                    <CalfAndPhotos
                        record={record}
                        showCalf={CALF_GROUPS.has(record.row.taxon_group)}
                        onCalf={() => void edit({ has_calf: !record.row.has_calf })}
                        onRecord={setRecord}
                    />
                    <label className="block">
                        <span className="text-[13px] font-bold sg-muted">What it was doing</span>
                        <input
                            type="text"
                            value={behavior}
                            maxLength={SIGHTING_LIMITS.behaviorMax}
                            onChange={(e) => setBehavior(e.target.value)}
                            onBlur={() => void edit({ behavior: behavior.trim() || null })}
                            placeholder="Breaching, feeding, following the boat…"
                            className="sg-input mt-1 min-h-[48px] w-full rounded-xl px-3 text-[15px] text-white"
                        />
                    </label>
                    <div>
                        <span id="sg-edit-dist" className="text-[13px] font-bold sg-muted">
                            How far off
                        </span>
                        <div role="group" aria-labelledby="sg-edit-dist" className="mt-1 grid grid-cols-4 gap-1.5">
                            {OBSERVED_DISTANCES_M.map((d) => (
                                <button
                                    key={d}
                                    type="button"
                                    aria-pressed={record.row.observed_distance_m === d}
                                    onClick={() =>
                                        void edit({
                                            observed_distance_m: record.row.observed_distance_m === d ? null : d,
                                        })
                                    }
                                    className="sg-toggle sg-btn rounded-xl text-[13px]"
                                >
                                    {DISTANCE_LABEL[d]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <label className="block">
                        <span className="text-[13px] font-bold sg-muted">Notes · you and your crew only</span>
                        <textarea
                            value={remarks}
                            maxLength={SIGHTING_LIMITS.remarksMax}
                            onChange={(e) => setRemarks(e.target.value)}
                            onBlur={() => void edit({ occurrence_remarks: remarks.trim() || null })}
                            rows={3}
                            className="sg-input mt-1 w-full rounded-xl px-3 py-2 text-[15px] text-white"
                        />
                    </label>
                    <VisibilityPicker
                        value={record.row.visibility}
                        group={record.row.taxon_group}
                        signedIn={!!session.userId && record.ownerUserId === session.userId}
                        hasVessel={!!record.row.vessel_owner_id}
                        crewAudience={crewAudience(session, record.row.vessel_owner_id)}
                        sent={record.sync.state === 'synced'}
                        coarse={coarse}
                        named={!!record.row.scientific_name}
                        creditPublic={record.row.credit_public}
                        onChange={(v) => void edit({ visibility: v })}
                        onCreditChange={(credit) => void edit({ credit_public: credit })}
                    />
                </div>
            ) : (
                <>
                    {item.publicRow ? (
                        <dl className="sg-divider mt-2">
                            <Row
                                label="Where"
                                value={formatPosition(view.latitude, view.longitude) ?? '—'}
                                note={`The centre of a ${areaLabel(item.publicRow.uncertainty_m).replace('~', '')}: public sightings are blurred, and shown 3 hours late.`}
                            />
                            <Row
                                label="Seen"
                                value={when}
                                note={
                                    item.publicRow.generalised
                                        ? 'Threatened species: time rounded to the hour'
                                        : 'Time rounded to 10 minutes'
                                }
                            />
                        </dl>
                    ) : (
                        row && (
                            <dl className="sg-divider mt-2">
                                <Row
                                    label="Where"
                                    value={
                                        formatPosition(row.decimal_latitude, row.decimal_longitude) ?? 'No position yet'
                                    }
                                    note={
                                        row.position_source
                                            ? `${POSITION_SOURCE_LABEL[row.position_source]}${row.coordinate_uncertainty_in_meters ? ` · ±${row.coordinate_uncertainty_in_meters} m` : ''} · the boat, not the animal`
                                            : 'Not sent until it has a position'
                                    }
                                />
                                {(row.sea_temp_c !== null || row.water_depth_m !== null) && (
                                    <Row
                                        label="Sea"
                                        value={[
                                            row.sea_temp_c !== null ? `${row.sea_temp_c.toFixed(1)} °C` : null,
                                            row.water_depth_m !== null ? `${row.water_depth_m} m deep` : null,
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                        note={[
                                            row.sea_temp_source === 'forecast'
                                                ? `Sea temperature: ${forecastCredit(row.wx_model)}`
                                                : row.sea_temp_source === 'instrument'
                                                  ? 'Instruments'
                                                  : null,
                                            row.depth_reference
                                                ? `depth ${row.depth_reference.replace(/-/g, ' ')}`
                                                : null,
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    />
                                )}
                                {row.wind_speed_kts !== null && (
                                    <Row
                                        label="Wind"
                                        value={`${Math.round(row.wind_speed_kts)} kn ${row.wind_dir_deg !== null ? `from the ${compassPoint(row.wind_dir_deg)}` : ''}`.trim()}
                                        note={
                                            row.wind_source === 'forecast'
                                                ? forecastCredit(row.wx_model)
                                                : 'Instruments (true wind)'
                                        }
                                    />
                                )}
                                {row.wave_height_m !== null && (
                                    <Row
                                        label="Waves"
                                        value={`${row.wave_height_m.toFixed(1)} m`}
                                        note={forecastCredit(row.wx_model)}
                                    />
                                )}
                                {row.sog_kts !== null && (
                                    <Row
                                        label="Boat"
                                        value={`${row.sog_kts.toFixed(1)} kn${row.cog_deg !== null ? ` · ${String(Math.round(row.cog_deg)).padStart(3, '0')}°` : ''}`}
                                        note={row.voyage_id ? 'Ship’s Log voyage, recording' : undefined}
                                    />
                                )}
                            </dl>
                        )
                    )}
                    {record && own && record.sync.state === 'needs-position' && (
                        <NeedsPosition record={record} onRecord={setRecord} />
                    )}
                    {record && own && record.sync.state === 'failed' && (
                        <NotSent record={record} onRecord={setRecord} />
                    )}
                    {row && !item.publicRow && (
                        <Photos
                            record={record}
                            paths={row.photo_paths ?? []}
                            audience={record ? photoAudience(record) : 'you and your crew only'}
                        />
                    )}
                    {row?.occurrence_remarks && !item.publicRow && (
                        <p className="sg-card mt-3 p-3 text-[14px] leading-snug text-white/85">
                            {row.occurrence_remarks}
                        </p>
                    )}
                </>
            )}
        </SightingsSheet>
    );
};
