import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CrewDetailView } from '../components/crew-finder/CrewDetailView';
import { CrewProfileForm } from '../components/crew-finder/CrewProfileForm';
import type { CrewFinderState } from '../hooks/useCrewFinderState';
import type { CrewCard } from '../services/LonelyHeartsService';

/**
 * Intentionally only contains the state fields consumed by CrewProfileForm.
 * Keeping this fixture narrow makes the privacy copy and accessibility contract
 * visible without coupling the test to the implementation's reducer internals.
 */
function profileFormState(
    profile: Record<string, unknown> = {},
    overrides: Partial<CrewFinderState> = {},
): CrewFinderState {
    return {
        editListingType: '',
        editFirstName: '',
        editBio: '',
        editRegion: '',
        editExperience: '',
        editSkills: [],
        editAvailFrom: '',
        editAvailTo: '',
        editVibe: [],
        editLanguages: [],
        editSmoking: '',
        editDrinking: '',
        editPets: '',
        editInterests: [],
        editLocationCity: '',
        editLocationState: '',
        editLocationCountry: '',
        editHasPartner: false,
        editPartnerDetails: '',
        editPhotos: [],
        uploadingPhotoIdx: null,
        photoError: '',
        pendingPhotoIdx: 0,
        kbHeight: 0,
        saving: false,
        saved: false,
        showPreview: false,
        showDeleteConfirm: false,
        deleting: false,
        profile,
        ...overrides,
        // `as unknown as` — deliberate, and the narrowness is the point (see the
        // doc comment above). A direct cast stopped compiling once CrewFinderState
        // grew the fields this fixture omits: TS refuses a cast between types that
        // no longer sufficiently overlap. Widening through `unknown` keeps the
        // fixture honest about being partial instead of forcing it to mirror every
        // reducer field the form never reads.
    } as unknown as CrewFinderState;
}

function renderProfileForm(profile: Record<string, unknown> = {}, overrides: Partial<CrewFinderState> = {}) {
    return render(
        <CrewProfileForm
            state={profileFormState(profile, overrides)}
            dispatch={vi.fn()}
            onSaveProfile={vi.fn()}
            onPhotoUpload={vi.fn()}
            onPhotoRemove={vi.fn()}
            onDeleteProfile={vi.fn()}
            onPauseCrewList={vi.fn()}
            myProfileScrollRef={React.createRef<HTMLDivElement>()}
            fileInputRef={React.createRef<HTMLInputElement>()}
        />,
    );
}

function crewCard(): CrewCard {
    return {
        user_id: 'skipper-1',
        display_name: 'Casey',
        avatar_url: null,
        vessel_name: null,
        home_port: 'Moreton Bay',
        listing_type: 'seeking_crew',
        crew_intents: ['find_crew'],
        first_name: 'Casey',
        photo_url: null,
        gender: null,
        age_range: null,
        has_partner: false,
        partner_details: null,
        skills: [],
        sailing_experience: 'Coastal Cruiser',
        sailing_region: 'Moreton Bay',
        available_from: null,
        available_to: null,
        bio: 'Looking for a capable hand on a coastal passage.',
        vibe: [],
        languages: [],
        smoking: null,
        drinking: null,
        pets: null,
        interests: [],
        last_active: null,
        is_verified: true,
        approval_status: 'approved',
        verification_status: 'verified',
        location_city: 'Brisbane',
        location_state: 'Queensland',
        location_country: 'Australia',
        photos: [],
    };
}

function interactionState(liked = false, messaged = false): CrewFinderState {
    return {
        likedUsers: liked ? new Set(['skipper-1']) : new Set(),
        messagedUsers: messaged ? new Set(['skipper-1']) : new Set(),
    } as CrewFinderState;
}

describe('The Crew List safety-first profile UI', () => {
    it('explains that new profiles are private and exposes the safety status to assistive technology', () => {
        renderProfileForm();

        expect(screen.getByRole('heading', { name: 'The Crew List' })).toBeInTheDocument();
        const privateStatus = screen.getByText(/your profile begins private/i);
        expect(privateStatus.closest('[aria-live="polite"]')).toHaveAttribute('aria-live', 'polite');
        expect(screen.getByText(/never a public live-location feed/i)).toBeInTheDocument();
        expect(
            screen.getByText(/never publishes a live position, vessel track or contact details/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/introductions are mutual before private chat/i)).toBeInTheDocument();
    });

    it('uses accessible intent choices and requires a primary headshot before review', () => {
        renderProfileForm();

        expect(screen.getByRole('button', { name: /find crew: i have a vessel or passage/i })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        expect(screen.getByRole('button', { name: /find a skipper: i am looking for a berth/i })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        expect(screen.getByRole('button', { name: 'Add required primary headshot' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
        expect(
            screen.getByText(/still needed: crew list intent, first name, clear primary headshot/i),
        ).toBeInTheDocument();
    });

    it('gives every profile choice a distinct name and selected state', () => {
        renderProfileForm({}, { editListingType: 'seeking_berth' });

        expect(screen.queryByRole('button', { name: 'Edit item details' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Select experience level/i })[0]).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        expect(screen.getAllByRole('button', { name: /Add skill/i })[0]).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getAllByRole('button', { name: /Add sailing style/i })[0]).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        expect(screen.getAllByRole('button', { name: /Add language/i })[0]).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getAllByRole('button', { name: /Select smoking preference/i })[0]).toHaveAttribute(
            'aria-pressed',
            'false',
        );
    });

    it('claims a live profile only when approval, verification, visibility, and account checks all pass', () => {
        const { rerender } = renderProfileForm({
            user_id: 'sailor-1',
            approval_status: 'approved',
            verification_status: 'pending',
            crew_list_visibility: 'private',
        });

        expect(screen.getByText(/updated profile needs a closer look/i)).toBeInTheDocument();
        expect(screen.queryByText(/live on the crew list/i)).not.toBeInTheDocument();

        rerender(
            <CrewProfileForm
                state={profileFormState({
                    user_id: 'sailor-1',
                    approval_status: 'approved',
                    verification_status: 'verified',
                    crew_list_visibility: 'private',
                })}
                dispatch={vi.fn()}
                onSaveProfile={vi.fn()}
                onPhotoUpload={vi.fn()}
                onPhotoRemove={vi.fn()}
                onDeleteProfile={vi.fn()}
                onPauseCrewList={vi.fn()}
                myProfileScrollRef={React.createRef<HTMLDivElement>()}
                fileInputRef={React.createRef<HTMLInputElement>()}
            />,
        );

        expect(screen.getByText(/profile approved but private/i)).toBeInTheDocument();
        expect(screen.queryByText(/live on the crew list/i)).not.toBeInTheDocument();

        rerender(
            <CrewProfileForm
                state={profileFormState({
                    user_id: 'sailor-1',
                    approval_status: 'approved',
                    verification_status: 'verified',
                    crew_list_visibility: 'visible',
                })}
                dispatch={vi.fn()}
                publicationReady={false}
                publicationState="blocked"
                onSaveProfile={vi.fn()}
                onPhotoUpload={vi.fn()}
                onPhotoRemove={vi.fn()}
                onDeleteProfile={vi.fn()}
                onPauseCrewList={vi.fn()}
                myProfileScrollRef={React.createRef<HTMLDivElement>()}
                fileInputRef={React.createRef<HTMLInputElement>()}
            />,
        );

        expect(screen.getByText(/verify your account email and mobile/i)).toBeInTheDocument();
        expect(screen.queryByText(/live on the crew list/i)).not.toBeInTheDocument();

        rerender(
            <CrewProfileForm
                state={profileFormState({
                    user_id: 'sailor-1',
                    approval_status: 'approved',
                    verification_status: 'verified',
                    crew_list_visibility: 'visible',
                })}
                dispatch={vi.fn()}
                publicationReady
                publicationState="ready"
                onSaveProfile={vi.fn()}
                onPhotoUpload={vi.fn()}
                onPhotoRemove={vi.fn()}
                onDeleteProfile={vi.fn()}
                onPauseCrewList={vi.fn()}
                myProfileScrollRef={React.createRef<HTMLDivElement>()}
                fileInputRef={React.createRef<HTMLInputElement>()}
            />,
        );

        expect(screen.getByText(/live on the crew list/i)).toBeInTheDocument();
    });

    it('does not expose a connection path from an unaccepted introduction', () => {
        const onOpenIntroductions = vi.fn();
        const onLike = vi.fn();
        const card = crewCard();
        render(
            <CrewDetailView
                selectedCard={card}
                state={interactionState()}
                onBack={vi.fn()}
                onLike={onLike}
                onOpenIntroductions={onOpenIntroductions}
                matchedUserIds={new Set()}
                formatDate={(value) => value || ''}
                isOpenEnded={() => false}
            />,
        );

        expect(screen.getByText(/contact details remain private/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /open private chat/i })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Send introduction to Casey' }));
        expect(onLike).toHaveBeenCalledWith(card);
        expect(onOpenIntroductions).not.toHaveBeenCalled();
    });

    it('renders only a broad area even when a stale local card carries a town or precise port', () => {
        const legacyCard = {
            ...crewCard(),
            home_port: 'Manly Harbour',
            location_city: 'Brisbane',
            location_state: 'Queensland',
            location_country: 'Australia',
        };
        render(
            <CrewDetailView
                selectedCard={legacyCard}
                state={interactionState()}
                onBack={vi.fn()}
                onLike={vi.fn()}
                onOpenIntroductions={vi.fn()}
                matchedUserIds={new Set()}
                formatDate={(value) => value || ''}
                isOpenEnded={() => false}
            />,
        );

        expect(screen.getByText('Broad Area')).toBeInTheDocument();
        expect(screen.getByText(/Queensland, Australia/)).toBeInTheDocument();
        expect(screen.queryByText(/Brisbane/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Manly Harbour/i)).not.toBeInTheDocument();
    });

    it('routes an accepted introduction back to the server-gated introduction inbox', () => {
        const onOpenIntroductions = vi.fn();
        render(
            <CrewDetailView
                selectedCard={crewCard()}
                state={interactionState()}
                onBack={vi.fn()}
                onLike={vi.fn()}
                onOpenIntroductions={onOpenIntroductions}
                matchedUserIds={new Set(['skipper-1'])}
                formatDate={(value) => value || ''}
                isOpenEnded={() => false}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'View accepted introduction with Casey' }));
        expect(onOpenIntroductions).toHaveBeenCalledTimes(1);
    });
});
