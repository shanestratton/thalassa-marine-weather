import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const overlayMocks = vi.hoisted(() => ({
    browseCommunityRecipes: vi.fn(),
    saveVoyagePlan: vi.fn(),
    setPage: vi.fn(),
}));

vi.mock('mapbox-gl', () => ({
    default: {
        accessToken: '',
        Map: vi.fn(),
        Marker: vi.fn(),
    },
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ saveVoyagePlan: overlayMocks.saveVoyagePlan }),
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: overlayMocks.setPage }),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../services/GalleyRecipeService', () => ({
    browseCommunityRecipes: overlayMocks.browseCommunityRecipes,
    rateRecipe: vi.fn().mockResolvedValue(true),
    getUserRating: vi.fn().mockResolvedValue(null),
    reportRecipeImage: vi.fn().mockResolvedValue(true),
    bilgeDiveSearch: vi.fn().mockReturnValue([]),
    toggleFavourite: vi.fn().mockReturnValue(false),
    getFavouriteIds: vi.fn().mockReturnValue(new Set()),
    NAUTICAL_TAG_DEFS: [],
    encodeCommunityRecipeShare: vi.fn().mockReturnValue('recipe-token'),
    shareRecipeToScuttlebutt: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/ChatService', () => ({
    ChatService: { getChannels: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../components/chat/CustomRecipeForm', () => ({
    CustomRecipeForm: () => <div>Recipe form</div>,
}));

vi.mock('../components/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

import { CaptainsTable } from '../components/chat/CaptainsTable';
import { ReportModal, TrackDisclaimerModal } from '../components/chat/ChatAttachmentSheets';
import { PinMapViewer } from '../components/chat/PinMapViewer';

const reportingMessage = {
    id: 'message-1',
    channel_id: 'general',
    user_id: 'user-1',
    display_name: 'Deckhand',
    message: 'Unsafe message content',
    is_question: false,
    helpful_count: 0,
    is_pinned: false,
    deleted_at: null,
    created_at: '2026-07-23T00:00:00.000Z',
};

const recipe = {
    id: 1,
    title: 'Storm Stew',
    readyInMinutes: 25,
    servings: 2,
    image: '',
    sourceUrl: '',
    ingredients: [],
    instructions: [],
    supabaseId: 'recipe-1',
    authorName: 'Skipper',
    ratingAvg: 4,
    ratingCount: 3,
    createdAt: '2026-07-23T00:00:00.000Z',
    nauticalTags: [],
    manualTags: [],
};

function expectModalBodyPortal(element: HTMLElement) {
    const portal = element.closest<HTMLElement>('[data-overlay-layer="modal"]');
    expect(portal).not.toBeNull();
    expect(portal?.parentElement).toBe(document.body);
    expect(portal).toHaveStyle({ zIndex: '1100' });
}

describe('chat overlay accessibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', '');
        overlayMocks.browseCommunityRecipes.mockResolvedValue([recipe]);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        document.body.style.overflow = '';
    });

    it('contains report focus, handles Escape, and restores the opener', async () => {
        const onClose = vi.fn();
        const reportProps = {
            reportingMsg: reportingMessage,
            reportSent: false,
            reportReason: 'spam' as const,
            setReportReason: vi.fn(),
            onSubmit: vi.fn(),
            onClose,
        };
        const { rerender } = render(<button>Open report</button>);
        const opener = screen.getByRole('button', { name: 'Open report' });
        opener.focus();

        rerender(
            <>
                <button>Open report</button>
                <ReportModal {...reportProps} />
            </>,
        );
        const cancel = screen.getByRole('button', { name: 'Cancel report' });
        const dialog = screen.getByRole('dialog', { name: 'Report Message' });
        expect(dialog).toContainElement(cancel);
        expectModalBodyPortal(dialog);
        await waitFor(() => expect(cancel).toHaveFocus());

        fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open report</button>);
        expect(opener).toHaveFocus();
    });

    it('moves focus to the report acknowledgement after submission', async () => {
        const props = {
            reportingMsg: reportingMessage,
            reportReason: 'spam' as const,
            setReportReason: vi.fn(),
            onSubmit: vi.fn(),
            onClose: vi.fn(),
        };
        const { rerender } = render(<ReportModal {...props} reportSent={false} />);
        const submit = screen.getByRole('button', { name: 'Submit report' });
        submit.focus();

        rerender(<ReportModal {...props} reportSent />);
        const done = screen.getByRole('button', { name: 'Done' });
        await waitFor(() => expect(done).toHaveFocus());
        expect(screen.getByRole('dialog', { name: 'Report submitted' })).toContainElement(done);
    });

    it('announces report failures and cannot dismiss an in-flight submission', async () => {
        const onClose = vi.fn();
        render(
            <ReportModal
                reportingMsg={reportingMessage}
                reportSent={false}
                reportError="Report not submitted."
                reportSubmitting
                reportReason="spam"
                setReportReason={vi.fn()}
                onSubmit={vi.fn()}
                onClose={onClose}
            />,
        );

        expect(screen.getByRole('alert')).toHaveTextContent('Report not submitted.');
        expect(screen.getByRole('button', { name: 'Submit report' })).toBeDisabled();
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('treats the navigation warning as an alertdialog with a safe initial action', async () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Open shared track</button>);
        const opener = screen.getByRole('button', { name: 'Open shared track' });
        opener.focus();

        rerender(
            <>
                <button>Open shared track</button>
                <TrackDisclaimerModal
                    track={{ trackId: 'track-1', title: 'Island passage' }}
                    onImport={vi.fn()}
                    onClose={onClose}
                />
            </>,
        );
        const cancel = screen.getByRole('button', { name: 'Cancel track import' });
        const dialog = screen.getByRole('alertdialog', { name: 'Navigation Disclaimer' });
        expect(dialog).toContainElement(cancel);
        expectModalBodyPortal(dialog);
        await waitFor(() => expect(cancel).toHaveFocus());

        fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
        rerender(<button>Open shared track</button>);
        expect(opener).toHaveFocus();
    });

    it('contains the portalled pin map, handles Escape, and preserves the prior scroll lock', async () => {
        const onClose = vi.fn();
        document.body.style.overflow = 'clip';
        const { rerender } = render(<button>Open pin map</button>);
        const opener = screen.getByRole('button', { name: 'Open pin map' });
        opener.focus();

        rerender(
            <>
                <button>Open pin map</button>
                <PinMapViewer lat={-27.47} lng={153.03} caption="River anchorage" onClose={onClose} />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close pin drop map' });
        expect(screen.getByRole('dialog', { name: 'River anchorage' })).toContainElement(close);
        await waitFor(() => expect(close).toHaveFocus());
        expect(document.body.style.overflow).toBe('hidden');

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
        rerender(<button>Open pin map</button>);
        expect(opener).toHaveFocus();
        expect(document.body.style.overflow).toBe('clip');
    });

    it('focuses the recipe back action in the fallback-image path and restores its card', async () => {
        render(<CaptainsTable fullPage />);
        const recipeTitle = await screen.findByText('Storm Stew');
        const recipeCard = recipeTitle.closest('button');
        expect(recipeCard).not.toBeNull();
        recipeCard!.focus();
        fireEvent.click(recipeCard!);

        const back = screen.getByRole('button', { name: 'Back to Recipe Library' });
        expect(screen.getByRole('dialog', { name: 'Storm Stew' })).toContainElement(back);
        await waitFor(() => expect(back).toHaveFocus());

        fireEvent.keyDown(back, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Storm Stew' })).not.toBeInTheDocument();
        expect(recipeCard).toHaveFocus();
    });

    it('does not let the secondary recipe close button replace the safe initial target', async () => {
        overlayMocks.browseCommunityRecipes.mockResolvedValue([{ ...recipe, image: 'https://example.com/stew.jpg' }]);
        render(<CaptainsTable fullPage />);
        const recipeTitle = await screen.findByText('Storm Stew');
        fireEvent.click(recipeTitle.closest('button')!);

        const back = screen.getByRole('button', { name: 'Back to Recipe Library' });
        const secondaryClose = screen.getByRole('button', { name: 'Close recipe detail' });
        await waitFor(() => expect(back).toHaveFocus());
        expect(secondaryClose).not.toHaveFocus();
    });
});
