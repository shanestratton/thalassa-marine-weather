import { readFileSync } from 'node:fs';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CrewListConversation } from '../components/crew-finder/CrewListConversation';
import { CrewMatchesList } from '../components/crew-finder/CrewMatchesList';
import type { CrewListIntroduction } from '../hooks/useCrewFinderState';
import type { CrewCard } from '../services/LonelyHeartsService';

const matchesSource = readFileSync('components/crew-finder/CrewMatchesList.tsx', 'utf8');
const pageSource = readFileSync('components/LonelyHeartsPage.tsx', 'utf8');
const conversationHookSource = readFileSync('hooks/useCrewListConversation.ts', 'utf8');

function crewCard(): CrewCard {
    return {
        user_id: 'casey-1',
        display_name: 'Casey',
        avatar_url: null,
        vessel_name: null,
        home_port: 'Moreton Bay',
        listing_type: 'seeking_crew',
        crew_intents: ['find_crew'],
        first_name: 'Casey',
        photo_url: 'https://example.test/casey.jpg',
        gender: null,
        age_range: null,
        has_partner: false,
        partner_details: null,
        skills: [],
        sailing_experience: 'Coastal Cruiser',
        sailing_region: 'Moreton Bay',
        available_from: null,
        available_to: null,
        bio: 'A capable sailor looking for a thoughtful coastal passage.',
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
        photos: ['https://example.test/casey.jpg'],
    };
}

function acceptedIntroduction(): CrewListIntroduction {
    return {
        request: {
            id: 'intro-casey',
            sender_id: 'casey-1',
            recipient_id: 'skipper-1',
            message: 'Keen to hear about your next passage.',
            status: 'accepted',
            created_at: '2026-07-27T00:00:00.000Z',
            responded_at: '2026-07-27T00:01:00.000Z',
            withdrawn_at: null,
        },
        counterpart: crewCard(),
        direction: 'received',
    };
}

describe('Crew List private-conversation UI boundary', () => {
    it('opens an accepted conversation by introduction object, never through an app-wide DM callback', () => {
        const onOpenConversation = vi.fn();
        const introduction = acceptedIntroduction();

        render(
            <CrewMatchesList
                introductions={[introduction]}
                onOpenConversation={onOpenConversation}
                onRespondIntroduction={vi.fn()}
                onWithdrawIntroduction={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Open private conversation with Casey' }));
        expect(onOpenConversation).toHaveBeenCalledWith(introduction);
    });

    it('has no generic direct-message escape path in the Crew List page, inbox, or conversation hook', () => {
        expect(matchesSource).toContain('onOpenConversation');
        expect(matchesSource).not.toContain('onOpenDM');
        expect(pageSource).toContain('<CrewListConversation');
        expect(pageSource).not.toContain('onOpenDM');
        expect(conversationHookSource).toContain('LonelyHeartsService.getCrewIntroConversation');
        expect(conversationHookSource).toContain('LonelyHeartsService.sendCrewIntroMessage');
        expect(conversationHookSource).not.toMatch(/(?:ChatService|sendDM|chat_direct_messages|DM_TABLE)/i);
    });

    it('disables the composer and clearly explains the safety state when the server no longer authorises it', () => {
        const onSend = vi.fn();
        render(
            <CrewListConversation
                partnerName="Casey"
                messages={[]}
                currentUserId="skipper-1"
                draft="Can you share your number?"
                unavailable
                onDraftChange={vi.fn()}
                onSend={onSend}
                onBack={vi.fn()}
            />,
        );

        expect(screen.getByRole('heading', { name: 'Conversation unavailable' })).toBeInTheDocument();
        expect(screen.getByText(/may have been paused, withdrawn or blocked/i)).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Message Casey' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Send message to Casey' })).toBeDisabled();
        fireEvent.submit(screen.getByRole('textbox', { name: 'Message Casey' }).closest('form')!);
        expect(onSend).not.toHaveBeenCalled();
    });
});
