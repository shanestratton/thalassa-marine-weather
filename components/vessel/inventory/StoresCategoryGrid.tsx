import React from 'react';
import { INVENTORY_CATEGORIES, type InventoryCategory } from '../../../types';
import { BinderCategoryGrid } from '../BinderCategoryGrid';
import { storesCategoryIcon } from './categoryIcons';

const CHOICES = INVENTORY_CATEGORIES.map((category) => ({
    id: category,
    label: category,
    Icon: storesCategoryIcon(category),
}));

/** Fifteen categories, three across and five down. Stack the icon above the
 * wrapping label so the same grid stays readable in a narrow phone sheet.
 * The grid every binder sheet now shares (132-B19, BinderCategoryGrid). */
export const StoresCategoryGrid: React.FC<{
    value: InventoryCategory;
    onChange: (category: InventoryCategory) => void;
}> = ({ value, onChange }) => (
    <BinderCategoryGrid label="Store category" choices={CHOICES} value={value} onChange={onChange} />
);
