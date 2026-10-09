/**
 * The Edit Access form's shared-register grid (126-B4).
 *
 * Sharing Documents shares the boat's papers, never the crew's passports or
 * IDs, which stay with the skipper (ship_documents read policy,
 * 20261010140000). The Documents toggle says so, and is described by it for
 * VoiceOver. The passage readiness checks are called that, not "Checklist":
 * the Checklists binder itself is never shared.
 *
 * The real form and the real CrewService labels; fictional crew Ana Ribeiro.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CrewMember, SharedRegister } from '../services/CrewService';

vi.mock('../services/supabase', () => ({ supabase: null }));

import { EditCrewAccessForm } from '../components/crewManagement/EditCrewAccessForm';
import { getAuthIdentityScope } from '../services/authIdentityScope';

const ANA = {
    id: 'crew-row-1',
    owner_id: 'skipper-1',
    crew_user_id: 'crew-2',
    crew_email: 'ana.ribeiro@example.com',
    owner_email: 'skipper@example.com',
    role: 'deckhand',
    status: 'accepted',
    shared_registers: ['documents'],
} as unknown as CrewMember;

function Form({ registers }: { registers: SharedRegister[] }) {
    const [editRegisters, setEditRegisters] = React.useState<SharedRegister[]>(registers);
    return (
        <EditCrewAccessForm
            editBoatMemberLoaded={false}
            editPrefix=""
            setEditPrefix={vi.fn()}
            editFirstName=""
            setEditFirstName={vi.fn()}
            editLastName=""
            setEditLastName={vi.fn()}
            editNickname=""
            setEditNickname={vi.fn()}
            editTarget={ANA}
            editRegisters={editRegisters}
            setEditRegisters={setEditRegisters}
            toggleRegister={(register, list, setList) =>
                setList(list.includes(register) ? list.filter((r) => r !== register) : [...list, register])
            }
            handleSavePermissions={vi.fn(async () => undefined)}
            scopeStillOwnsPage={() => true}
            renderScope={getAuthIdentityScope()}
        />
    );
}

describe('Edit Access: what sharing Documents shares', () => {
    it('the Documents toggle says crew IDs stay with the skipper, and is described by it', () => {
        render(<Form registers={['documents']} />);
        const documents = screen.getByRole('button', { name: 'Documents' });
        expect(documents).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('Crew IDs stay with you')).toBeInTheDocument();
        expect(documents).toHaveAccessibleDescription('Crew IDs stay with you');
        // Only Documents carries the note.
        expect(screen.getByRole('button', { name: "Ship's Stores" })).not.toHaveAccessibleDescription();
        expect(screen.getAllByText('Crew IDs stay with you')).toHaveLength(1);

        // Still there, and still describing it, when Documents is not ticked.
        fireEvent.click(documents);
        expect(screen.getByRole('button', { name: 'Documents' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('button', { name: 'Documents' })).toHaveAccessibleDescription('Crew IDs stay with you');
    });

    it("calls the passage readiness checks 'Passage readiness'", () => {
        render(<Form registers={['passage_checklist']} />);
        expect(screen.getByRole('button', { name: 'Passage readiness' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByRole('button', { name: 'Checklist' })).toBeNull();
    });
});
