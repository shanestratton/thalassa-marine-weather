/**
 * CrewRoster — My Crew list + Pending Invites + Shared With Me.
 *
 * Extracted from CrewManagement to reduce monolithic component.
 * Handles the captain crew list, invite acceptance, and crew view sections.
 *
 * The tier-1 look (Shane 2026-10-06: "the crew and float plan page also needs
 * to be dragged into the 21st century as well", styles/crew-page.css): each
 * section opens with an uppercase eyebrow and a count pill, Invite crew is the
 * page's emerald primary, and every person is one glass card. Disband Entire
 * Group no longer sits under the list beside the everyday buttons:
 * CrewManagement draws it as a quiet red row at the very foot of the page
 * (CrewDangerRow), with the same confirm dialog.
 */

import React from 'react';
import { type CrewMember } from '../../services/CrewService';
import { SwipeableCrewCard } from './SwipeableCrewCard';
import { BreakableEmail } from './BreakableEmail';
import { RegisterChips } from './RegisterChips';
import { AnchorGlyph, PlusGlyph, UsersGlyph } from './crewGlyphs';
import { ShimmerBlock } from '../ui/ShimmerBlock';

interface CrewRosterProps {
    visibleCrew: CrewMember[];
    pendingInvites: CrewMember[];
    memberships: CrewMember[];
    /** Vessel profile's standing complement (incl. skipper). Shown as the
     *  "N aboard · +M invited" breakdown so the skipper can see exactly
     *  what feeds provisioning, watches and the float plan. */
    standingCrewAboard?: number;
    loading: boolean;
    onSoftDeleteCaptain: (member: CrewMember) => void;
    onSoftDeleteCrew: (member: CrewMember) => void;
    onEditMember: (member: CrewMember) => void;
    onAcceptInvite: (invite: CrewMember) => void;
    onDeclineInvite: (invite: CrewMember) => void;
    /** Opens the captain's invite-crew modal. Rendered inline in the
     *  "My Crew" section header so the action lives with the list it
     *  affects, rather than competing with the page title. */
    onInviteClick: () => void;
    /**
     * Accepted crew's names by crew_user_id (useCrewCardNames): their own
     * float-plan name, else their byline on the boat. Names only.
     */
    crewNames?: Readonly<Record<string, string>>;
    /**
     * 'crewing' (2026-10-03): the account is crew on a skipper's boat, so the
     * page belongs to that boat. Only Pending Invites render here; the boat's
     * own panel replaces Shared with Me, and My Crew is hidden.
     */
    mode?: 'own' | 'crewing';
}

/** An eyebrow row: the section's name, its count, and at most one action. */
const SectionHead: React.FC<{ title: string; count?: React.ReactNode; action?: React.ReactNode }> = ({
    title,
    count,
    action,
}) => (
    <div className="mb-3 flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="crew-eyebrow">{title}</h2>
            {count}
        </div>
        {action}
    </div>
);

export const CrewRoster: React.FC<CrewRosterProps> = ({
    visibleCrew,
    pendingInvites,
    memberships,
    standingCrewAboard,
    loading,
    onSoftDeleteCaptain,
    onSoftDeleteCrew,
    onEditMember,
    onAcceptInvite,
    onDeclineInvite,
    onInviteClick,
    crewNames = {},
    mode = 'own',
}) => {
    if (loading) {
        return (
            <div className="py-6 space-y-3">
                <ShimmerBlock variant="list" rows={3} />
            </div>
        );
    }

    return (
        <>
            {/* ── PENDING INVITES (Crew view) ── */}
            {pendingInvites.length > 0 && (
                <section className="mb-6">
                    <SectionHead
                        title="Pending Invites"
                        count={<span className="crew-pill">{pendingInvites.length}</span>}
                    />

                    <div className="space-y-2">
                        {pendingInvites.map((invite) => (
                            <div key={invite.id} className="crew-card p-3.5">
                                <div className="flex items-start gap-3">
                                    <span aria-hidden="true" className="crew-avatar">
                                        <AnchorGlyph />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                            <p className="crew-card-title min-w-0 text-white">
                                                <BreakableEmail email={invite.owner_email} />
                                            </p>
                                            <span className="crew-pill">Pending</span>
                                        </div>
                                        <p className="crew-card-sub mt-0.5">wants to share registers with you</p>
                                    </div>
                                </div>

                                {/* Shared registers */}
                                <RegisterChips registers={invite.shared_registers} className="mt-3" />

                                {/* Actions */}
                                <div className="mt-3 flex gap-2">
                                    <button
                                        type="button"
                                        aria-label="Accept crew invite request"
                                        onClick={() => onAcceptInvite(invite)}
                                        className="crew-cta flex-1"
                                    >
                                        Accept
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Decline crew invite request"
                                        onClick={() => onDeclineInvite(invite)}
                                        className="crew-quiet flex-1"
                                    >
                                        Decline
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {mode === 'own' && (
                <>
                    {/* ── SHARED WITH ME (Crew view) — swipe to leave ── */}
                    {memberships.length > 0 && (
                        <section className="mb-6">
                            <SectionHead title="Shared with Me" />
                            <div className="space-y-2">
                                {memberships.map((membership) => (
                                    <SwipeableCrewCard
                                        key={membership.id}
                                        member={membership}
                                        mode="crew"
                                        onDelete={() => onSoftDeleteCrew(membership)}
                                    />
                                ))}
                            </div>
                        </section>
                    )}

                    {/* ── MY CREW (Captain view) — swipe to remove ──
                        Empty, it is one compact card; once there is crew, the
                        hint gives way to the cards. */}
                    <section className="mb-5">
                        <SectionHead
                            title="My Crew"
                            count={
                                // Standing complement + invitees, kept separate on
                                // purpose: an invitee isn't a soul on board until
                                // they accept, and this line is what the skipper
                                // checks against provisioning and the float plan.
                                (standingCrewAboard ?? 0) > 0 ? (
                                    <span className="crew-pill">
                                        {standingCrewAboard} aboard
                                        {visibleCrew.length > 0 ? ` · +${visibleCrew.length} invited` : ''}
                                    </span>
                                ) : (
                                    visibleCrew.length > 0 && <span className="crew-pill">{visibleCrew.length}</span>
                                )
                            }
                            action={
                                <button
                                    type="button"
                                    aria-label="Invite crew member"
                                    onClick={onInviteClick}
                                    className="crew-cta"
                                >
                                    <PlusGlyph />
                                    <span>Invite crew</span>
                                </button>
                            }
                        />

                        {visibleCrew.length > 0 ? (
                            <div className="space-y-2 stagger-in">
                                {visibleCrew.map((member) => (
                                    <SwipeableCrewCard
                                        key={member.id}
                                        member={member}
                                        mode="captain"
                                        displayName={member.crew_user_id ? crewNames[member.crew_user_id] : null}
                                        onDelete={() => onSoftDeleteCaptain(member)}
                                        onEdit={member.status !== 'declined' ? () => onEditMember(member) : undefined}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="crew-card flex items-center gap-3 p-3.5">
                                <span aria-hidden="true" className="crew-tile-icon">
                                    <UsersGlyph />
                                </span>
                                <div className="min-w-0">
                                    <p className="text-sm font-bold text-white">No crew yet</p>
                                    <p className="crew-card-sub mt-0.5">
                                        Tap Invite crew to share registers and passage readiness with your crew.
                                    </p>
                                </div>
                            </div>
                        )}
                    </section>
                </>
            )}
        </>
    );
};
