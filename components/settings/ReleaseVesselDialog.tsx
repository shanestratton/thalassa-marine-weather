/**
 * ReleaseVesselDialog — "Release Serene Summer?"
 *
 * The 2026-09-08 vessel release decision: the only way onto someone else's
 * hull is the invite path, so a skipper who has sold her (or has finished a
 * delivery) needs a way to let go. Releasing archives the boat under the same
 * owner — logbook, tracks and diary stay theirs — while the server cuts crew,
 * the hull's Pi relay, telemetry and the public page, and frees the MMSI.
 *
 * Shape (Shane's standing orders): CENTRED via OverlayPortal + useFocusTrap,
 * role=dialog with aria-labelledby, internal scroll, never a bottom sheet.
 * Cautions, not blocks — the only refusals here are the two shore-side gates
 * the design names (this device is recording a passage; offline) and they
 * arrive as `blockedReason` copy from the store, which owns them. Everything
 * else is advisory: the active-passage line, the queued-diary-on-the-Pi line
 * and the pre-read crew count all fall back to the generic sentence when a
 * read fails, and none of them ever holds the release.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { AlertTriangleIcon } from '../Icons';
import type { ReleaseReason } from '../../services/VesselFleetService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { supabase } from '../../services/supabase';
import { getActiveVoyage, getCachedActiveVoyage } from '../../services/VoyageService';
import { piCache, type PiCacheStatus } from '../../services/PiCacheService';
import { getPairing } from '../../services/PiPairingService';

export interface ReleasePreReads {
    /** Crew memberships on this hull; null when the read failed (generic copy). */
    crewCount: number | null;
    /** An active passage row for this boat — advisory, because Cast Off is advisory. */
    activePassage: boolean;
    /** Diary entries still queued on the paired Pi; null when unreachable or not reported. */
    piQueuedDiaryEntries: number | null;
}

interface ReleaseVesselDialogProps {
    isOpen: boolean;
    boatId: string;
    vesselName: string;
    /** The store's releaseBlockedReason(): tracking/offline copy, or null when release may proceed. */
    blockedReason: string | null;
    busy: boolean;
    /** The store's refusal sentence after a failed attempt — shown inline, never as a toast. */
    errorMessage?: string | null;
    onKeep: () => void;
    onRelease: (reason: ReleaseReason) => void;
}

const REASONS: ReadonlyArray<{ value: ReleaseReason; label: string }> = [
    { value: 'sold', label: "She's been sold" },
    { value: 'delivery_complete', label: 'Delivery finished' },
    { value: 'other', label: 'Something else' },
];

const NO_PRE_READS: ReleasePreReads = { crewCount: null, activePassage: false, piQueuedDiaryEntries: null };

/** A Pi reading older than this is refreshed before the dialog quotes it. */
const PI_STATUS_FRESH_MS = 60_000;
/** Never keep the skipper waiting on an unreachable Pi — quote the cached reading instead. */
const PI_PING_BUDGET_MS = 3_000;

/** releaseFlow step 3 body, with the crew count when the pre-read succeeded. */
export function releaseConsequencesCopy(crewCount: number | null): string {
    const crew = crewCount === null ? 'Your crew lose access' : `Your crew (${crewCount}) lose access`;
    return `Releasing hands her on. ${crew}, her Pi is unpaired from your account, live instruments stop and her public page goes dark. Her MMSI is freed so the next skipper can claim her. Your logbook, tracks and diary stay yours.`;
}

export const ACTIVE_PASSAGE_ADVISORY = 'A passage is still active on this boat.';

/**
 * releaseFlow step 3 advisory. Deleting the relay row makes the Pi's next
 * upload a terminal 401, so anything still queued there is lost — the skipper
 * hears that here, once, and decides.
 */
export function piQueuedDiaryCopy(count: number): string | null {
    if (count <= 0) return null;
    if (count === 1) {
        return '1 diary entry on the Pi has not reached the cloud yet — let her connect to the internet first, or release anyway and it is lost.';
    }
    return `${count} diary entries on the Pi have not reached the cloud yet — let her connect to the internet first, or release anyway and they are lost.`;
}

function normaliseName(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function readCrewCount(boatId: string): Promise<number | null> {
    if (!supabase) return null;
    try {
        // The owner reads their own boat's membership rows under RLS
        // ("Owners manage their boat members"); a head count is the cheapest read.
        const { count, error } = await supabase
            .from('boat_members')
            .select('user_id', { count: 'exact', head: true })
            .eq('boat_id', boatId)
            .eq('role', 'crew');
        if (error || typeof count !== 'number') return null;
        return count;
    } catch {
        return null;
    }
}

function voyageIsOnBoat(voyage: { boat_id?: string | null; status?: string } | null, boatId: string): boolean {
    if (!voyage || voyage.status !== 'active') return false;
    // A legacy passage row without boat_id cannot be told apart from this
    // hull. The line is advisory, so err towards mentioning it.
    return voyage.boat_id == null || voyage.boat_id === boatId;
}

async function readActivePassage(boatId: string): Promise<boolean> {
    try {
        if (voyageIsOnBoat(getCachedActiveVoyage(), boatId)) return true;
        return voyageIsOnBoat(await getActiveVoyage(), boatId);
    } catch {
        return false;
    }
}

async function readPiQueuedDiary(): Promise<number | null> {
    try {
        // releaseFlow step 2 (2026-09-08): read the Pi only "if a Pi is paired
        // and reachable on the LAN". With no pairing there is nothing to read —
        // the pinned transport never reaches /api/admin/status unpinned — and
        // piCache.ping() with no host runs discover(), a LAN hostname sweep
        // that on a hit stores the host and raises the pairing offer. A release
        // dialog must never start that; politeAutoDiscover owns and throttles it.
        if (!getPairing()) return null;
        let status = piCache.getStatus();
        if (Date.now() - status.lastCheck > PI_STATUS_FRESH_MS) {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const budget = new Promise<PiCacheStatus>((resolve) => {
                timer = setTimeout(() => resolve(piCache.getStatus()), PI_PING_BUDGET_MS);
            });
            try {
                status = await Promise.race([piCache.ping(), budget]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        if (!status.reachable || typeof status.diaryRelayQueued !== 'number') return null;
        return status.diaryRelayQueued;
    } catch {
        return null;
    }
}

export const ReleaseVesselDialog: React.FC<ReleaseVesselDialogProps> = ({
    isOpen,
    boatId,
    vesselName,
    blockedReason,
    busy,
    errorMessage = null,
    onKeep,
    onRelease,
}) => {
    const [reason, setReason] = useState<ReleaseReason>('sold');
    const [typedName, setTypedName] = useState('');
    const [preReads, setPreReads] = useState<ReleasePreReads>(NO_PRE_READS);
    const keepRef = useRef<HTMLButtonElement>(null);
    // Focus lands on 'Keep her': a destructive dialog opens on its safe exit.
    const trapRef = useFocusTrap<HTMLDivElement>(isOpen, { initialFocusRef: keepRef, onEscape: onKeep });

    useEffect(() => {
        if (!isOpen) return;
        setReason('sold');
        setTypedName('');
        setPreReads(NO_PRE_READS);
        // Identity fence: a sign-out while the reads are in flight must not
        // paint another account's counts into this dialog.
        const scope = getAuthIdentityScope();
        let cancelled = false;
        void (async () => {
            const [crewCount, activePassage, piQueuedDiaryEntries] = await Promise.all([
                readCrewCount(boatId),
                readActivePassage(boatId),
                readPiQueuedDiary(),
            ]);
            if (cancelled || !isAuthIdentityScopeCurrent(scope)) return;
            setPreReads({ crewCount, activePassage, piQueuedDiaryEntries });
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen, boatId]);

    if (!isOpen) return null;

    // Gate 5 of the design: typing her name is friction for a SALE only.
    const needsTypedName = reason === 'sold';
    const nameMatches = normaliseName(typedName) === normaliseName(vesselName);
    const canRelease = !busy && blockedReason === null && (!needsTypedName || nameMatches);

    const advisories: string[] = [];
    if (preReads.activePassage) advisories.push(ACTIVE_PASSAGE_ADVISORY);
    const piLine = preReads.piQueuedDiaryEntries === null ? null : piQueuedDiaryCopy(preReads.piQueuedDiaryEntries);
    if (piLine) advisories.push(piLine);

    return (
        <OverlayPortal
            className="flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-vessel-title"
            aria-describedby="release-vessel-body"
            ref={trapRef}
        >
            <div className="absolute inset-0 bg-black/60" role="presentation" onClick={busy ? undefined : onKeep} />
            <div
                data-testid="release-vessel-panel"
                className="relative w-full max-w-sm max-h-[80dvh] overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
            >
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20 text-red-300">
                    <AlertTriangleIcon className="h-6 w-6" />
                </div>
                <h2 id="release-vessel-title" className="text-center text-lg font-black text-white">
                    Release {vesselName}?
                </h2>
                <p id="release-vessel-body" className="mt-2 text-center text-[13px] leading-relaxed text-slate-300">
                    {releaseConsequencesCopy(preReads.crewCount)}
                </p>

                {advisories.length > 0 && (
                    <ul role="status" className="mt-3 space-y-2">
                        {advisories.map((line) => (
                            <li
                                key={line}
                                className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-100"
                            >
                                <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                                <span>{line}</span>
                            </li>
                        ))}
                    </ul>
                )}

                <fieldset className="mt-4">
                    <legend className="text-[11px] font-black uppercase tracking-wide text-slate-400">
                        Why is she leaving your fleet?
                    </legend>
                    <div className="mt-2 space-y-1.5">
                        {REASONS.map((option) => {
                            const selected = reason === option.value;
                            return (
                                <label
                                    key={option.value}
                                    className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                                        selected
                                            ? 'border-red-400/40 bg-red-500/10'
                                            : 'border-white/10 bg-white/3 hover:bg-white/6'
                                    }`}
                                >
                                    <input
                                        type="radio"
                                        name="release-reason"
                                        value={option.value}
                                        checked={selected}
                                        disabled={busy}
                                        onChange={() => setReason(option.value)}
                                        className="h-4 w-4 accent-red-500"
                                    />
                                    <span className="text-sm font-medium text-white">{option.label}</span>
                                </label>
                            );
                        })}
                    </div>
                </fieldset>

                {needsTypedName && (
                    <div className="mt-4">
                        <label
                            htmlFor="release-vessel-typed-name"
                            className="mb-1.5 block text-[11px] font-black uppercase tracking-wide text-slate-400"
                        >
                            Type her name to confirm
                        </label>
                        <input
                            id="release-vessel-typed-name"
                            type="text"
                            value={typedName}
                            disabled={busy}
                            onChange={(event) => setTypedName(event.target.value)}
                            placeholder={vesselName}
                            autoComplete="off"
                            autoCapitalize="words"
                            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-medium text-white outline-hidden transition-colors placeholder:text-slate-600 focus:border-red-400/50"
                        />
                    </div>
                )}

                {blockedReason && (
                    <p
                        role="status"
                        className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-100"
                    >
                        {blockedReason}
                    </p>
                )}
                {errorMessage && (
                    <p
                        role="alert"
                        className="mt-3 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-200"
                    >
                        {errorMessage}
                    </p>
                )}

                <div className="mt-5 flex gap-3">
                    <button
                        ref={keepRef}
                        type="button"
                        onClick={onKeep}
                        disabled={busy}
                        className="flex-1 min-h-[44px] rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-bold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Keep her
                    </button>
                    {/* Same destructive styling as ConfirmDialog; the label stays the
                        accessible name while the spinner replaces the text. */}
                    <button
                        type="button"
                        aria-label={busy ? 'Release' : undefined}
                        onClick={() => onRelease(reason)}
                        disabled={!canRelease}
                        className="flex-1 min-h-[44px] rounded-xl bg-linear-to-r from-red-600 to-red-600 py-3 text-sm font-black uppercase tracking-widest text-white shadow-lg shadow-red-500/20 transition-all hover:from-red-500 hover:to-red-500 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy ? (
                            <div className="mx-auto h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        ) : (
                            'Release'
                        )}
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
