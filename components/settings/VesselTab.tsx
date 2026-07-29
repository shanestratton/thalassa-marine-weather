/**
 * VesselTab — Vessel configuration: type, name, dimensions, performance, capacity.
 * Extracted from SettingsModal monolith (63 lines → standalone component).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Section, Row, type SettingsTabProps } from './SettingsPrimitives';
import { LengthUnit, WeightUnit, VolumeUnit, VesselDimensionUnits, VesselProfile } from '../../types';
import type { PolarData } from '../../types/navigation';
import type { ComfortParams } from '../../types/settings';
import { YachtDatabaseSearch } from './YachtDatabaseSearch';
import type { PolarDatabaseEntry } from '../../data/polarDatabase';
import { saveIdentity } from '../../services/VesselIdentityService';
import { getAuthIdentityScope } from '../../services/authIdentityScope';
import { vesselCruisingSpeedKts, vesselMaxWaveHeightFt } from '../../services/units';
import { useSettingsStore } from '../../stores/settingsStore';
import { EyeIcon, CheckIcon, PlusSquareIcon, RefreshIcon, TrashIcon } from '../Icons';
import { triggerHaptic } from '../../utils/system';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';

/**
 * The fleet store is deliberately read through this small compatibility
 * surface.  VesselTab ships alongside the fleet-store migration, so older
 * app builds (and isolated component tests) can still render the legacy
 * single-vessel profile while the new store is not present.
 *
 * Keep this adapter local: the canonical runtime/store types live with the
 * fleet service. This component only needs enough shape to render a selector
 * and call the public actions.
 */
interface FleetProfilePatch {
    profile?: Partial<VesselProfile>;
    vesselUnits?: Partial<VesselDimensionUnits>;
    comfortParams?: Partial<ComfortParams>;
    polarData?: PolarData | null;
    setPolarData?: boolean;
    polarBoatModel?: string | null;
    setPolarBoatModel?: boolean;
    polarSourceType?: 'database' | 'file_import' | 'manual' | null;
    setPolarSourceType?: boolean;
}

type FleetProfileUpdate = Partial<VesselProfile> | FleetProfilePatch;

interface FleetStoreSurface {
    vesselFleet?: unknown;
    activeVesselId?: unknown;
    vesselFleetStatus?: unknown;
    selectActiveVessel?: (vesselId: string) => unknown;
    createVesselProfile?: (profile: VesselProfile) => unknown;
    archiveVesselProfile?: (vesselId: string) => unknown;
    patchActiveVesselProfile?: (patch: FleetProfileUpdate) => unknown;
    syncVesselFleet?: () => unknown;
}

interface FleetVesselOption {
    id: string;
    vessel: Partial<VesselProfile>;
    archived: boolean;
}

type FleetBusyAction = 'add' | 'archive' | 'sync' | null;

interface FleetStatusDisplay {
    label: string;
    detail: string | null;
    tone: 'green' | 'blue' | 'amber' | 'red' | 'slate';
    busy: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        const stringValue = nonEmptyString(value);
        if (stringValue) return stringValue;
    }
    return null;
}

function fleetOptionFromUnknown(value: unknown): FleetVesselOption | null {
    if (!isRecord(value)) return null;

    const id = firstString(value.id, value.vessel_id, value.vesselId, value.boat_id, value.boatId);
    if (!id) return null;

    const nestedProfile = isRecord(value.profile)
        ? value.profile
        : isRecord(value.vessel)
          ? value.vessel
          : isRecord(value.specs)
            ? value.specs
            : value;
    const archived =
        value.archived === true ||
        value.is_archived === true ||
        value.isArchived === true ||
        typeof value.archived_at === 'string' ||
        typeof value.archivedAt === 'string';

    return {
        id,
        vessel: nestedProfile as Partial<VesselProfile>,
        archived,
    };
}

function fleetOptionsFromUnknown(value: unknown): FleetVesselOption[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(fleetOptionFromUnknown)
        .filter((option): option is FleetVesselOption => option !== null)
        .filter((option) => !option.archived);
}

function fleetActionResultId(value: unknown): string | null {
    if (!isRecord(value)) return null;
    return firstString(value.id, value.vessel_id, value.vesselId, value.boat_id, value.boatId);
}

function fleetStatusDisplay(value: unknown, fleetAvailable: boolean): FleetStatusDisplay {
    if (!fleetAvailable) {
        return {
            label: 'Local profile',
            detail: 'Fleet cloud sync is not available in this build yet.',
            tone: 'slate',
            busy: false,
        };
    }

    if (value === null || value === undefined) {
        return {
            label: 'Ready to sync',
            detail: 'The fleet service is ready; run a cloud check after making changes.',
            tone: 'slate',
            busy: false,
        };
    }

    const record = isRecord(value) ? value : null;
    const raw =
        typeof value === 'string' ? value : (firstString(record?.state, record?.status, record?.phase) ?? 'idle');
    const status = raw.toLowerCase().replace(/[\s_-]+/g, '');
    const error = firstString(record?.error, record?.message, record?.lastError);
    const lastSyncedAt = firstString(record?.lastSyncedAt, record?.last_synced_at, record?.syncedAt);
    const syncedDetail = lastSyncedAt ? `Last cloud check ${new Date(lastSyncedAt).toLocaleString()}` : null;

    if (error || status.includes('error') || status.includes('failed') || status.includes('conflict')) {
        return {
            label: 'Needs attention',
            detail: error ?? 'The fleet could not sync to the cloud.',
            tone: 'red',
            busy: false,
        };
    }
    if (status.includes('offline') || status.includes('queued') || status.includes('pending')) {
        return {
            label: 'Saved offline',
            detail: error ?? 'This device will send the vessel changes when it is back online.',
            tone: 'amber',
            busy: false,
        };
    }
    if (status.includes('sync') || status.includes('load') || status.includes('refresh')) {
        return { label: 'Syncing fleet', detail: 'Checking the cloud copy of your vessels.', tone: 'blue', busy: true };
    }
    if (status === 'idle') {
        return {
            label: 'Ready to sync',
            detail: 'The fleet service is ready; run a cloud check after making changes.',
            tone: 'slate',
            busy: false,
        };
    }
    if (status.includes('saved') || status.includes('synced') || status.includes('ready')) {
        return {
            label: 'Cloud synced',
            detail: syncedDetail ?? 'Your active vessel is available on your signed-in devices.',
            tone: 'green',
            busy: false,
        };
    }

    return { label: 'Fleet status unknown', detail: syncedDetail, tone: 'slate', busy: false };
}

function defaultFleetVessel(index: number): VesselProfile {
    return {
        name: `Vessel ${index}`,
        type: 'sail',
        length: 30,
        beam: 10,
        draft: 5,
        displacement: 10000,
        maxWaveHeight: 6,
        cruisingSpeed: 6,
        fuelCapacity: 0,
        waterCapacity: 0,
    };
}

// ── MetricInput (vessel-specific helper) ─────────────────────
function MetricInput({
    label,
    valInStandard,
    unitType,
    standardUnit,
    unitOptions,
    onChangeValue,
    onChangeUnit,
    placeholder,
    isEstimated,
}: {
    label: string;
    valInStandard: number;
    unitType: string;
    standardUnit: string;
    unitOptions: string[];
    onChangeValue: (v: number) => void;
    onChangeUnit: (u: string) => void;
    placeholder?: string;
    isEstimated?: boolean;
}) {
    const conversions: Record<string, Record<string, (n: number) => number>> = {
        ft: { m: (n) => n * 0.3048, ft: (n) => n },
        m: { ft: (n) => n / 0.3048, m: (n) => n },
        lbs: { kg: (n) => n * 0.453592, tonnes: (n) => n * 0.000453592, lbs: (n) => n },
        kg: { lbs: (n) => n / 0.453592, tonnes: (n) => n / 1000, kg: (n) => n },
        tonnes: { lbs: (n) => n / 0.000453592, kg: (n) => n * 1000, tonnes: (n) => n },
        kts: { mph: (n) => n * 1.15078, kmh: (n) => n * 1.852, kts: (n) => n },
        mph: { kts: (n) => n / 1.15078, kmh: (n) => n * 1.60934, mph: (n) => n },
        kmh: { kts: (n) => n / 1.852, mph: (n) => n / 1.60934, kmh: (n) => n },
        gal: { l: (n) => n * 3.78541, gal: (n) => n },
        l: { gal: (n) => n / 3.78541, l: (n) => n },
    };

    // Convert from standard (stored) unit → display unit
    const toDisplay = conversions[standardUnit]?.[unitType];
    const displayVal = toDisplay ? toDisplay(valInStandard) : valInStandard;

    const [localVal, setLocalVal] = useState(displayVal > 0 ? String(Math.round(displayVal * 100) / 100) : '');
    // Track whether the user is mid-edit so we never overwrite their
    // half-typed value with a re-derived display number from props.
    const isFocusedRef = useRef(false);

    // Sync localVal whenever displayVal changes from outside (unit
    // toggle, external save, yacht-database auto-fill). Without this,
    // switching the unit dropdown left localVal stuck at the previous
    // unit's number — the input visibly said "55" while the dropdown
    // said "m", and any subsequent blur converted "55 m" → 180 ft into
    // storage, silently corrupting the vessel record. The
    // user-reported "555 ft" Tayana 55 was downstream of this exact
    // round-trip after several unit toggles.
    //
    // Only sync when not focused — typing into the field shouldn't
    // get clobbered by a parent re-render.
    useEffect(() => {
        if (isFocusedRef.current) return;
        const next = displayVal > 0 ? String(Math.round(displayVal * 100) / 100) : '';
        setLocalVal((prev) => (prev === next ? prev : next));
    }, [displayVal]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setLocalVal(e.target.value);

    const handleBlur = () => {
        isFocusedRef.current = false;
        const numericVal = parseFloat(localVal);
        if (isNaN(numericVal)) return;
        // Convert from display unit → standard (stored) unit
        const toStandard = conversions[unitType]?.[standardUnit];
        if (toStandard) {
            onChangeValue(Math.round(toStandard(numericVal) * 100) / 100);
        } else {
            onChangeValue(numericVal);
        }
    };

    return (
        <div>
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                {label}
                {isEstimated && <span className="text-amber-400/70 ml-1 text-[11px]">(est.)</span>}
            </label>
            <div className="flex gap-1.5 min-w-0">
                <input
                    type="number"
                    inputMode="decimal"
                    value={localVal}
                    onFocus={() => {
                        isFocusedRef.current = true;
                    }}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    placeholder={placeholder}
                    className={`flex-1 min-w-0 bg-white/5 border rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors ${isEstimated ? 'border-amber-500/30 focus:border-amber-400' : 'border-white/10 focus:border-sky-500'}`}
                />
                <select
                    value={unitType}
                    onChange={(e) => onChangeUnit(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-xl px-1.5 py-2.5 text-[11px] text-gray-400 font-bold uppercase outline-none focus:border-sky-500 shrink-0"
                >
                    {unitOptions.map((u) => (
                        <option key={u} value={u}>
                            {u}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

export const VesselTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const fleetSurface = useSettingsStore((state) => state as unknown as FleetStoreSurface);
    const fleet = useMemo(() => fleetOptionsFromUnknown(fleetSurface.vesselFleet), [fleetSurface.vesselFleet]);
    const activeVesselId = firstString(fleetSurface.activeVesselId);
    const activeFleetVessel =
        fleet.find((candidate) => candidate.id === activeVesselId) ?? (fleet.length === 1 ? fleet[0] : undefined);
    // The store projects the selected cloud boat into `settings` immediately
    // for legacy consumers. Prefer that projection here too: fleet writes are
    // local-first, while the fleet array is refreshed only after the cloud
    // acknowledgement. Falling back to the row keeps isolated legacy tests
    // and pre-refresh renders safe.
    const vessel = settings.vessel ?? activeFleetVessel?.vessel;
    // The store always exposes fleet actions, including while browsing
    // anonymously. Do not advertise a cloud fleet until there is an account
    // to own it; anonymous vessel onboarding remains a normal local profile.
    const signedIn = Boolean(getAuthIdentityScope().userId);
    const fleetAvailable =
        signedIn &&
        (Array.isArray(fleetSurface.vesselFleet) ||
            typeof fleetSurface.selectActiveVessel === 'function' ||
            typeof fleetSurface.createVesselProfile === 'function' ||
            typeof fleetSurface.archiveVesselProfile === 'function' ||
            typeof fleetSurface.patchActiveVesselProfile === 'function' ||
            typeof fleetSurface.syncVesselFleet === 'function');
    const canPatchActiveFleetVessel = fleetAvailable && typeof fleetSurface.patchActiveVesselProfile === 'function';
    const syncStatus = useMemo(
        () => fleetStatusDisplay(fleetSurface.vesselFleetStatus, fleetAvailable),
        [fleetSurface.vesselFleetStatus, fleetAvailable],
    );

    const [saved, setSaved] = useState(false);
    const [fleetBusyAction, setFleetBusyAction] = useState<FleetBusyAction>(null);
    const [fleetActionError, setFleetActionError] = useState<string | null>(null);
    const [archiveCandidate, setArchiveCandidate] = useState<FleetVesselOption | null>(null);
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isObserver = vessel?.type === 'observer';
    const keyboardHeight = useKeyboardOffset();

    useEffect(
        () => () => {
            if (savedTimer.current) clearTimeout(savedTimer.current);
        },
        [],
    );

    const showSavedConfirmation = useCallback(() => {
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 2600);
    }, []);

    const reportFleetError = useCallback((message: string) => {
        setFleetActionError(message);
        setSaved(false);
    }, []);

    const callFleetAction = useCallback(
        async (kind: Exclude<FleetBusyAction, null>, action: () => unknown) => {
            setFleetBusyAction(kind);
            setFleetActionError(null);
            try {
                return await Promise.resolve(action());
            } catch (error) {
                reportFleetError(error instanceof Error ? error.message : 'Could not update your vessel fleet.');
                return null;
            } finally {
                setFleetBusyAction(null);
            }
        },
        [reportFleetError],
    );

    const updateActiveFleetProfile = useCallback(
        (patch: FleetProfileUpdate) => {
            const patchProfile = fleetSurface.patchActiveVesselProfile;
            if (!canPatchActiveFleetVessel || !patchProfile) return false;
            void Promise.resolve(patchProfile(patch)).catch((error: unknown) => {
                reportFleetError(error instanceof Error ? error.message : 'Could not save this vessel change.');
            });
            return true;
        },
        [canPatchActiveFleetVessel, fleetSurface.patchActiveVesselProfile, reportFleetError],
    );

    const updateVesselUnits = useCallback(
        (patch: Partial<VesselDimensionUnits>) => {
            if (updateActiveFleetProfile({ vesselUnits: patch })) return;
            onSave({
                vesselUnits: {
                    ...settings.vesselUnits,
                    ...patch,
                } as VesselDimensionUnits,
            });
        },
        [onSave, settings.vesselUnits, updateActiveFleetProfile],
    );

    const updateComfortParams = useCallback(
        (patch: Partial<ComfortParams>) => {
            if (updateActiveFleetProfile({ comfortParams: patch })) return;
            onSave({ comfortParams: { ...settings.comfortParams, ...patch } });
        },
        [onSave, settings.comfortParams, updateActiveFleetProfile],
    );

    const vesselWithDefaults = useCallback(
        (patch: Partial<VesselProfile> = {}): VesselProfile => ({
            name: 'My Boat',
            type: 'sail',
            length: 30,
            beam: 10,
            draft: 5,
            displacement: 10000,
            maxWaveHeight: 6,
            cruisingSpeed: 6,
            fuelCapacity: 0,
            waterCapacity: 0,
            ...(vessel || {}),
            ...patch,
        }),
        [vessel],
    );

    // Mirror the identity-relevant vessel fields into the `vessel_identity`
    // table. Settings only persist to device-local Capacitor Preferences, so
    // without this the public Voyage Log API (and the handle generator) never
    // see the vessel's name. Debounced so typing doesn't fire an upsert per
    // keystroke.
    const vesselName = vessel?.name;
    const vesselType = vessel?.type;
    const vesselModel = vessel?.model;
    useEffect(() => {
        // The fleet service owns per-vessel identity. Keep the legacy identity
        // mirror only for pre-fleet builds so editing a second vessel cannot
        // overwrite the account's old singleton identity row.
        if (fleetAvailable || !vesselName) return;
        const t = setTimeout(() => {
            void saveIdentity({
                vessel_name: vesselName,
                vessel_type: vesselType === 'power' ? 'power' : vesselType === 'observer' ? 'observer' : 'sail',
                ...(vesselModel ? { model: vesselModel } : {}),
            });
        }, 1200);
        return () => clearTimeout(t);
    }, [fleetAvailable, vesselName, vesselType, vesselModel]);

    const updateVessel = (field: string, value: string | number) => {
        let newEstimatedFields = vessel?.estimatedFields;
        if (newEstimatedFields && newEstimatedFields.includes(field)) {
            newEstimatedFields = newEstimatedFields.filter((f) => f !== field);
        }
        const patch = { estimatedFields: newEstimatedFields, [field]: value } as Partial<VesselProfile>;
        if (updateActiveFleetProfile({ profile: patch })) return;
        onSave({
            vessel: vesselWithDefaults(patch),
        });
    };

    const handleYachtSelect = (entry: PolarDatabaseEntry) => {
        // Update vessel model + auto-fill LOA
        const currentVessel: Partial<VesselProfile> = vessel || {};
        const nextVessel = vesselWithDefaults({
            beam: currentVessel.beam || Math.round(entry.loa * 0.32),
            draft: currentVessel.draft || Math.round(entry.loa * 0.16),
            displacement: currentVessel.displacement || Math.round(Math.pow(entry.loa, 3) / 2.5),
            // Derived from the NEW length, not the old one: picking a
            // different yacht has to move these. The previous
            // `currentVessel.x || …` guards pinned them to whatever the first
            // selection produced, and the local copies also ignored hull type,
            // so a catamaran got a monohull's wave ceiling.
            maxWaveHeight: vesselMaxWaveHeightFt({ ...currentVessel, length: entry.loa, maxWaveHeight: undefined }),
            cruisingSpeed: vesselCruisingSpeedKts({ ...currentVessel, length: entry.loa, cruisingSpeed: undefined }),
            fuelCapacity: currentVessel.fuelCapacity || 0,
            waterCapacity: currentVessel.waterCapacity || 0,
            model: entry.model,
            length: entry.loa,
        });
        const usedFleetProfile = updateActiveFleetProfile({
            profile: nextVessel,
            polarData: entry.polar,
            setPolarData: true,
            polarBoatModel: entry.model,
            setPolarBoatModel: true,
            polarSourceType: 'database',
            setPolarSourceType: true,
        });
        if (usedFleetProfile) return;
        // Legacy-only fallback. In fleet mode the single patch above updates
        // both the selected vessel and the compatibility view atomically;
        // issuing a second generic-settings write here can race it.
        onSave({
            vessel: nextVessel,
            polarData: entry.polar,
            polarBoatModel: entry.model,
            polarSource_type: 'database',
        });
    };

    const selectFleetVessel = (nextVesselId: string) => {
        const selectActiveVessel = fleetSurface.selectActiveVessel;
        if (!selectActiveVessel || !nextVesselId || nextVesselId === activeVesselId) return;
        void callFleetAction('sync', () => selectActiveVessel(nextVesselId));
    };

    const addFleetVessel = () => {
        const createVesselProfile = fleetSurface.createVesselProfile;
        if (!createVesselProfile || fleet.length >= 5) return;
        void (async () => {
            const result = await callFleetAction('add', () =>
                createVesselProfile(defaultFleetVessel(fleet.length + 1)),
            );
            const createdId = fleetActionResultId(result);
            const selectActiveVessel = fleetSurface.selectActiveVessel;
            if (createdId && selectActiveVessel) {
                await callFleetAction('sync', () => selectActiveVessel(createdId));
            }
        })();
    };

    const archiveFleetVessel = () => {
        const archiveVesselProfile = fleetSurface.archiveVesselProfile;
        if (!archiveCandidate || !archiveVesselProfile || fleet.length <= 1) return;
        const target = archiveCandidate;
        setArchiveCandidate(null);
        void callFleetAction('archive', () => archiveVesselProfile(target.id));
    };

    const syncFleet = () => {
        const syncVesselFleet = fleetSurface.syncVesselFleet;
        if (!syncVesselFleet) {
            reportFleetError('Fleet cloud sync is not available in this build yet.');
            return;
        }
        void (async () => {
            const result = await callFleetAction('sync', syncVesselFleet);
            if (result === null) return;

            // syncVesselFleet deliberately absorbs a transient network failure
            // and records `offline`/`error` in the store so edits can be
            // replayed later. Read its settled state before displaying a green
            // confirmation; a resolved promise alone does not mean cloud sync
            // actually succeeded.
            const storeWithGetState = useSettingsStore as unknown as {
                getState?: () => FleetStoreSurface;
            };
            const settledStatus = storeWithGetState.getState?.().vesselFleetStatus;
            if (fleetStatusDisplay(settledStatus, true).tone === 'green') showSavedConfirmation();
        })();
    };

    const syncToneClass: Record<FleetStatusDisplay['tone'], string> = {
        green: 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-200',
        blue: 'border-sky-500/20 bg-sky-500/[0.08] text-sky-200',
        amber: 'border-amber-500/20 bg-amber-500/[0.08] text-amber-200',
        red: 'border-red-500/20 bg-red-500/[0.08] text-red-200',
        slate: 'border-white/10 bg-white/[0.03] text-slate-300',
    };
    const syncDotClass: Record<FleetStatusDisplay['tone'], string> = {
        green: 'bg-emerald-400',
        blue: 'bg-sky-400 animate-pulse',
        amber: 'bg-amber-400',
        red: 'bg-red-400',
        slate: 'bg-slate-400',
    };
    const selectedFleetId = activeVesselId ?? activeFleetVessel?.id ?? '';

    return (
        <div
            className="w-full max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300"
            style={{ paddingBottom: keyboardHeight > 0 ? `${keyboardHeight + 120}px` : 120 }}
        >
            {/* Observer upgrade banner */}
            {isObserver && (
                <div className="mx-4 mb-4 bg-sky-500/[0.06] border border-sky-500/15 rounded-2xl p-4 animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-start gap-3">
                        <EyeIcon className="w-6 h-6 text-sky-300 shrink-0" />
                        <div>
                            <h4 className="text-sm font-bold text-sky-300 mb-1">Crew Member Mode Active</h4>
                            <p className="text-[11px] text-gray-400 leading-relaxed">
                                You're currently in crew member mode — weather only, no vessel features. Select{' '}
                                <strong className="text-white">Sail</strong> or{' '}
                                <strong className="text-white">Power</strong> below to unlock Passage Planning, Polars,
                                and hydrostatics.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {fleetAvailable && (
                <section className="mx-4 mb-5 rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.10] via-slate-950/40 to-slate-950/10 p-4 shadow-[0_12px_32px_rgba(8,145,178,0.08)]">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-cyan-300">
                                Your Fleet
                            </p>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                                Choose the yacht this device is planning and publishing for. Each profile keeps its own
                                hull, performance and safety details.
                            </p>
                        </div>
                        <span className="shrink-0 rounded-full border border-cyan-300/20 bg-cyan-300/[0.08] px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-cyan-200">
                            {fleet.length}/5 vessels
                        </span>
                    </div>

                    <div className="mt-4 flex gap-2">
                        <div className="min-w-0 flex-1">
                            <label htmlFor="active-vessel-profile" className="sr-only">
                                Active vessel profile
                            </label>
                            <select
                                id="active-vessel-profile"
                                value={selectedFleetId}
                                onChange={(event) => selectFleetVessel(event.target.value)}
                                disabled={fleet.length === 0 || fleetBusyAction !== null}
                                className="w-full rounded-xl border border-white/10 bg-slate-950/75 px-3 py-3 text-sm font-bold text-white outline-none transition-colors focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-55"
                            >
                                {!selectedFleetId && <option value="">Select a vessel</option>}
                                {fleet.map((candidate) => {
                                    const candidateName = candidate.vessel.name?.trim() || 'Unnamed vessel';
                                    const type = candidate.vessel.type;
                                    const typeLabel =
                                        type === 'power' ? 'Power' : type === 'observer' ? 'Observer' : 'Sail';
                                    return (
                                        <option key={candidate.id} value={candidate.id}>
                                            {candidateName} · {typeLabel}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>
                        <button
                            type="button"
                            aria-label="Add vessel profile"
                            onClick={addFleetVessel}
                            disabled={
                                fleet.length >= 5 || !fleetSurface.createVesselProfile || fleetBusyAction !== null
                            }
                            title={
                                fleet.length >= 5 ? 'A skipper can keep up to five vessel profiles.' : 'Add a vessel'
                            }
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-cyan-300/25 bg-cyan-400/[0.12] px-3 text-xs font-black uppercase tracking-wide text-cyan-100 transition-colors hover:bg-cyan-400/[0.20] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            <PlusSquareIcon className="h-4 w-4" />
                            Add
                        </button>
                    </div>

                    <div
                        className={`mt-3 rounded-xl border px-3 py-2.5 ${syncToneClass[syncStatus.tone]}`}
                        aria-live="polite"
                    >
                        <div className="flex items-center gap-2">
                            <span
                                className={`h-2 w-2 shrink-0 rounded-full ${syncDotClass[syncStatus.tone]}`}
                                aria-hidden="true"
                            />
                            <span className="text-xs font-bold">{syncStatus.label}</span>
                            {syncStatus.busy && (
                                <span className="text-[10px] font-bold uppercase tracking-wide opacity-70">
                                    Please wait
                                </span>
                            )}
                            <button
                                type="button"
                                aria-label="Sync vessel fleet now"
                                onClick={syncFleet}
                                disabled={!fleetSurface.syncVesselFleet || fleetBusyAction !== null || syncStatus.busy}
                                className="ml-auto inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wide opacity-85 transition-opacity hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                <RefreshIcon
                                    className={`h-3.5 w-3.5 ${fleetBusyAction === 'sync' ? 'animate-spin' : ''}`}
                                />
                                Sync now
                            </button>
                        </div>
                        {syncStatus.detail && (
                            <p className="mt-1 pl-4 text-[10px] leading-relaxed opacity-75">{syncStatus.detail}</p>
                        )}
                    </div>

                    {fleetActionError && (
                        <p
                            role="alert"
                            className="mt-3 rounded-xl border border-red-400/25 bg-red-500/[0.10] px-3 py-2 text-[11px] leading-relaxed text-red-200"
                        >
                            {fleetActionError}
                        </p>
                    )}

                    {archiveCandidate ? (
                        <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/[0.08] p-3">
                            <p className="text-xs font-bold text-amber-100">
                                Archive {archiveCandidate.vessel.name?.trim() || 'this vessel'}?
                            </p>
                            <p className="mt-1 text-[10px] leading-relaxed text-amber-100/70">
                                Its historic voyages stay intact, but it will no longer be available for new planning or
                                tracking.
                            </p>
                            <div className="mt-3 flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={() => setArchiveCandidate(null)}
                                    className="rounded-lg px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-slate-300 hover:bg-white/[0.06]"
                                >
                                    Keep
                                </button>
                                <button
                                    type="button"
                                    onClick={archiveFleetVessel}
                                    disabled={fleetBusyAction !== null}
                                    className="rounded-lg border border-red-400/25 bg-red-500/[0.15] px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-red-100 hover:bg-red-500/[0.22] disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                    Archive
                                </button>
                            </div>
                        </div>
                    ) : (
                        activeFleetVessel && (
                            <button
                                type="button"
                                aria-label={`Archive ${activeFleetVessel.vessel.name?.trim() || 'active vessel'}`}
                                onClick={() => setArchiveCandidate(activeFleetVessel)}
                                disabled={
                                    fleet.length <= 1 || !fleetSurface.archiveVesselProfile || fleetBusyAction !== null
                                }
                                title={
                                    fleet.length <= 1
                                        ? 'Keep at least one vessel profile active.'
                                        : 'Archive this vessel profile'
                                }
                                className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide text-slate-400 transition-colors hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                <TrashIcon className="h-3.5 w-3.5" />
                                Archive active vessel
                            </button>
                        )
                    )}
                </section>
            )}

            {/* Metric inputs intentionally remount when a different boat is selected.
                Their local edit buffers must never carry a half-typed value or a
                display-unit conversion from one vessel into another. */}
            <React.Fragment key={`vessel-form-${selectedFleetId || 'legacy'}`}>
                <Section title="Vessel Configuration">
                    <Row>
                        <div>
                            <label className="text-sm text-white font-medium block">Vessel Type</label>
                        </div>
                        <div className="flex bg-black/40 p-1 rounded-lg border border-white/10">
                            <button
                                aria-label="Set vessel type to sail"
                                onClick={() => updateVessel('type', 'sail')}
                                className={`px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.type === 'sail' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                            >
                                Sail
                            </button>
                            <button
                                aria-label="Set vessel type to power"
                                onClick={() => updateVessel('type', 'power')}
                                className={`px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.type === 'power' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                            >
                                Power
                            </button>
                        </div>
                    </Row>
                    <Row>
                        <div className={`w-full ${isObserver ? 'opacity-40' : ''}`}>
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Vessel Name
                            </label>
                            <input
                                type="text"
                                value={isObserver ? '' : vessel?.name || ''}
                                onChange={(e) => updateVessel('name', e.target.value)}
                                placeholder={isObserver ? 'Select Sail or Power first' : 'e.g. Black Pearl'}
                                disabled={isObserver}
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none text-sm font-medium disabled:cursor-not-allowed"
                            />
                        </div>
                    </Row>
                </Section>

                {/* Vessel Identity */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-purple-500" />
                        <span className="text-[11px] font-bold text-purple-400 uppercase tracking-widest">
                            Vessel Identity
                        </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Registration No.
                                </label>
                                <input
                                    type="text"
                                    value={vessel?.registration || ''}
                                    onChange={(e) => updateVessel('registration', e.target.value)}
                                    placeholder="e.g. ABC-1234"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors focus:border-sky-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    MMSI
                                </label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    maxLength={9}
                                    value={vessel?.mmsi || ''}
                                    onChange={(e) =>
                                        updateVessel('mmsi', e.target.value.replace(/\D/g, '').slice(0, 9))
                                    }
                                    placeholder="9-digit number"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors focus:border-sky-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Call Sign
                                </label>
                                <input
                                    type="text"
                                    value={vessel?.callSign || ''}
                                    onChange={(e) => updateVessel('callSign', e.target.value.toUpperCase())}
                                    placeholder="e.g. VH2ABC"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors focus:border-sky-500 uppercase"
                                />
                            </div>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-3">
                            Used for AIS identification and vessel documentation
                        </p>
                    </div>
                </div>

                {/* SAFETY & SAR — entered once here rather than per voyage, then
                    pulled into the float plan. Deliberately NOT shown on the
                    public tracking page: the beacon hex is a credential AMSA
                    verifies against, and raft/flare detail is an inventory of
                    portable gear attached to a live position. */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-rose-500" />
                        <span className="text-[11px] font-bold text-rose-400 uppercase tracking-widest">
                            Safety &amp; Rescue
                        </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <div className="sm:col-span-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    EPIRB Hex ID
                                </label>
                                <input
                                    type="text"
                                    inputMode="text"
                                    maxLength={15}
                                    value={vessel?.epirbHexId || ''}
                                    onChange={(e) =>
                                        updateVessel(
                                            'epirbHexId',
                                            e.target.value
                                                .toUpperCase()
                                                .replace(/[^0-9A-F]/g, '')
                                                .slice(0, 15),
                                        )
                                    }
                                    placeholder="15 characters, from your AMSA registration"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-mono outline-none transition-colors focus:border-rose-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Liferaft Capacity
                                </label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={vessel?.liferaftCapacity ? String(vessel.liferaftCapacity) : ''}
                                    onChange={(e) => {
                                        const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
                                        updateVessel('liferaftCapacity', Number.isFinite(n) ? n : 0);
                                    }}
                                    placeholder="persons"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors focus:border-rose-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Raft Serviced
                                </label>
                                <input
                                    type="date"
                                    value={vessel?.liferaftServiceDate || ''}
                                    onChange={(e) => updateVessel('liferaftServiceDate', e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors [color-scheme:dark] focus:border-rose-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                    Flares Expire
                                </label>
                                <input
                                    type="date"
                                    value={vessel?.flaresExpiry || ''}
                                    onChange={(e) => updateVessel('flaresExpiry', e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-2.5 py-2.5 text-white text-sm font-medium outline-none transition-colors [color-scheme:dark] focus:border-rose-500"
                                />
                            </div>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-3">
                            Goes into your float plan, which you send to one person ashore. Never shown on your public
                            page.
                        </p>
                    </div>
                </div>

                <Section title="Hull & Keel">
                    <Row>
                        <div className="w-full">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Hull Type
                            </label>
                            <div className="flex bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5">
                                {(['monohull', 'catamaran', 'trimaran'] as const).map((ht) => (
                                    <button
                                        aria-label="Select hull type"
                                        key={ht}
                                        onClick={() => updateVessel('hullType', ht)}
                                        className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.hullType === ht ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                    >
                                        {ht === 'monohull' ? 'Mono' : ht === 'catamaran' ? 'Cat' : 'Tri'}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </Row>
                    <Row>
                        <div className="w-full">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-2">
                                Keel Type
                            </label>
                            <div className="grid grid-cols-3 bg-black/40 p-1 rounded-lg border border-white/10 gap-0.5">
                                {(['fin', 'full', 'wing', 'skeg', 'centerboard', 'bilge'] as const).map((kt) => (
                                    <button
                                        aria-label="Select keel type"
                                        key={kt}
                                        onClick={() => updateVessel('keelType', kt)}
                                        className={`px-2 py-2 rounded-lg text-xs font-bold uppercase transition-all ${vessel?.keelType === kt ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                                    >
                                        {kt === 'centerboard' ? 'C/Board' : kt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </Row>
                </Section>

                {/* Yacht Database Search — replaces the old Make/Model text input */}
                <div className="mx-4 mb-4">
                    <YachtDatabaseSearch
                        selectedModel={settings.polarBoatModel || vessel?.model}
                        onSelect={handleYachtSelect}
                    />
                </div>

                {/* Hull Dimensions */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-sky-500" />
                        <span className="text-[11px] font-bold text-sky-400 uppercase tracking-widest">
                            Hull Dimensions
                        </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Length"
                                valInStandard={vessel?.length || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.length || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('length', v)}
                                onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                placeholder="30"
                                isEstimated={vessel?.estimatedFields?.includes('length')}
                            />
                            <MetricInput
                                label="Beam"
                                valInStandard={vessel?.beam || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.beam || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('beam', v)}
                                onChangeUnit={(u) => updateVesselUnits({ beam: u as LengthUnit })}
                                placeholder="10"
                                isEstimated={vessel?.estimatedFields?.includes('beam')}
                            />
                            <MetricInput
                                label="Draft"
                                valInStandard={vessel?.draft || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.draft || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('draft', v)}
                                onChangeUnit={(u) => updateVesselUnits({ draft: u as LengthUnit })}
                                placeholder="5"
                                isEstimated={vessel?.estimatedFields?.includes('draft')}
                            />
                            <MetricInput
                                label="Displacement"
                                valInStandard={vessel?.displacement || 0}
                                standardUnit="lbs"
                                unitType={settings.vesselUnits?.displacement || 'lbs'}
                                unitOptions={['lbs', 'kg', 'tonnes']}
                                onChangeValue={(v) => updateVessel('displacement', v)}
                                onChangeUnit={(u) => updateVesselUnits({ displacement: u as WeightUnit })}
                                placeholder="10000"
                                isEstimated={vessel?.estimatedFields?.includes('displacement')}
                            />
                            <MetricInput
                                label="Air Draft"
                                valInStandard={vessel?.airDraft || 0}
                                standardUnit="ft"
                                unitType={settings.vesselUnits?.length || 'ft'}
                                unitOptions={['ft', 'm']}
                                onChangeValue={(v) => updateVessel('airDraft', v)}
                                onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                placeholder="50"
                            />
                        </div>
                    </div>
                </div>

                {/* Performance (auto-calculated — read-only) */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-emerald-500" />
                        <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-widest">
                            Performance
                        </span>
                        <span className="text-[11px] text-gray-400 ml-auto">Auto unless you set it</span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        {/* Derived from LOA and hull type, but OVERRIDABLE: the
                            formulas are a starting guess and the skipper knows
                            the boat. A stored positive value wins in every
                            consumer (see vesselCruisingSpeedKts /
                            vesselMaxWaveHeightFt); storing 0 means "absent", so
                            Reset hands the figure back to the formula. */}
                        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                            <div>
                                <MetricInput
                                    label="Cruising Speed"
                                    valInStandard={
                                        Number(vessel?.cruisingSpeed) > 0 ? Number(vessel?.cruisingSpeed) : 0
                                    }
                                    standardUnit="kts"
                                    // Knots only, deliberately. VesselDimensionUnits has no
                                    // speed member, and adding one would ripple through the
                                    // settings store and the fleet profile that owns vessel
                                    // data — for a figure every skipper already thinks about
                                    // in knots.
                                    unitType="kts"
                                    unitOptions={['kts']}
                                    onChangeValue={(v) => updateVessel('cruisingSpeed', v)}
                                    onChangeUnit={() => {}}
                                    placeholder={String(Math.round(vesselCruisingSpeedKts(vessel) * 10) / 10)}
                                />
                                {Number(vessel?.cruisingSpeed) > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => updateVessel('cruisingSpeed', 0)}
                                        className="mt-1.5 text-[11px] font-bold text-sky-400 hover:text-sky-300"
                                    >
                                        ↻ Reset to auto (
                                        {Math.round(vesselCruisingSpeedKts({ ...vessel, cruisingSpeed: 0 }) * 10) / 10}{' '}
                                        kts)
                                    </button>
                                )}
                            </div>
                            <div>
                                <MetricInput
                                    label="Max Wave Height"
                                    valInStandard={
                                        Number(vessel?.maxWaveHeight) > 0 ? Number(vessel?.maxWaveHeight) : 0
                                    }
                                    standardUnit="ft"
                                    unitType={settings.vesselUnits?.length || 'ft'}
                                    unitOptions={['ft', 'm']}
                                    onChangeValue={(v) => updateVessel('maxWaveHeight', v)}
                                    onChangeUnit={(u) => updateVesselUnits({ length: u as LengthUnit })}
                                    placeholder={String(Math.round(vesselMaxWaveHeightFt(vessel) * 10) / 10)}
                                />
                                {Number(vessel?.maxWaveHeight) > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => updateVessel('maxWaveHeight', 0)}
                                        className="mt-1.5 text-[11px] font-bold text-sky-400 hover:text-sky-300"
                                    >
                                        ↻ Reset to auto (
                                        {Math.round(vesselMaxWaveHeightFt({ ...vessel, maxWaveHeight: 0 }) * 10) / 10}{' '}
                                        ft)
                                    </button>
                                )}
                            </div>
                        </div>
                        <p className="mt-3 text-[11px] text-gray-400">
                            Started from your length and hull type. Type over either one if you know better — the
                            passage planner, ETAs and tide windows all use what you set here.
                        </p>
                    </div>
                </div>

                {/* Comfort Zone — Safety Parameters */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-red-500" />
                        <span className="text-[11px] font-bold text-red-400 uppercase tracking-widest">
                            Comfort Zone
                        </span>
                        <span className="text-[11px] text-gray-400 ml-auto">Passage Safety Limits</span>
                    </div>
                    <div className="bg-red-500/[0.03] border border-red-500/10 rounded-2xl p-4 space-y-5">
                        <p className="text-[11px] text-gray-400 leading-relaxed">
                            Set your crew's comfort thresholds. The passage planner will route around zones that exceed
                            these limits, treating them as obstacles.
                        </p>

                        {/* Max Wind Speed */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Wind
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxWindKts ?? 60) >= 60 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxWindKts ?? 60) >= 60
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxWindKts} kts`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={10}
                                max={60}
                                step={1}
                                value={settings.comfortParams?.maxWindKts ?? 60}
                                onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    updateComfortParams({ maxWindKts: v >= 60 ? undefined : v });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxWindKts ?? 60) - 10) / 50) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxWindKts ?? 60) - 10) / 50) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                                <span>10 kts</span>
                                <span>25</span>
                                <span>40</span>
                                <span>OFF</span>
                            </div>
                        </div>

                        {/* Max Wave Height */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Wave Height
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxWaveM ?? 8) >= 8 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxWaveM ?? 8) >= 8
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxWaveM?.toFixed(1)} m`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={0.5}
                                max={8}
                                step={0.5}
                                value={settings.comfortParams?.maxWaveM ?? 8}
                                onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    updateComfortParams({ maxWaveM: v >= 8 ? undefined : v });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxWaveM ?? 8) - 0.5) / 7.5) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxWaveM ?? 8) - 0.5) / 7.5) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                                <span>0.5 m</span>
                                <span>2.5</span>
                                <span>5.0</span>
                                <span>OFF</span>
                            </div>
                        </div>

                        {/* Max Gust */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Max Gust
                                </label>
                                <span
                                    className={`text-sm font-bold tabular-nums ${(settings.comfortParams?.maxGustKts ?? 80) >= 80 ? 'text-gray-400' : 'text-red-400'}`}
                                >
                                    {(settings.comfortParams?.maxGustKts ?? 80) >= 80
                                        ? 'OFF'
                                        : `${settings.comfortParams?.maxGustKts} kts`}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={15}
                                max={80}
                                step={1}
                                value={settings.comfortParams?.maxGustKts ?? 80}
                                onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    updateComfortParams({ maxGustKts: v >= 80 ? undefined : v });
                                }}
                                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${(((settings.comfortParams?.maxGustKts ?? 80) - 15) / 65) * 100}%, rgba(255,255,255,0.1) ${(((settings.comfortParams?.maxGustKts ?? 80) - 15) / 65) * 100}%)`,
                                }}
                            />
                            <div className="flex justify-between text-[11px] text-gray-500 mt-1">
                                <span>15 kts</span>
                                <span>35</span>
                                <span>55</span>
                                <span>OFF</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Routing Data Fidelity */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-cyan-500" />
                        <span className="text-[11px] font-bold text-cyan-400 uppercase tracking-widest">
                            Routing Data
                        </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        {/* NRT Currents Toggle —
                        OSCAR near-real-time vs monthly climatology in the
                        isochrone router's set/drift advection. NRT is
                        5-day-old but reflects actual eddies/meanders.
                        Climatology is steady-state monthly averages —
                        good enough for most routes. */}
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-white">High-fidelity ocean currents</div>
                                <p className="text-[11px] text-gray-400 mt-0.5">
                                    Use OSCAR near-real-time data (5-day-old, actual eddies) instead of monthly
                                    climatology. Helps on Gulf Stream / Agulhas timing-critical passages.
                                </p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={settings.currentNrtEnabled === true}
                                aria-label="Toggle high-fidelity ocean currents"
                                onClick={() => onSave({ currentNrtEnabled: !settings.currentNrtEnabled })}
                                className={`shrink-0 relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                                    settings.currentNrtEnabled ? 'bg-cyan-500' : 'bg-slate-700'
                                }`}
                            >
                                <span
                                    aria-hidden="true"
                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                        settings.currentNrtEnabled ? 'translate-x-5' : 'translate-x-0'
                                    }`}
                                />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Capacity */}
                <div className="mx-4 mb-4">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-4 rounded-full bg-amber-500" />
                        <span className="text-[11px] font-bold text-amber-400 uppercase tracking-widest">Capacity</span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                            <MetricInput
                                label="Fuel Cap."
                                valInStandard={vessel?.fuelCapacity || 0}
                                standardUnit="gal"
                                unitType={settings.vesselUnits?.volume || 'gal'}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('fuelCapacity', v)}
                                onChangeUnit={(u) => updateVesselUnits({ volume: u as VolumeUnit })}
                                placeholder="0"
                            />
                            <MetricInput
                                label="Water Cap."
                                valInStandard={vessel?.waterCapacity || 0}
                                standardUnit="gal"
                                unitType={settings.vesselUnits?.volume || 'gal'}
                                unitOptions={['gal', 'l']}
                                onChangeValue={(v) => updateVessel('waterCapacity', v)}
                                onChangeUnit={(u) => updateVesselUnits({ volume: u as VolumeUnit })}
                                placeholder="0"
                            />
                        </div>
                        <div className="mt-4">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                                Crew Aboard (incl. Skipper)
                            </label>
                            <input
                                type="number"
                                min="1"
                                max="99"
                                value={vessel?.crewCount || 2}
                                onChange={(e) => updateVessel('crewCount', parseInt(e.target.value) || 2)}
                                placeholder="2"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-medium outline-none transition-colors focus:border-sky-500"
                            />
                            <p className="text-[11px] text-gray-400 mt-1">
                                Used for provisioning and watch scheduling in passage plans
                            </p>
                        </div>
                    </div>
                </div>
            </React.Fragment>
            {/* Save CTA — fixed 8px above the 72px tab bar. In fleet mode this
                is a real cloud flush, not the old cosmetic green state. */}
            <div
                className="fixed left-0 right-0 z-20 px-4"
                style={{
                    bottom: 'calc(72px + 8px + env(safe-area-inset-bottom))',
                }}
            >
                <div className="max-w-2xl mx-auto">
                    <button
                        type="button"
                        aria-label={
                            fleetAvailable ? 'Sync vessel fleet to cloud' : 'Acknowledge locally saved vessel profile'
                        }
                        onClick={() => {
                            void triggerHaptic('medium');
                            if (fleetAvailable) syncFleet();
                            else showSavedConfirmation();
                        }}
                        disabled={
                            fleetAvailable &&
                            (!fleetSurface.syncVesselFleet || fleetBusyAction !== null || syncStatus.busy)
                        }
                        className={`w-full py-3.5 rounded-xl text-sm font-black uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${
                            fleetBusyAction === 'sync' || syncStatus.busy
                                ? 'bg-gradient-to-r from-sky-700 to-cyan-700 text-white shadow-lg shadow-sky-500/20'
                                : saved && (!fleetAvailable || syncStatus.tone !== 'red')
                                  ? 'bg-gradient-to-r from-emerald-600 to-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                  : 'bg-gradient-to-r from-sky-600 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                        }`}
                    >
                        {fleetBusyAction === 'sync' || syncStatus.busy ? (
                            <span className="inline-flex items-center gap-1.5 justify-center">
                                <RefreshIcon className="w-4 h-4 animate-spin" />
                                <span>Syncing Fleet</span>
                            </span>
                        ) : saved ? (
                            <span className="inline-flex items-center gap-1.5 justify-center">
                                <CheckIcon className="w-4 h-4" />
                                <span>{fleetAvailable ? 'Cloud Check Complete' : 'Profile Saved Locally'}</span>
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1.5 justify-center">
                                {fleetAvailable && <RefreshIcon className="w-4 h-4" />}
                                <span>{fleetAvailable ? 'Sync Vessel Fleet' : 'Profile Saved Locally'}</span>
                            </span>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};
