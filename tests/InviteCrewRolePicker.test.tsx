/**
 * InviteCrewModal role picker + 'Create a crew code' (Shane 2026-09-08).
 *
 * The invite is the ONLY way onto a hull someone else has claimed, so a
 * relief or delivery skipper is invited as co-skipper. These tests pin:
 *   - the picker's selection reaches inviteCrew's fourth argument through
 *     CrewManagement.handleInvite, and the default stays the three-argument
 *     deckhand call;
 *   - 'Create a crew code' calls createManifestInvite with the chosen role
 *     and the permissions an email invite would carry MINUS the Instrument
 *     Panel share (redeem_manifest_invite never mirrors it into
 *     shared_registers, so the skipper's roster could not show or manage
 *     it), and shows the code in a panel inside the centred modal — never a
 *     toast — with focus landed on the code so it is read out.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, CrewRole } from '../services/CrewService';
import type { PassageStatus } from '../services/PassagePlanService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    authUserId: 'skipper-1',
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    inviteCrew: vi.fn(),
    createManifestInvite: vi.fn(),
    getMyCrew: vi.fn(),
    getMyInvites: vi.fn(),
    getMyMemberships: vi.fn(),
    removeCrew: vi.fn(),
    disbandGroup: vi.fn(),
    updateCrewPermissions: vi.fn(),
    acceptInvite: vi.fn(),
    declineInvite: vi.fn(),
    leaveVessel: vi.fn(),
    getPassageStatus: vi.fn(),
    getAuthorizedSharedVoyages: vi.fn(),
    getDraftVoyages: vi.fn(),
    getCachedDraftVoyages: vi.fn(),
    createVoyage: vi.fn(),
    updateVoyage: vi.fn(),
    getCachedActiveVoyage: vi.fn(),
    fetchRoutesAndTracks: vi.fn(),
}));

vi.mock('../theme', () => ({
    t: {
        colors: { bg: { base: 'bg-slate-950' } },
        border: { default: 'border border-white/10' },
    },
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
            user: { id: mocks.authUserId, email: `${mocks.authUserId}@example.com` },
            authChecked: true,
        }),
}));

vi.mock('../services/supabase', () => ({ supabase: null }));

// Keep the real constants/helpers (INVITE_REGISTERS, crewInvitePermissions,
// ROLE_DEFAULT_PERMISSIONS) so the modal renders its real register grid and
// the permissions assertion below is computed by the same code the UI uses.
vi.mock('../services/CrewService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/CrewService')>();
    return {
        ...actual,
        inviteCrew: mocks.inviteCrew,
        createManifestInvite: mocks.createManifestInvite,
        getMyCrew: mocks.getMyCrew,
        removeCrew: mocks.removeCrew,
        disbandGroup: mocks.disbandGroup,
        updateCrewPermissions: mocks.updateCrewPermissions,
        getMyInvites: mocks.getMyInvites,
        getMyMemberships: mocks.getMyMemberships,
        acceptInvite: mocks.acceptInvite,
        declineInvite: mocks.declineInvite,
        leaveVessel: mocks.leaveVessel,
    };
});

vi.mock('../services/PassagePlanService', () => {
    const noAccess: PassageStatus = {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    };
    return {
        NO_PASSAGE_ACCESS: noAccess,
        getActivePassageId: () => null,
        getPassageStatus: mocks.getPassageStatus,
        getAuthorizedSharedVoyages: mocks.getAuthorizedSharedVoyages,
        setActivePassage: vi.fn(),
        clearPassagePlan: vi.fn(),
    };
});

vi.mock('../services/VoyageService', () => ({
    getCachedDraftVoyages: mocks.getCachedDraftVoyages,
    getDraftVoyages: mocks.getDraftVoyages,
    createVoyage: mocks.createVoyage,
    updateVoyage: mocks.updateVoyage,
    getCachedActiveVoyage: mocks.getCachedActiveVoyage,
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: mocks.fetchRoutesAndTracks,
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    getSystemUnits: () => ({
        speed: 'kts',
        length: 'm',
        waveHeight: 'm',
        tideHeight: 'm',
        temp: 'C',
        distance: 'nm',
        visibility: 'nm',
        volume: 'l',
    }),
}));

// The email input autofocuses; jsdom has no scrollIntoView.
vi.mock('../utils/keyboardScroll', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/keyboardScroll')>()),
    scrollInputAboveKeyboard: vi.fn(),
}));

vi.mock('../utils/lazyRetry', () => ({
    lazyRetry: () =>
        function MockCastOffPanel() {
            return <div data-testid="cast-off-panel" />;
        },
}));

vi.mock('../components/Toast', () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock('../components/SignInScreen', () => ({
    SignInScreen: () => null,
}));

vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => (
        <header>
            <h1>{title}</h1>
        </header>
    ),
}));

vi.mock('../components/ui/UndoToast', () => ({
    UndoToast: () => null,
}));

// Stand-in for the real centred ModalSheet: everything the modal shows must
// render inside this region, which is how the tests prove the code panel is
// modal content and not a toast.
vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, isOpen, title }: { children: React.ReactNode; isOpen: boolean; title: string }) =>
        isOpen ? <section aria-label={title}>{children}</section> : null,
}));

vi.mock('../components/crew/CrewRoster', () => ({
    CrewRoster: ({ onInviteClick }: { onInviteClick: () => void }) => (
        <section aria-label="My Crew">
            <button type="button" onClick={onInviteClick}>
                Invite crew member
            </button>
        </section>
    ),
}));

vi.mock('../components/crew/ReadinessCardStack', () => ({
    ReadinessCardStack: () => <div data-testid="readiness-stack" />,
}));

vi.mock('../components/Icons', () => {
    const Icon = () => <span aria-hidden="true" />;
    return {
        UsersIcon: Icon,
        CompassIcon: Icon,
        CalendarGridIcon: Icon,
        AnchorIcon: Icon,
        AlertTriangleIcon: Icon,
        SosIcon: Icon,
    };
});

import { CrewManagement } from '../components/CrewManagement';
import { InviteCrewModal, crewCodePermissions } from '../components/crew/InviteCrewModal';
import { crewInvitePermissions } from '../services/CrewService';

const noAccess: PassageStatus = {
    visible: false,
    voyageId: null,
    ownerUserId: null,
    isOwner: false,
    canEditStores: false,
    canViewMeals: false,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
};

/** Minimal controlled host for the modal on its own. */
function ModalHarness({ onRoleChange }: { onRoleChange?: (role: CrewRole) => void }) {
    const [role, setRole] = useState<CrewRole>('deckhand');
    const [email, setEmail] = useState('');
    return (
        <InviteCrewModal
            inviteEmail={email}
            inviteRole={role}
            inviteRegisters={[]}
            inviteLoading={false}
            inviteError={null}
            inviteSuccess={false}
            onEmailChange={setEmail}
            onRoleChange={(next) => {
                onRoleChange?.(next);
                setRole(next);
            }}
            onToggleRegister={vi.fn()}
            onInvite={vi.fn()}
        />
    );
}

const openInviteModal = async () => {
    render(<CrewManagement onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Invite crew member' }));
    return screen.getByRole('region', { name: 'Invite Crew Member' });
};

describe('InviteCrewModal role picker (2026-09-08)', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-1');
        vi.clearAllMocks();
        mocks.inviteCrew.mockResolvedValue({ success: true });
        mocks.createManifestInvite.mockResolvedValue({ success: true, code: 'KX-4821' });
        mocks.getMyCrew.mockResolvedValue([] as CrewMember[]);
        mocks.getMyInvites.mockResolvedValue([]);
        mocks.getMyMemberships.mockResolvedValue([]);
        mocks.getDraftVoyages.mockResolvedValue([]);
        mocks.getCachedDraftVoyages.mockReturnValue([]);
        mocks.createVoyage.mockResolvedValue({ voyage: null, error: 'not configured' });
        mocks.updateVoyage.mockResolvedValue({ voyage: null });
        mocks.getCachedActiveVoyage.mockReturnValue(null);
        mocks.fetchRoutesAndTracks.mockResolvedValue({ routes: [], tracks: [] });
        mocks.getAuthorizedSharedVoyages.mockResolvedValue({ voyages: [], complete: true });
        mocks.getPassageStatus.mockResolvedValue(noAccess);
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('offers Deckhand (default), Navigator, Co-skipper and Punter as a radiogroup', () => {
        const onRoleChange = vi.fn();
        render(<ModalHarness onRoleChange={onRoleChange} />);

        const group = screen.getByRole('radiogroup', { name: 'Role' });
        const radios = within(group).getAllByRole('radio');
        expect(radios.map((radio) => radio.textContent)).toEqual(['Deckhand', 'Navigator', 'Co-skipper', 'Punter']);
        expect(within(group).getByRole('radio', { name: 'Deckhand' })).toHaveAttribute('aria-checked', 'true');

        fireEvent.click(within(group).getByRole('radio', { name: 'Navigator' }));
        expect(onRoleChange).toHaveBeenCalledWith('navigator');
        expect(within(group).getByRole('radio', { name: 'Navigator' })).toHaveAttribute('aria-checked', 'true');
        expect(within(group).getByRole('radio', { name: 'Deckhand' })).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText(/nav, weather and the log/i)).toBeInTheDocument();
    });

    it('names the co-skipper as the relief or delivery skipper', () => {
        render(<ModalHarness />);
        fireEvent.click(screen.getByRole('radio', { name: 'Co-skipper' }));
        expect(screen.getByText(/relief or delivery skipper/i)).toBeInTheDocument();
    });

    it("passes the picked role through CrewManagement.handleInvite as inviteCrew's fourth argument", async () => {
        const modal = await openInviteModal();

        fireEvent.change(within(modal).getByRole('textbox', { name: 'Crew Email Address' }), {
            target: { value: 'mate@example.com' },
        });
        fireEvent.click(within(modal).getByRole('radio', { name: 'Co-skipper' }));
        fireEvent.click(within(modal).getByRole('button', { name: "Share Ship's Stores" }));
        fireEvent.click(within(modal).getByRole('button', { name: 'Send crew invitation' }));

        await waitFor(() =>
            expect(mocks.inviteCrew).toHaveBeenCalledWith('mate@example.com', ['stores'], undefined, 'co-skipper'),
        );
    });

    it('keeps the default deckhand invite as the three-argument call', async () => {
        const modal = await openInviteModal();

        fireEvent.change(within(modal).getByRole('textbox', { name: 'Crew Email Address' }), {
            target: { value: 'mate@example.com' },
        });
        fireEvent.click(within(modal).getByRole('button', { name: "Share Ship's Stores" }));
        fireEvent.click(within(modal).getByRole('button', { name: 'Send crew invitation' }));

        await waitFor(() => expect(mocks.inviteCrew).toHaveBeenCalledTimes(1));
        expect(mocks.inviteCrew.mock.calls[0]).toEqual(['mate@example.com', ['stores'], undefined]);
    });

    it('creates a crew code for the chosen role and shows it in a panel inside the modal, not a toast', async () => {
        const modal = await openInviteModal();

        fireEvent.click(within(modal).getByRole('radio', { name: 'Co-skipper' }));
        fireEvent.click(within(modal).getByRole('button', { name: "Share Ship's Stores" }));
        fireEvent.click(within(modal).getByRole('button', { name: 'Create a crew code' }));

        await waitFor(() =>
            expect(mocks.createManifestInvite).toHaveBeenCalledWith(
                'co-skipper',
                crewCodePermissions('co-skipper', ['stores']),
                undefined,
            ),
        );
        // With no panel ticked the code carries exactly the email grant.
        expect(mocks.createManifestInvite.mock.calls[0][1]).toEqual(crewInvitePermissions('co-skipper', ['stores']));

        // The code lives inside the centred modal's region.
        const region = screen.getByRole('region', { name: 'Invite Crew Member' });
        const panel = await within(region).findByTestId('crew-code-panel');
        expect(within(panel).getByTestId('crew-code')).toHaveTextContent('KX-4821');
        expect(within(panel).getByText(/Crew code · Co-skipper/)).toBeInTheDocument();
        expect(within(panel).getByRole('button', { name: 'Copy crew code' })).toBeInTheDocument();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(mocks.toastError).not.toHaveBeenCalled();
        // The form's button that had focus is gone; focus must land on the
        // code, not fall to <body>, so a screen reader reads it out.
        expect(within(panel).getByTestId('crew-code')).toHaveFocus();

        // Done closes the host modal through CrewManagement's single reset.
        fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Invite Crew Member' })).toBeNull());
    });

    it('reserves the code for a typed email and says so', async () => {
        const modal = await openInviteModal();

        fireEvent.change(within(modal).getByRole('textbox', { name: 'Crew Email Address' }), {
            target: { value: 'Mate@Example.com ' },
        });
        fireEvent.click(within(modal).getByRole('button', { name: 'Create a crew code' }));

        await waitFor(() =>
            expect(mocks.createManifestInvite).toHaveBeenCalledWith(
                'deckhand',
                crewCodePermissions('deckhand', []),
                'Mate@Example.com',
            ),
        );
        const panel = await screen.findByTestId('crew-code-panel');
        expect(within(panel).getByText(/Reserved for Mate@Example.com/)).toBeInTheDocument();
    });

    it('cautions inline that Equipment, R&M and Documents cannot ride a crew code, and still mints it', async () => {
        // redeem_manifest_invite rebuilds shared_registers from the permissions
        // JSONB, which has no flag for these three (20260723100000:233-252).
        // Shore-side, so a caution and not a block — but the skipper has to be
        // told before handing over a code that grants less than they ticked.
        const modal = await openInviteModal();

        expect(within(modal).queryByTestId('crew-code-caution')).toBeNull();
        fireEvent.click(within(modal).getByRole('button', { name: 'Share Equipment' }));
        fireEvent.click(within(modal).getByRole('button', { name: 'Share Documents' }));
        expect(within(modal).getByTestId('crew-code-caution')).toHaveTextContent(
            "A crew code can't carry Equipment and Documents — use Send Invite to share those.",
        );
        // The register the code CAN carry is not named in the caution.
        fireEvent.click(within(modal).getByRole('button', { name: "Share Ship's Stores" }));
        expect(within(modal).getByTestId('crew-code-caution')).not.toHaveTextContent("Ship's Stores");

        fireEvent.click(within(modal).getByRole('button', { name: 'Create a crew code' }));
        await waitFor(() =>
            expect(mocks.createManifestInvite).toHaveBeenCalledWith(
                'deckhand',
                crewCodePermissions('deckhand', ['equipment', 'documents', 'stores']),
                undefined,
            ),
        );
        // The caution travels with the issued code so it is read beside it.
        const panel = await screen.findByTestId('crew-code-panel');
        expect(within(panel).getByTestId('crew-code-caution')).toHaveTextContent("can't carry Equipment and Documents");
    });

    it('never puts the Instrument Panel share on a crew code, and says to use Send Invite for it', async () => {
        // redeem_manifest_invite copies the JSONB but never mirrors
        // can_view_instruments into shared_registers, which is what the
        // skipper's roster chips and Edit Permissions read. A code carrying
        // the flag would show the crew the live panel while the roster said it
        // was not shared — so the code drops it and the modal says so.
        const modal = await openInviteModal();

        fireEvent.click(within(modal).getByRole('radio', { name: 'Co-skipper' }));
        fireEvent.click(within(modal).getByRole('button', { name: 'Share Instrument Panel' }));
        fireEvent.click(within(modal).getByRole('button', { name: "Share Ship's Stores" }));
        expect(within(modal).getByTestId('crew-code-caution')).toHaveTextContent(
            "A crew code can't carry Instrument Panel — use Send Invite to share that.",
        );

        fireEvent.click(within(modal).getByRole('button', { name: 'Create a crew code' }));
        await waitFor(() => expect(mocks.createManifestInvite).toHaveBeenCalledTimes(1));
        const [role, permissions] = mocks.createManifestInvite.mock.calls[0];
        expect(role).toBe('co-skipper');
        expect(permissions.can_view_instruments).toBe(false);
        // Everything else the email invite would grant still rides the code.
        expect(permissions).toEqual({
            ...crewInvitePermissions('co-skipper', ['instruments', 'stores']),
            can_view_instruments: false,
        });
        expect(permissions.can_edit_stores).toBe(true);

        const panel = await screen.findByTestId('crew-code-panel');
        expect(within(panel).getByTestId('crew-code-caution')).toHaveTextContent("can't carry Instrument Panel");
    });

    it('crewCodePermissions is the email grant with the Instrument Panel share stripped', () => {
        expect(crewCodePermissions('co-skipper', ['instruments'])).toEqual({
            ...crewInvitePermissions('co-skipper', ['instruments']),
            can_view_instruments: false,
        });
        // Without the panel ticked the two are identical for every role.
        (['deckhand', 'navigator', 'co-skipper', 'punter'] as const).forEach((role) => {
            expect(crewCodePermissions(role, ['stores', 'passage_checklist'])).toEqual(
                crewInvitePermissions(role, ['stores', 'passage_checklist']),
            );
        });
    });

    it('says a passage register on a code covers every passage, not one', async () => {
        const modal = await openInviteModal();
        fireEvent.click(within(modal).getByRole('button', { name: 'Share Checklist' }));
        expect(within(modal).getByTestId('crew-code-caution')).toHaveTextContent(
            'On a code, Checklist covers every one of your passages, not just the one selected.',
        );
    });

    it('never claims the code grants the same access as the email invite', async () => {
        const modal = await openInviteModal();
        expect(within(modal).queryByText(/same role and access/i)).toBeNull();
        expect(within(modal).getByText(/same role, entered on their Join a Vessel screen/i)).toBeInTheDocument();
    });

    it('shows a failed code as an inline notice and stays on the form', async () => {
        mocks.createManifestInvite.mockResolvedValue({ success: false, error: 'Too many attempts; try again later' });
        const modal = await openInviteModal();

        fireEvent.click(within(modal).getByRole('button', { name: 'Create a crew code' }));

        expect(await within(modal).findByRole('alert')).toHaveTextContent('Too many attempts; try again later');
        expect(screen.queryByTestId('crew-code-panel')).toBeNull();
        expect(within(modal).getByRole('button', { name: 'Send crew invitation' })).toBeInTheDocument();
    });
});
