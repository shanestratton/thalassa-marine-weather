import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StoredRecipe } from '../services/GalleyRecipeService';

const serviceMocks = vi.hoisted(() => ({
    createCustomRecipe: vi.fn(),
    updateCustomRecipe: vi.fn(),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    createCustomRecipe: serviceMocks.createCustomRecipe,
    updateCustomRecipe: serviceMocks.updateCustomRecipe,
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { RecipeEditor } from '../components/galley/RecipeEditor';

describe('RecipeEditor lifecycle', () => {
    it('locks repeated saves while the first persistence request is pending', async () => {
        let resolveSave!: (recipe: StoredRecipe) => void;
        serviceMocks.createCustomRecipe.mockImplementationOnce(
            () =>
                new Promise<StoredRecipe>((resolve) => {
                    resolveSave = resolve;
                }),
        );
        const onClose = vi.fn();
        const onSaved = vi.fn();
        render(<RecipeEditor onClose={onClose} onSaved={onSaved} />);
        const dialog = screen.getByRole('dialog', { name: 'NEW RECIPE' });
        const portal = dialog.closest<HTMLElement>('[data-overlay-layer="modal"]');
        expect(portal?.parentElement).toBe(document.body);
        expect(portal).toHaveStyle({ zIndex: '1100' });

        fireEvent.change(screen.getByRole('textbox', { name: 'Recipe Title' }), {
            target: { value: 'Storm Stew' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 2' }));
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 3' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Ingredient 1 name' }), {
            target: { value: 'Potato' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 4' }));
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 5' }));

        const saveButton = screen.getByRole('button', { name: 'Save recipe' });
        fireEvent.click(saveButton);
        fireEvent.click(saveButton);
        expect(serviceMocks.createCustomRecipe).toHaveBeenCalledOnce();

        await act(async () => {
            resolveSave({
                id: 'recipe-1',
                spoonacular_id: null,
                user_id: null,
                title: 'Storm Stew',
                image_url: '',
                ready_in_minutes: 30,
                servings: 4,
                source_url: '',
                instructions: '',
                ingredients: [],
                is_favorite: false,
                is_custom: true,
                visibility: 'personal',
                tags: [],
                created_at: '2026-07-23T00:00:00.000Z',
                updated_at: '2026-07-23T00:00:00.000Z',
            });
        });

        expect(onSaved).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });
});
