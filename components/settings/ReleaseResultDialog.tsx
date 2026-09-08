/**
 * ReleaseResultDialog — what actually happened after 'Release' or 'Undo release'.
 *
 * Part of the 2026-09-08 vessel release decision ("a punter needs a way to
 * release a vessel in case it has been sold, or they were just doing a
 * delivery"). The server reports counts; this dialog turns them into one plain
 * sentence the skipper can read in a second, plus the one amber line that
 * needs their action (a Pi the cloud could not match to the released hull).
 *
 * Centred and focus-trapped, never a bottom sheet, and never a toast: the
 * result is two or more lines and one of them may ask the skipper to do
 * something (Shane's standing orders on dialogs and toasts).
 */
import React, { useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { AlertTriangleIcon, AnchorIcon } from '../Icons';
import type { ReleaseVesselResult, UndoReleaseResult } from '../../services/VesselFleetService';

export type ReleaseOutcome =
    | { kind: 'released'; vesselName: string; result: ReleaseVesselResult }
    | { kind: 'restored'; vesselName: string; result: UndoReleaseResult };

interface ReleaseResultDialogProps {
    outcome: ReleaseOutcome | null;
    onClose: () => void;
}

/** releaseFlow step 7: 'Serene Summer released — 2 crew removed, 1 Pi unpaired, public page off.' */
export function releaseSummaryLine(vesselName: string, result: ReleaseVesselResult): string {
    const page = result.publicPagesDisabled > 0 ? 'public page off' : 'no public page to turn off';
    return `${vesselName} released — ${result.crewRemoved} crew removed, ${result.relaysRemoved} Pi unpaired, ${page}.`;
}

/**
 * releaseFlow step 7, the amber line. Release deletes only the relay rows the
 * cloud matched to this hull; legacy rows with no boat stay paired to the
 * seller until they forget them — this is the one place they are told.
 */
export function unmatchedRelayLine(vesselName: string, relaysUnmatched: number): string | null {
    if (relaysUnmatched <= 0) return null;
    if (relaysUnmatched === 1) {
        return `1 Pi could not be matched to a boat and is still paired to you. If it is aboard ${vesselName}, forget it in Settings > Calypso and she will pair to her new skipper when they are aboard.`;
    }
    return `${relaysUnmatched} Pis could not be matched to a boat and are still paired to you. If one is aboard ${vesselName}, forget it in Settings > Calypso and she will pair to her new skipper when they are aboard.`;
}

/** releaseFlow step 8: what Undo does NOT bring back, said up front. */
export const UNDO_RELEASE_LINE = 'Crew, Pi and public page are not restored — invite, pair and enable them again.';

/** undo_vessel_release returned claim_lost: the buyer claimed the MMSI meanwhile. */
export const UNDO_CLAIM_LOST_LINE =
    'Another Thalassa boat claimed her MMSI while she was released. Your profile keeps the number, but the claim is theirs.';

export const ReleaseResultDialog: React.FC<ReleaseResultDialogProps> = ({ outcome, onClose }) => {
    const doneRef = useRef<HTMLButtonElement>(null);
    const trapRef = useFocusTrap<HTMLDivElement>(outcome !== null, { initialFocusRef: doneRef, onEscape: onClose });

    if (!outcome) return null;

    const title =
        outcome.kind === 'released'
            ? releaseSummaryLine(outcome.vesselName, outcome.result)
            : `${outcome.vesselName} is back in your fleet.`;
    const amberLine =
        outcome.kind === 'released'
            ? unmatchedRelayLine(outcome.vesselName, outcome.result.relaysUnmatched)
            : outcome.result.claimLost
              ? UNDO_CLAIM_LOST_LINE
              : null;
    const detailLines: string[] =
        outcome.kind === 'released'
            ? [
                  outcome.result.remainingActiveBoats === 0
                      ? 'Your fleet is empty now. Your logbook, tracks and diary stay yours; add a vessel whenever you have one.'
                      : 'Your logbook, tracks and diary stay yours.',
                  ...(outcome.result.invitesRevoked > 0
                      ? [
                            `${outcome.result.invitesRevoked} pending crew ${outcome.result.invitesRevoked === 1 ? 'code was' : 'codes were'} revoked so nobody can redeem one against a released boat.`,
                        ]
                      : []),
              ]
            : [UNDO_RELEASE_LINE];

    return (
        <OverlayPortal
            className="flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-result-title"
            ref={trapRef}
        >
            <div className="absolute inset-0 bg-black/60" role="presentation" onClick={onClose} />
            <div
                data-testid="release-result-panel"
                className="relative w-full max-w-sm max-h-[80dvh] overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
            >
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-200">
                    <AnchorIcon className="h-5 w-5" />
                </div>
                <h2 id="release-result-title" className="text-center text-base font-black leading-snug text-white">
                    {title}
                </h2>
                <div className="mt-3 space-y-2">
                    {detailLines.map((line) => (
                        <p key={line} className="text-center text-[12px] leading-relaxed text-slate-300">
                            {line}
                        </p>
                    ))}
                </div>
                {amberLine && (
                    <p
                        role="status"
                        className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 text-left text-[12px] leading-relaxed text-amber-100"
                    >
                        <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                        <span>{amberLine}</span>
                    </p>
                )}
                <button
                    ref={doneRef}
                    type="button"
                    onClick={onClose}
                    className="mt-4 w-full rounded-xl bg-linear-to-r from-sky-600 to-sky-600 py-3 text-sm font-black uppercase tracking-widest text-white shadow-lg shadow-sky-500/20 transition-all hover:from-sky-500 hover:to-sky-500 active:scale-[0.97]"
                >
                    Done
                </button>
            </div>
        </OverlayPortal>
    );
};
