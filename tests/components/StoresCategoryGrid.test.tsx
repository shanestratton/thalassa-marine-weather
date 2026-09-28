import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INVENTORY_CATEGORIES } from '../../types';
import { StoresCategoryGrid } from '../../components/vessel/inventory/StoresCategoryGrid';

describe('Ships Stores category layout', () => {
    it('places all fifteen categories in a three-column, five-row grid', () => {
        render(<StoresCategoryGrid value="Provisions" onChange={vi.fn()} />);
        const grid = screen.getByRole('group', { name: 'Store category' });
        expect(INVENTORY_CATEGORIES).toHaveLength(15);
        expect(grid).toHaveClass('grid', 'grid-cols-3');
        expect(grid).not.toHaveClass('grid-cols-4', 'grid-cols-5');
        expect(within(grid).getAllByRole('button')).toHaveLength(15);
        expect(
            within(grid)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label')),
        ).toEqual(INVENTORY_CATEGORIES);
    });

    it('keeps long category labels visible on narrow sheets and retains touch targets', () => {
        render(<StoresCategoryGrid value="Provisions" onChange={vi.fn()} />);
        for (const button of screen.getAllByRole('button')) {
            expect(button).toHaveClass('min-w-0', 'min-h-[56px]', 'flex-col');
            expect(button.querySelector('span')).toHaveClass('[overflow-wrap:anywhere]', 'text-balance');
            expect(button.querySelector('span')).not.toHaveClass('truncate');
            expect(button.textContent).toBe(button.getAttribute('aria-label'));
        }
        expect(screen.getByRole('button', { name: 'Provisions' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Electrical' })).toBeVisible();
    });

    it('preserves category selection without submitting the surrounding form', () => {
        const change = vi.fn();
        const submit = vi.fn();
        const view = render(
            <form onSubmit={submit}>
                <StoresCategoryGrid value="Provisions" onChange={change} />
            </form>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Electrical' }));
        expect(change).toHaveBeenCalledExactlyOnceWith('Electrical');
        expect(submit).not.toHaveBeenCalled();
        view.rerender(
            <form onSubmit={submit}>
                <StoresCategoryGrid value="Electrical" onChange={change} />
            </form>,
        );
        expect(screen.getByRole('button', { name: 'Electrical' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Provisions' })).toHaveAttribute('aria-pressed', 'false');
    });
});
