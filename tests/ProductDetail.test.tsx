import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreOneProduct } from '../data/storeOne.products';
import type { ChandleryCategory, ChandlerySubcategory } from '../data/chandleryCategories';

const addToBasket = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/ChandleryBasketService', () => ({
    addToBasket: (...args: unknown[]) => addToBasket(...args),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel: null } }),
}));

import { ProductDetail } from '../components/chandlery/ProductDetail';

const products: StoreOneProduct[] = [
    {
        id: 'first',
        name: 'First Product',
        price: 100,
        description: 'First description',
        specs: ['One'],
        categoryId: 'technology',
        subcategoryId: 'screens',
        requires_12v: false,
    },
    {
        id: 'second',
        name: 'Second Product',
        price: 200,
        description: 'Second description',
        specs: ['Two'],
        categoryId: 'technology',
        subcategoryId: 'screens',
        requires_12v: false,
    },
];

const category: ChandleryCategory = {
    id: 'technology',
    label: 'Technology',
    icon: '⚡',
    blurb: 'Marine technology',
    placeholder: false,
    subcategories: [],
};

const subcategory: ChandlerySubcategory = {
    id: 'screens',
    label: 'Screens',
};

function renderDetail() {
    return render(
        <ProductDetail
            products={products}
            startIndex={0}
            category={category}
            subcategory={subcategory}
            onBack={vi.fn()}
            onOpenBasket={vi.fn()}
            basketCount={0}
        />,
    );
}

describe('ProductDetail basket feedback', () => {
    beforeEach(() => {
        addToBasket.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not carry an added state onto the next product', async () => {
        renderDetail();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add First Product to basket' }));
        });
        expect(screen.getByText('✓ Added to basket')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Next product' }));

        expect(screen.getByRole('heading', { name: 'Second Product' })).toBeInTheDocument();
        expect(screen.queryByText('✓ Added to basket')).not.toBeInTheDocument();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels its feedback timer when unmounted', async () => {
        const { unmount } = renderDetail();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add First Product to basket' }));
        });
        expect(vi.getTimerCount()).toBe(1);

        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shows a recoverable empty state instead of crashing on an empty collection', () => {
        const onBack = vi.fn();
        render(
            <ProductDetail
                products={[]}
                startIndex={0}
                category={category}
                subcategory={subcategory}
                onBack={onBack}
                onOpenBasket={vi.fn()}
                basketCount={0}
            />,
        );

        expect(screen.getByRole('status')).toHaveTextContent('No products available');
        fireEvent.click(screen.getByRole('button', { name: 'Back to Screens' }));
        expect(onBack).toHaveBeenCalledOnce();
    });
});
