import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';

/**
 * The two callers that close their own sign-in sheet when the signed-in
 * account changes: the Galley and the Vessel hub's claim card (build 124,
 * package AC). Supabase reports SIGNED_IN before Apple Sign-In's last two
 * steps run, and SIGNED_OUT when a failed step discards the session, so
 * without their guard the sheet closed mid-attempt and the failed step was
 * never shown: "tap, looks signed in, drops out". These render the real
 * callers with the real sheet. The browser lane stands in for the native one:
 * the sheet's attempt handling is the same for both.
 */

const m = vi.hoisted(() => ({ apple: vi.fn() }));

vi.mock('../services/auth/SocialAuthService', () => ({
    APPLE_WEB_SIGN_IN_ENABLED: true,
    signInWithApple: m.apple,
    signInWithAppleOnWeb: m.apple,
}));
vi.mock('../services/auth/googleSignIn', () => ({
    GOOGLE_SIGN_IN_ENABLED: true,
    signInWithGoogle: vi.fn(),
    signInWithGoogleOnWeb: vi.fn(),
}));
vi.mock('../stores/authStore', async () => {
    const { create } = await import('zustand');
    return {
        useAuthStore: create<{ user: User | null; authChecked: boolean }>()(() => ({ user: null, authChecked: true })),
    };
});
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: vi.fn(() => []),
    getMealPlans: vi.fn(() => []),
    getStoresAvailability: vi.fn(() => []),
}));
vi.mock('../services/GalleyRecipeService', () => ({
    getStoredRecipes: vi.fn(() => []),
    createCustomRecipe: vi.fn(),
    updateCustomRecipe: vi.fn(),
}));
vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: vi.fn(() => null),
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
    getVoyageBudget: vi.fn(() => ({ totalSpent: 0, byZone: [] })),
}));
vi.mock('../services/PassagePlanService', () => ({
    NO_PASSAGE_ACCESS: {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    },
    getActivePassageId: vi.fn(() => null),
    getPassageStatus: vi.fn(),
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: vi.fn(() => null) }));
vi.mock('../hooks/usePermissions', () => ({
    usePermissions: () => ({
        loaded: true,
        canEditStores: true,
        canViewGalley: true,
        permissions: { can_view_passage_meals: true },
    }),
}));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/galley/RecipeEditor', () => ({ RecipeEditor: () => null }));
vi.mock('../components/passage/GalleyCookingMode', () => ({ GalleyCookingMode: () => null }));

import { GalleyPage } from '../components/vessel/GalleyPage';
import { SkipperDeviceControl } from '../components/VesselHub';
import { endAppleSignInAttempt } from '../services/auth/appleSignInAttempt';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useAuthStore } from '../stores/authStore';

const SERVER_FAILURE = "Apple Sign-In couldn't finish (server, 502). Try again.";
const sailor = { id: 'sailor-in-brest', identities: [] } as unknown as User;

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Supabase's SIGNED_IN / SIGNED_OUT, as authStore and the identity scope publish them. */
function account(user: User | null) {
    act(() => {
        setAuthIdentityScope(user?.id ?? null);
        useAuthStore.setState({ user });
    });
}

/** The Vessel hub hands its claim card the signed-in user id. */
function ClaimCard() {
    const userId = useAuthStore((s) => s.user?.id ?? null);
    return <SkipperDeviceControl claim={null} authenticatedUserId={userId} updateSettings={vi.fn()} />;
}

const sheet = () => screen.queryByRole('dialog', { name: 'Sign in to Thalassa' });
const appleButton = () => screen.getByRole('button', { name: 'Sign in with Apple' });

const CALLERS = [
    {
        name: 'Galley',
        ui: () => <GalleyPage onBack={vi.fn()} />,
        open: () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })),
    },
    {
        name: 'Vessel hub claim card',
        ui: () => <ClaimCard />,
        open: () => fireEvent.click(screen.getByRole('button', { name: 'Sign in to share position from this phone' })),
    },
];

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    account(null);
    endAppleSignInAttempt(null);
});

describe.each(CALLERS)('$name keeps the sign-in sheet for the whole Apple sign-in', ({ ui, open }) => {
    it('stays open and busy through SIGNED_IN and the discard, then shows the failed step', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(ui());
        open();

        fireEvent.click(appleButton());
        account(sailor);
        expect(sheet()).toBeInTheDocument();
        expect(appleButton()).toHaveTextContent('Signing in…');

        account(null);
        expect(sheet()).toBeInTheDocument();
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        expect(sheet()).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(SERVER_FAILURE);
        expect(appleButton()).toBeEnabled();
    });

    it('closes once every step has finished', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(ui());
        open();

        fireEvent.click(appleButton());
        account(sailor);
        expect(sheet()).toBeInTheDocument();
        await act(async () => attempt.resolve());

        expect(sheet()).not.toBeInTheDocument();
    });

    it('still closes at SIGNED_IN for a sign-in that is not Apple', () => {
        render(ui());
        open();
        expect(sheet()).toBeInTheDocument();

        account(sailor);

        expect(sheet()).not.toBeInTheDocument();
    });
});
