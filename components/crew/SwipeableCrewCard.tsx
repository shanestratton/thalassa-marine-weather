/**
 * SwipeableCrewCard — one crew row with swipe-to-reveal Remove (or Leave).
 * Used for both "My Crew" (captain's view) and "Shared With Me" (crew's view).
 *
 * The tier-1 card (Shane 2026-10-06: "the crew and float plan page also needs
 * to be dragged into the 21st century"): the person by NAME where the app
 * knows it (their own float-plan name, else their byline on the boat), their
 * role, the status as a small pill, Edit as a quiet icon button and the shared
 * registers as one grid of line glyphs. An invite nobody has accepted yet has
 * no name to show, so it is titled by its email, as before; with a name the
 * email moves to the subline, so the skipper can still tell who it went to.
 *
 * A declined invite has nothing to edit; its quiet button removes it, so the
 * row can be cleared without the swipe.
 */

import React from 'react';
import { useSwipeable } from '../../hooks/useSwipeable';
import { triggerHaptic } from '../../utils/system';
import { type CrewMember } from '../../services/CrewService';
import { crewRoleLabel } from '../../services/crew/crewVesselView';
import { RegisterChips } from './RegisterChips';
import { AnchorGlyph, PencilGlyph, TrashGlyph } from './crewGlyphs';
import { BreakableEmail } from './BreakableEmail';

export interface SwipeableCrewCardProps {
    member: CrewMember;
    mode: 'captain' | 'crew';
    onDelete: () => void;
    onEdit?: () => void;
    /**
     * The crew member's name, when the app knows it (captain mode, accepted
     * crew): never a phone or an age, only the name.
     */
    displayName?: string | null;
}

const STATUS: Record<string, { label: string; tone: string; note?: string }> = {
    accepted: { label: 'Active', tone: 'crew-pill--active' },
    pending: { label: 'Invited', tone: '', note: 'Waiting for them to accept' },
    declined: { label: 'Declined', tone: 'crew-pill--quiet' },
};

/** Two initials from a name, or the first letter of an email. */
export function crewInitials(name: string | null | undefined, email: string): string {
    const words = (name ?? '')
        .replace(/["“”].*?["“”]/g, ' ')
        .split(/\s+/)
        .filter((word) => /^[\p{L}\p{N}]/u.test(word));
    if (words.length > 0) {
        const first = words[0][0] ?? '';
        const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
        return `${first}${last}`.toUpperCase();
    }
    return (email.trim()[0] ?? '?').toUpperCase();
}

export const SwipeableCrewCard: React.FC<SwipeableCrewCardProps> = ({
    member,
    mode,
    onDelete,
    onEdit,
    displayName,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable({
        onSwipeComplete: () => void triggerHaptic('light'),
    });

    const isCaptain = mode === 'captain';
    const deleteLabel = isCaptain ? 'Remove' : 'Leave';
    const email = isCaptain ? member.crew_email : member.owner_email;
    const name = isCaptain && member.status === 'accepted' ? displayName?.trim() || null : null;
    const status = STATUS[member.status] ?? STATUS.declined;
    // Role · email · note, the email given its own break points.
    const sublineParts: React.ReactNode[] = isCaptain
        ? [
              crewRoleLabel(member.role),
              name ? <BreakableEmail key="email" email={email} /> : null,
              status.note ?? null,
          ].filter((part) => part !== null && part !== '')
        : ["Skipper's Registers"];
    const subline = sublineParts.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]));

    return (
        <div className="relative overflow-hidden rounded-2xl">
            {/* Delete/Leave zone (revealed on swipe) */}
            <button
                type="button"
                aria-label={deleteLabel}
                tabIndex={swipeOffset > 0 ? 0 : -1}
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-2xl transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => {
                    resetSwipe();
                    onDelete();
                }}
            >
                <span className="flex flex-col items-center text-white">
                    <TrashGlyph className="mb-0.5 h-5 w-5" />
                    <span className="text-[11px] font-bold">{deleteLabel}</span>
                </span>
            </button>

            {/* Main card (slides on swipe) — ref attaches native touch listeners */}
            <div
                ref={ref}
                data-testid="crew-member-card"
                className={`crew-card crew-member-card relative p-3.5 transition-transform ${isSwiping ? '' : 'duration-200'}`}
                style={{ transform: `translateX(-${swipeOffset}px)`, touchAction: 'pan-y' }}
            >
                <div className="flex items-start gap-3">
                    <span aria-hidden="true" className="crew-avatar" data-testid="crew-avatar">
                        {isCaptain ? crewInitials(name, email) : <AnchorGlyph />}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <p className="crew-card-title min-w-0 text-white">
                                {name ?? <BreakableEmail email={email} />}
                            </p>
                            {isCaptain && <span className={`crew-pill ${status.tone}`}>{status.label}</span>}
                        </div>
                        <p className="crew-card-sub mt-0.5">{subline}</p>
                    </div>

                    {/* Edit (captain only, non-declined); a declined row's quiet Remove. */}
                    {isCaptain && member.status !== 'declined' && onEdit && (
                        <button
                            type="button"
                            aria-label="Edit crew member details"
                            onClick={onEdit}
                            className="crew-icon-btn"
                        >
                            <span>
                                <PencilGlyph />
                            </span>
                        </button>
                    )}
                    {isCaptain && member.status === 'declined' && (
                        <button
                            type="button"
                            aria-label={`Remove the declined invite for ${email}`}
                            onClick={onDelete}
                            className="crew-icon-btn"
                        >
                            <span>
                                <TrashGlyph />
                            </span>
                        </button>
                    )}
                </div>

                {/* Explanation for crew */}
                {!isCaptain && (
                    <p className="crew-card-sub mt-2.5 font-medium">
                        You have access to the following registers. Any changes you make will update the Skipper's data.
                    </p>
                )}

                {/* Shared registers, one grid */}
                <RegisterChips registers={member.shared_registers} className="mt-3" />

                {/* Swipe hint — subtle */}
                <p className="crew-swipe-hint">← swipe to {deleteLabel.toLowerCase()}</p>
            </div>
        </div>
    );
};
