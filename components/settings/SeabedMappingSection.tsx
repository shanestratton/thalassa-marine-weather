/**
 * "Help map the seabed" (Settings → Preferences): the owner's opt-in to log
 * the boat's own soundings for the IHO crowdsourced bathymetry programme.
 *
 * Shane 2026-10-05: "also you should do the bottom mapping as a parallel add
 * in". Phase 1 captures and keeps everything private; nothing is shared until
 * a later version asks again.
 *
 * Rules carried over from FleetSharingSection: turning it OFF is one tap with
 * no friction, and a dead control looks dead (crew, signed out). Turning it
 * ON is one tap too, because the whole explanation sits right above the
 * switch and nothing leaves the owner's account in this phase.
 *
 * The owner's cloud row is the record: on mount the section brings this
 * device into line with it, so a second phone shows what the boat already
 * has. A boat that stopped being the owner's still gets a LIVE switch, so
 * logging can always be turned off.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Toggle } from './SettingsPrimitives';
import { useAuthStore } from '../../stores/authStore';
import {
    loadCachedOwnedVesselFleet,
    loadOwnedVesselFleet,
    type OwnedVesselProfile,
} from '../../services/VesselFleetService';
import { getPairing } from '../../services/PiPairingService';
import {
    cachedSeabedSummary,
    fetchSeabedSummary,
    formatSeabedContribution,
    makeSeabedZone,
    piSeabedStatus,
    pushSeabedToPi,
    readSeabedLocal,
    retireSeabedLocal,
    saveSeabed,
    seabedDeviceId,
    seabedVesselSnapshot,
    subscribeSeabed,
    syncSeabedPlatform,
    type PiSeabedStatus,
    type SeabedContribution,
    type SeabedLocal,
} from '../../services/seabed/SeabedSettingsService';
import { HOME_DEFAULT_RADIUS_M, zoneMinRadiusM, type SeabedZone } from '../../services/seabed/seabedCore';

const RADII = [500, 1000, 2000];
const CHIP = 'min-h-11 rounded-lg border border-white/10 px-3 text-xs font-semibold text-gray-200 disabled:opacity-40';
const CHIP_ON = 'min-h-11 rounded-lg border border-sky-400/60 bg-sky-500/20 px-3 text-xs font-semibold text-sky-100';

/** The capture module, loaded once (lazily: only accounts that switch this on pay for it). */
let capturePromise: Promise<typeof import('../../services/seabed/SeabedPhoneCapture')> | null = null;
const loadCapture = () =>
    (capturePromise ??= import('../../services/seabed/SeabedPhoneCapture').catch((err: unknown) => {
        capturePromise = null; // a failed chunk load is tried again next time
        throw err;
    }));

/** Where she lay when it was switched on: a private place until the skipper says it is home. */
const LYING = 'lying';

/** The active OWNED boat: crew and boat-less accounts get null. */
async function ownedActiveBoat(): Promise<OwnedVesselProfile | null> {
    const pick = (vessels: OwnedVesselProfile[], active: string | null) => vessels.find((v) => v.id === active) ?? null;
    try {
        const fleet = await loadOwnedVesselFleet();
        return pick(fleet.vessels, fleet.activeBoatId);
    } catch {
        const cached = await loadCachedOwnedVesselFleet().catch(() => null);
        return cached ? pick(cached.fleet.vessels, cached.fleet.activeBoatId) : null;
    }
}

/** Where she is lying now, from the boat's own instruments only: the Pi's track, else the bus. */
async function whereSheLies(): Promise<{ lat: number; lon: number } | string> {
    const [{ getPiLastRestingFix }, { boatFix }, { NmeaStore }] = await Promise.all([
        import('../../services/piTrackRecorder'),
        import('../../services/boatPositionChain'),
        import('../../services/NmeaStore'),
    ]);
    const resting = getPairing() ? await getPiLastRestingFix().catch(() => null) : null;
    if (resting) return { lat: resting.lat, lon: resting.lon };
    const fix = await boatFix().catch(() => null);
    if (!fix || (fix.rung !== 'bus' && fix.rung !== 'pi')) return "Can't see the boat's own GPS from here.";
    const sog = NmeaStore.getState().sog;
    if (sog.freshness !== 'live' || sog.value === null)
        return "Can't tell she's lying still. Try with the instruments on.";
    if (sog.value >= 0.5) return 'She needs to be lying still to mark her berth.';
    return { lat: fix.latitude, lon: fix.longitude };
}

export const SeabedMappingSection: React.FC = () => {
    const signedIn = useAuthStore((state) => state.user !== null);
    const [boat, setBoat] = useState<OwnedVesselProfile | null | undefined>(undefined);
    const [local, setLocal] = useState<SeabedLocal | null>(() => readSeabedLocal());
    const [summary, setSummary] = useState<SeabedContribution | null>(() => cachedSeabedSummary());
    const [waiting, setWaiting] = useState<SeabedContribution>({ soundings: 0, trackM: 0 });
    const [phoneFull, setPhoneFull] = useState(false);
    const [pi, setPi] = useState<PiSeabedStatus | 'old' | null>(null);
    const [note, setNote] = useState(() => readSeabedLocal()?.sounderNote ?? '');
    const [message, setMessage] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const piPaired = getPairing() !== null;
    const me = seabedDeviceId();

    useEffect(() => subscribeSeabed(() => setLocal(readSeabedLocal())), []);
    // The note follows the record (a note set on another device arrives with the row).
    const savedNote = local?.sounderNote ?? null;
    useEffect(() => setNote(savedNote ?? ''), [savedNote]);
    useEffect(() => {
        if (!signedIn) return;
        let live = true;
        void ownedActiveBoat().then((b) => live && setBoat(b));
        return () => {
            live = false;
        };
    }, [signedIn]);

    // This device follows the owner's cloud row for the active boat (quiet before the push).
    const boatId = boat?.id;
    useEffect(() => {
        if (!boatId) return;
        let live = true;
        void syncSeabedPlatform({ activeBoatId: boatId }).then(async () => {
            if (!live) return;
            setLocal(readSeabedLocal());
            if (readSeabedLocal()?.enabled) {
                const { startSeabedPhoneCapture } = await loadCapture();
                await startSeabedPhoneCapture();
            }
        });
        return () => {
            live = false;
        };
    }, [boatId]);

    // While the fleet loads, trust this device's own switch; then it must be this boat's.
    const on = !!local?.enabled && (boat === undefined || local.boatId === boat?.id);
    const piLogs = on && local?.captureDeviceId === null;

    const refresh = useCallback(async () => {
        setSummary(await fetchSeabedSummary());
        if (piLogs) {
            const status = await piSeabedStatus();
            setPi(status);
            const held = status && status !== 'old' ? status.pending.rows + (status.parked?.rows ?? 0) : 0;
            setWaiting({ soundings: held, trackM: 0 });
        } else {
            const { phoneSeabedQueue } = await loadCapture();
            const queue = await phoneSeabedQueue();
            setWaiting(queue);
            setPhoneFull(queue.full);
        }
    }, [piLogs]);

    useEffect(() => {
        if (on) void refresh();
    }, [on, refresh]);

    // Logging is on for a boat that is not the owner's active boat any more
    // (released, sold, or no longer in the fleet): the switch stays live, so
    // it can always be turned off from here.
    if (signedIn && boat === null && local?.enabled) {
        const stop = async () => {
            void pushSeabedToPi({ ...local, enabled: false });
            retireSeabedLocal();
            const { stopSeabedPhoneCapture } = await loadCapture();
            await stopSeabedPhoneCapture(true);
        };
        return (
            <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-xs leading-relaxed text-gray-400">
                        Seabed logging is still on for a boat that isn&rsquo;t your active boat any more. Switch it off
                        here to stop it and clear what hasn&rsquo;t been sent.
                    </p>
                    <Toggle checked onChange={(v) => void (v ? undefined : stop())} label="Help map the seabed" />
                </div>
            </div>
        );
    }

    if (!signedIn || boat === null) {
        return (
            <div className="p-4">
                <div className="flex items-start justify-between gap-3 opacity-60">
                    <p className="text-xs leading-relaxed text-gray-400">
                        {signedIn
                            ? 'Your skipper decides this.'
                            : 'Sign in to help map the seabed with your boat’s depth sounder.'}
                    </p>
                    <Toggle checked={false} onChange={() => undefined} label="Help map the seabed" />
                </div>
            </div>
        );
    }

    const vessel = seabedVesselSnapshot(boat?.profile);
    const save = async (change: Parameters<typeof saveSeabed>[1]) => {
        if (!boat) return;
        setMessage(null);
        setLocal(await saveSeabed(boat.id, change, vessel));
    };

    const toggle = async (value: boolean) => {
        if (!boat) return;
        const capture = await loadCapture();
        if (!value) {
            setConfirmDelete(false);
            await save({ enabled: false });
            await capture.stopSeabedPhoneCapture(true);
            return;
        }
        await save({ enabled: true, captureDeviceId: piPaired ? null : me });
        await capture.startSeabedPhoneCapture();
        // Where she is lying now becomes a private place (not yet "home": it may
        // be an anchorage or a marina far from home) when she is lying still.
        const already = readSeabedLocal()?.zones ?? [];
        if (!already.some((z) => z.kind === 'home' || z.id.startsWith(`${LYING}-`)) && already.length < 20) {
            const at = await whereSheLies();
            if (typeof at !== 'string') {
                const lying = makeSeabedZone('marked', at.lat, at.lon, HOME_DEFAULT_RADIUS_M, LYING);
                await save({ zones: [...(readSeabedLocal()?.zones ?? []), lying] });
            }
        }
    };

    const zones = local?.zones ?? [];
    const home = zones.find((z) => z.kind === 'home');
    const lying = zones.find((z) => z.kind === 'marked' && z.id.startsWith(`${LYING}-`));
    const marked = zones.filter((z) => z.kind === 'marked');

    const addHere = async (kind: SeabedZone['kind'], radius?: number) => {
        const at = await whereSheLies();
        if (typeof at === 'string') return setMessage(at);
        const kept = kind === 'home' ? zones.filter((z) => z.kind !== 'home') : zones;
        if (kept.length >= 20) return setMessage('Twenty private places is the most.');
        await save({ zones: [...kept, makeSeabedZone(kind, at.lat, at.lon, radius)] });
    };

    const homeRadius = async (radius: number) => {
        if (!home || radius < zoneMinRadiusM(home)) return;
        // Re-centring would move the jittered spot; only the circle changes, and
        // never below 4/3 of the jitter the centre was made with.
        await save({ zones: zones.map((z) => (z.id === home.id ? { ...z, radius_m: radius } : z)) });
    };

    const lyingIsHome = async () => {
        if (!lying) return;
        await save({ zones: zones.map((z) => (z.id === lying.id ? { ...z, kind: 'home' as const } : z)) });
    };

    const deleteAll = async () => {
        setConfirmDelete(false);
        const { deleteMySoundingsInCloud } = await import('../../services/seabed/SeabedUploader');
        const ok = await deleteMySoundingsInCloud();
        setMessage(
            ok ? 'Your soundings are deleted, and logging is off.' : 'Could not reach Thalassa. Try again when online.',
        );
        if (ok) {
            await save({ enabled: false });
            const { stopSeabedPhoneCapture } = await loadCapture();
            await stopSeabedPhoneCapture(true);
            setSummary({ soundings: 0, trackM: 0 });
        }
    };

    const logger = !on
        ? null
        : piLogs
          ? pi === 'old'
              ? 'Your Pi needs an update before it can log soundings.'
              : pi
                ? pi.full
                    ? 'The Pi’s soundings storage is full. Logging resumes after the next upload.'
                    : 'Logging on your Pi, even when this phone is ashore.'
                : 'Logging on your Pi. It isn’t reachable from here right now.'
          : local?.captureDeviceId === me
            ? phoneFull
                ? 'Soundings storage is full. Logging resumes after the next upload.'
                : 'Logging on this phone while it’s connected to the boat’s instruments.'
            : 'Logging on your other device.';

    return (
        <div className="p-4">
            <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-xs leading-relaxed text-gray-400">
                    Most of the sea floor has never been measured, even close to the coast. Switch this on and your
                    boat&rsquo;s own depth sounder helps chart it: once a second while you&rsquo;re under way, Thalassa
                    records the depth below the transducer with the time and position, on your Pi if you have one,
                    otherwise on this phone while it&rsquo;s connected to the boat&rsquo;s instruments, never from the
                    phone&rsquo;s own GPS. The soundings stay private in your account. Nothing is shared yet: later
                    we&rsquo;ll ask before sending them, under an anonymous boat ID, to the IHO&rsquo;s public seabed
                    database (Seabed 2030), where they may become free for anyone to use. Nothing is kept near your home
                    berth, your private places, or where each trip starts and ends.
                </p>
                <Toggle checked={on} onChange={(v) => void toggle(v)} label="Help map the seabed" />
            </div>

            {on && (
                <div className="mt-3 space-y-3 border-t border-white/6 pt-3">
                    <div>
                        <p className="text-xs font-semibold text-emerald-300">
                            {formatSeabedContribution(summary, waiting)}
                        </p>
                        {logger && <p className="mt-1 text-xs leading-relaxed text-gray-400">{logger}</p>}
                        {!piLogs && local?.captureDeviceId !== me && (
                            <button
                                type="button"
                                className={`${CHIP} mt-2`}
                                onClick={() => void save({ captureDeviceId: piPaired ? null : me })}
                            >
                                {piPaired ? 'Log on your Pi instead' : 'Log on this phone instead'}
                            </button>
                        )}
                    </div>

                    <div>
                        <p className="text-[12px] font-semibold text-gray-200">
                            {home ? `Home berth: set (${home.radius_m / 1000} km)` : 'Set your home berth'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" className={CHIP} onClick={() => void addHere('home', home?.radius_m)}>
                                Add where she is now
                            </button>
                            {!home && lying && (
                                <button type="button" className={CHIP} onClick={() => void lyingIsHome()}>
                                    Make this her home berth
                                </button>
                            )}
                            {home &&
                                RADII.map((r) => (
                                    <button
                                        key={r}
                                        type="button"
                                        aria-pressed={home.radius_m === r}
                                        disabled={r < zoneMinRadiusM(home)}
                                        className={home.radius_m === r ? CHIP_ON : CHIP}
                                        onClick={() => void homeRadius(r)}
                                    >
                                        {r / 1000} km
                                    </button>
                                ))}
                        </div>
                    </div>

                    <div>
                        <p className="text-[12px] font-semibold text-gray-200">Private places ({marked.length})</p>
                        {lying && (
                            <p className="mt-1 text-xs text-gray-400">Private place: where she&rsquo;s lying now</p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" className={CHIP} onClick={() => void addHere('marked')}>
                                Mark where she is now
                            </button>
                            {marked.length > 0 && (
                                <button
                                    type="button"
                                    className={CHIP}
                                    onClick={() => void save({ zones: zones.filter((z) => z.kind === 'home') })}
                                >
                                    Clear private places
                                </button>
                            )}
                        </div>
                    </div>

                    <label className="block">
                        <span className="text-[12px] font-semibold text-gray-200">Sounder (optional)</span>
                        <input
                            className="mt-1 w-full min-h-11 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white"
                            maxLength={120}
                            value={note}
                            placeholder="Make and model, if you know it"
                            onChange={(e) => setNote(e.target.value)}
                            onBlur={() => {
                                // Only a note the skipper changed is saved: leaving the field changes nothing.
                                const next = note.trim() || null;
                                if (next !== savedNote) void save({ sounderNote: next });
                            }}
                        />
                    </label>

                    {message && <p className="text-xs text-amber-300">{message}</p>}

                    {confirmDelete ? (
                        <div className="rounded-xl border border-red-500/30 p-3">
                            <p className="text-xs text-gray-200">
                                Delete every sounding this account has logged, and switch logging off? This can&rsquo;t
                                be undone.
                            </p>
                            <div className="mt-2 flex gap-2">
                                <button
                                    type="button"
                                    className="min-h-11 rounded-lg bg-red-600 px-3 text-xs font-semibold text-white"
                                    onClick={() => void deleteAll()}
                                >
                                    Delete my soundings
                                </button>
                                <button type="button" className={CHIP} onClick={() => setConfirmDelete(false)}>
                                    Keep them
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="min-h-11 text-xs font-semibold text-red-300"
                            onClick={() => setConfirmDelete(true)}
                        >
                            Delete my soundings
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};
