import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiaryPublishModal } from '../components/diary/DiaryPublishModal';
import { RecipeEditor } from '../components/galley/RecipeEditor';
import { GalleyCookingMode } from '../components/passage/GalleyCookingMode';
import type { DiaryEntry } from '../services/DiaryService';
import type { MealPlan } from '../services/MealPlanService';

const serviceMocks = vi.hoisted(() => ({
    createCustomRecipe: vi.fn(),
    startCooking: vi.fn(),
    completeMeal: vi.fn(),
    saveLeftovers: vi.fn(),
    skipMeal: vi.fn(),
    setEntryPublished: vi.fn(),
    getConfig: vi.fn(),
    ensureEnabled: vi.fn(),
    voyageLogPublicUrl: vi.fn(),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    createCustomRecipe: serviceMocks.createCustomRecipe,
}));

vi.mock('../services/MealPlanService', () => ({
    startCooking: serviceMocks.startCooking,
    completeMeal: serviceMocks.completeMeal,
    saveLeftovers: serviceMocks.saveLeftovers,
    skipMeal: serviceMocks.skipMeal,
}));

vi.mock('../services/DiaryService', () => ({
    DiaryService: {
        setEntryPublished: serviceMocks.setEntryPublished,
    },
    MOOD_CONFIG: {
        epic: { emoji: '🌅', label: 'Epic', color: 'text-amber-400' },
        good: { emoji: '⛵', label: 'Good', color: 'text-emerald-400' },
        neutral: { emoji: '🌊', label: 'Neutral', color: 'text-sky-400' },
        rough: { emoji: '💨', label: 'Rough', color: 'text-orange-400' },
        storm: { emoji: '⛈️', label: 'Storm', color: 'text-red-400' },
    },
}));

vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: {
        getConfig: serviceMocks.getConfig,
        ensureEnabled: serviceMocks.ensureEnabled,
    },
    voyageLogPublicUrl: serviceMocks.voyageLogPublicUrl,
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

const meal: MealPlan = {
    id: 'meal-1',
    voyage_id: 'voyage-1',
    recipe_id: 'recipe-1',
    spoonacular_id: null,
    title: 'Sea pasta',
    planned_date: '2026-07-23',
    meal_slot: 'dinner',
    servings_planned: 4,
    ingredients: [],
    status: 'cooking',
    cook_started_at: '2026-07-23T08:00:00.000Z',
    completed_at: null,
    leftovers_saved: false,
    notes: null,
    created_at: '2026-07-23T07:00:00.000Z',
    updated_at: '2026-07-23T08:00:00.000Z',
};

const diaryEntry: DiaryEntry = {
    id: 'entry-1',
    user_id: 'user-1',
    title: 'Crossing the bay',
    body: 'A calm afternoon sail.',
    mood: 'good',
    photos: [],
    audio_url: null,
    latitude: -27.47,
    longitude: 153.03,
    location_name: 'Moreton Bay',
    weather_summary: 'Fine',
    voyage_id: 'voyage-1',
    tags: [],
    is_public: false,
    created_at: '2026-07-23T08:00:00.000Z',
    updated_at: '2026-07-23T08:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.createCustomRecipe.mockResolvedValue({ id: 'recipe-1' });
    serviceMocks.startCooking.mockResolvedValue(true);
    serviceMocks.completeMeal.mockResolvedValue(true);
    serviceMocks.saveLeftovers.mockResolvedValue(true);
    serviceMocks.skipMeal.mockResolvedValue(true);
    serviceMocks.setEntryPublished.mockResolvedValue(true);
    serviceMocks.getConfig.mockResolvedValue(null);
    serviceMocks.ensureEnabled.mockResolvedValue({
        handle: 'captain',
        api_key: 'public-key',
    });
    serviceMocks.voyageLogPublicUrl.mockReturnValue('https://example.test/voyage/captain');
});

afterEach(() => {
    vi.useRealTimers();
});

describe('content workflow dialog accessibility', () => {
    it('contains the recipe editor, closes it with Escape, and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Open recipe editor</button>);
        const opener = screen.getByRole('button', { name: 'Open recipe editor' });
        opener.focus();

        rerender(
            <>
                <button>Open recipe editor</button>
                <RecipeEditor onClose={onClose} onSaved={vi.fn()} />
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: 'NEW RECIPE' });
        const titleInput = screen.getByRole('textbox', { name: 'Recipe Title' });
        expect(dialog).toContainElement(titleInput);
        expect(titleInput).toHaveFocus();
        expect(screen.getByRole('textbox', { name: /Photo URL/ })).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'Recipe creation progress' })).toHaveAttribute(
            'aria-valuenow',
            '1',
        );

        fireEvent.keyDown(titleInput, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open recipe editor</button>);
        expect(opener).toHaveFocus();
    });

    it('gives every recipe step labelled controls and recovers from a failed save', async () => {
        render(<RecipeEditor onClose={vi.fn()} onSaved={vi.fn()} />);

        fireEvent.change(screen.getByRole('textbox', { name: 'Recipe Title' }), {
            target: { value: 'Sea pasta' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 2' }));

        expect(screen.getByRole('button', { name: 'Decrease recipe servings' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Increase recipe servings' })).toBeInTheDocument();
        expect(screen.getByRole('spinbutton', { name: 'Cook Time (minutes)' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Breakfast' }));
        expect(screen.getByRole('button', { name: 'Breakfast' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 3' }));

        expect(screen.getByRole('spinbutton', { name: 'Ingredient 1 amount' })).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Ingredient 1 unit' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Ingredient 1 name' }), {
            target: { value: 'Pasta' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
        expect(screen.getByRole('button', { name: 'Remove ingredient 2' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 4' }));

        expect(screen.getByRole('textbox', { name: 'Cooking Instructions' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 5' }));

        expect(screen.getByRole('button', { name: /Personal/ })).toHaveAttribute('aria-pressed', 'true');
        const community = screen.getByRole('button', { name: /Community/ });
        fireEvent.click(community);
        expect(community).toHaveAttribute('aria-pressed', 'true');

        serviceMocks.createCustomRecipe.mockResolvedValueOnce(null);
        fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('The recipe could not be saved');
        expect(screen.getByRole('dialog', { name: 'NEW RECIPE' })).toHaveAttribute('aria-busy', 'false');
    });

    it('contains cooking mode, supports Escape, and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Open cooking mode</button>);
        const opener = screen.getByRole('button', { name: 'Open cooking mode' });
        opener.focus();

        rerender(
            <>
                <button>Open cooking mode</button>
                <GalleyCookingMode meal={meal} onClose={onClose} onComplete={vi.fn()} />
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: /Cooking Mode/ });
        const close = screen.getByRole('button', { name: 'Close cooking mode' });
        expect(dialog).toContainElement(close);
        expect(close).toHaveFocus();
        expect(screen.getByRole('progressbar', { name: 'Cooking progress' })).toHaveAttribute('aria-valuenow', '0');

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open cooking mode</button>);
        expect(opener).toHaveFocus();
    });

    it('keeps cooking mode open while a start transition is in flight', async () => {
        let resolveStart: ((value: boolean) => void) | undefined;
        serviceMocks.startCooking.mockReturnValue(
            new Promise<boolean>((resolve) => {
                resolveStart = resolve;
            }),
        );
        const onClose = vi.fn();
        render(<GalleyCookingMode meal={{ ...meal, status: 'reserved' }} onClose={onClose} onComplete={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: /Start Cooking/ }));
        const dialog = screen.getByRole('dialog', { name: /Cooking Mode/ });
        expect(dialog).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('button', { name: 'Close cooking mode' })).toBeDisabled();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            resolveStart?.(true);
        });
        expect(dialog).toHaveAttribute('aria-busy', 'false');
        const steps = screen.getAllByRole('button', { name: /^Mark complete:/ });
        expect(steps).toHaveLength(4);
        expect(steps[0]).toHaveFocus();
    });

    it('cancels stale completion timers and hides completion when a cooking step is unchecked', () => {
        vi.useFakeTimers();
        render(<GalleyCookingMode meal={meal} onClose={vi.fn()} onComplete={vi.fn()} />);

        for (const step of screen.getAllByRole('button', { name: /^Mark complete:/ })) {
            fireEvent.click(step);
        }
        fireEvent.click(screen.getAllByRole('button', { name: /^Mark incomplete:/ })[0]);
        act(() => vi.advanceTimersByTime(300));
        expect(screen.queryByText('Ready to Serve')).not.toBeInTheDocument();

        fireEvent.click(screen.getAllByRole('button', { name: /^Mark complete:/ })[0]);
        act(() => vi.advanceTimersByTime(300));
        expect(screen.getByText(/Ready to Serve/)).toBeInTheDocument();

        fireEvent.click(screen.getAllByRole('button', { name: /^Mark incomplete:/ })[0]);
        expect(screen.queryByText(/Ready to Serve/)).not.toBeInTheDocument();
    });

    it('blocks cooking-mode dismissal while stores are being updated', async () => {
        vi.useFakeTimers();
        let resolveCompletion: ((value: boolean) => void) | undefined;
        serviceMocks.completeMeal.mockReturnValue(
            new Promise<boolean>((resolve) => {
                resolveCompletion = resolve;
            }),
        );
        const onClose = vi.fn();
        const onComplete = vi.fn();
        render(<GalleyCookingMode meal={meal} onClose={onClose} onComplete={onComplete} />);

        for (const step of screen.getAllByRole('button', { name: /^Mark complete:/ })) {
            fireEvent.click(step);
        }
        act(() => vi.advanceTimersByTime(300));
        fireEvent.click(screen.getByRole('button', { name: /Complete & Subtract from Stores/ }));

        const dialog = screen.getByRole('dialog', { name: /Cooking Mode/ });
        expect(dialog).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('button', { name: 'Close cooking mode' })).toBeDisabled();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            resolveCompletion?.(true);
        });
        expect(onComplete).toHaveBeenCalledOnce();
    });

    it('recovers cooking mode when completing the meal fails', async () => {
        vi.useFakeTimers();
        serviceMocks.completeMeal.mockResolvedValueOnce(null);
        const onComplete = vi.fn();
        render(<GalleyCookingMode meal={meal} onClose={vi.fn()} onComplete={onComplete} />);

        for (const step of screen.getAllByRole('button', { name: /^Mark complete:/ })) {
            fireEvent.click(step);
        }
        act(() => vi.advanceTimersByTime(300));
        fireEvent.click(screen.getByRole('button', { name: /Complete & Subtract from Stores/ }));
        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.getByRole('alert')).toHaveTextContent('The meal could not be completed');
        expect(screen.getByRole('dialog', { name: /Cooking Mode/ })).toHaveAttribute('aria-busy', 'false');
        expect(screen.getByRole('button', { name: 'Close cooking mode' })).toBeEnabled();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('starts diary publishing on the safe action and ignores Escape while publishing', async () => {
        let resolveConfig: ((value: { handle: string; api_key: string }) => void) | undefined;
        serviceMocks.ensureEnabled.mockReturnValue(
            new Promise((resolve) => {
                resolveConfig = resolve;
            }),
        );
        const onClose = vi.fn();
        const { rerender } = render(<button>Open publish checkpoint</button>);
        const opener = screen.getByRole('button', { name: 'Open publish checkpoint' });
        opener.focus();

        rerender(
            <>
                <button>Open publish checkpoint</button>
                <DiaryPublishModal entry={diaryEntry} onClose={onClose} onPublishChange={vi.fn()} />
            </>,
        );

        const safeAction = screen.getByRole('button', { name: 'Keep this entry private' });
        expect(screen.getByRole('dialog', { name: 'Share to your Voyage Log?' })).toContainElement(safeAction);
        expect(safeAction).toHaveFocus();

        fireEvent.click(screen.getByRole('button', { name: 'Publish this entry to your voyage log' }));
        const workingDialog = screen.getByRole('dialog', { name: 'Share to your Voyage Log?' });
        expect(workingDialog).toHaveAttribute('aria-busy', 'true');
        fireEvent.keyDown(workingDialog, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            resolveConfig?.({ handle: 'captain', api_key: 'public-key' });
        });

        const done = await screen.findByRole('button', { name: 'Done' });
        expect(screen.getByRole('dialog', { name: 'Published to your Voyage Log' })).toContainElement(done);
        expect(done).toHaveFocus();
        fireEvent.keyDown(done, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open publish checkpoint</button>);
        expect(opener).toHaveFocus();
    });

    it('does not claim a diary entry was published when the publish update fails', async () => {
        serviceMocks.setEntryPublished.mockResolvedValueOnce(false);
        const onPublishChange = vi.fn();
        render(<DiaryPublishModal entry={diaryEntry} onClose={vi.fn()} onPublishChange={onPublishChange} />);

        fireEvent.click(screen.getByRole('button', { name: 'Publish this entry to your voyage log' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('This entry could not be published');
        expect(screen.getByRole('dialog', { name: 'Share to your Voyage Log?' })).toHaveAttribute('aria-busy', 'false');
        expect(onPublishChange).not.toHaveBeenCalled();
        expect(screen.queryByRole('heading', { name: 'Published to your Voyage Log' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Keep this entry private' })).toHaveFocus();
    });
});
