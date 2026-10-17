import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelComparisonMatrix } from '../components/dashboard/ModelComparisonMatrix';
import { queryModelSpread } from '../services/weather/ModelSpreadService';

vi.mock('../services/weather/ModelSpreadService', () => ({ queryModelSpread: vi.fn() }));
vi.mock('../stores/LocationStore', () => ({ useLocationCoords: () => ({ lat: -27.47, lon: 153.02 }) }));
vi.mock('../components/dashboard/EnsembleBand', () => ({
    default: ({ latitude, longitude }: { latitude: number; longitude: number }) => (
        <div aria-label="Fictional ensemble panel">{latitude + ', ' + longitude}</div>
    ),
}));

beforeEach(() => {
    vi.mocked(queryModelSpread).mockResolvedValue({ atmos: null, marine: null });
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('model comparison ensemble access', () => {
    it('keeps the optional panel closed until asked, then hides it without refetching the comparison', async () => {
        render(<ModelComparisonMatrix visible onClose={vi.fn()} selectedModel="best_match" />);
        const opener = screen.getByRole('button', { name: 'Ensemble bands · IFS / EC46' });
        expect(opener).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByLabelText('Fictional ensemble panel')).toBeNull();
        expect(screen.getByRole('button', { name: /^Close$/ })).toHaveFocus();

        fireEvent.click(opener);
        expect(await screen.findByLabelText('Fictional ensemble panel')).toHaveTextContent('-27.47, 153.02');
        const hide = screen.getByRole('button', { name: 'Hide ensemble bands' });
        expect(hide).toHaveAttribute('aria-expanded', 'true');
        expect(document.getElementById(hide.getAttribute('aria-controls')!)).toContainElement(
            screen.getByLabelText('Fictional ensemble panel'),
        );
        fireEvent.click(hide);
        expect(screen.queryByLabelText('Fictional ensemble panel')).toBeNull();
        expect(screen.getByRole('button', { name: 'Ensemble bands · IFS / EC46' })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        expect(queryModelSpread).toHaveBeenCalledTimes(1);
    });

    it('reopens the comparison with the optional panel closed and Close focused', async () => {
        const view = render(<ModelComparisonMatrix visible onClose={vi.fn()} selectedModel="best_match" />);
        fireEvent.click(screen.getByRole('button', { name: 'Ensemble bands · IFS / EC46' }));
        await screen.findByLabelText('Fictional ensemble panel');
        view.rerender(<ModelComparisonMatrix visible={false} onClose={vi.fn()} selectedModel="best_match" />);
        expect(screen.queryByRole('dialog', { name: 'Model Convergence' })).toBeNull();
        view.rerender(<ModelComparisonMatrix visible onClose={vi.fn()} selectedModel="best_match" />);
        expect(screen.queryByLabelText('Fictional ensemble panel')).toBeNull();
        expect(screen.getByRole('button', { name: 'Ensemble bands · IFS / EC46' })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        expect(screen.getByRole('button', { name: /^Close$/ })).toHaveFocus();
    });
});
