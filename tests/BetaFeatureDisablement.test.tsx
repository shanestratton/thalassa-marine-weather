import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GalleyMealPlanner } from '../components/passage/GalleyMealPlanner';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

describe('beta feature disablement', () => {
    it('keeps launch-gated integrations off by default', () => {
        expect(FEATURE_VISIBILITY.marketplace).toBe(false);
        expect(FEATURE_VISIBILITY.spoonacular).toBe(false);
    });

    it('shows offline meal ideas without exposing the online generator', () => {
        render(
            <GalleyMealPlanner
                days={3}
                crew={2}
                fallbackContent={<div data-testid="offline-meal-ideas">Offline meal ideas</div>}
            />,
        );

        expect(screen.getByRole('status')).toHaveTextContent(/online recipe generation is disabled/i);
        expect(screen.getByTestId('offline-meal-ideas')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Generate Galley Plan' })).not.toBeInTheDocument();
    });
});
