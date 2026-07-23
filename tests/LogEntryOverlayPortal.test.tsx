import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AddEntryModal } from '../components/AddEntryModal';
import { DeleteVoyageModal } from '../components/DeleteVoyageModal';
import { EditEntryModal } from '../components/EditEntryModal';
import type { ShipLogEntry } from '../types';

const entry = {
    id: 'entry-1',
    timestamp: '2026-07-23T08:00:00.000Z',
    entryType: 'manual',
    notes: 'Cleared the harbour',
    positionFormatted: '27°28.2′S 153°01.8′E',
} as ShipLogEntry;

const cases: Array<{ name: string; dialogName: string; element: ReactElement }> = [
    {
        name: 'add-entry modal',
        dialogName: 'Add Log Entry',
        element: <AddEntryModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />,
    },
    {
        name: 'edit-entry modal',
        dialogName: 'Edit Entry',
        element: <EditEntryModal isOpen entry={entry} onClose={vi.fn()} onSave={vi.fn()} />,
    },
    {
        name: 'delete-voyage modal',
        dialogName: 'Delete Voyage?',
        element: (
            <DeleteVoyageModal
                isOpen
                onClose={vi.fn()}
                onExportFirst={vi.fn()}
                onDelete={vi.fn()}
                voyageInfo={{
                    startLocation: 'Brisbane',
                    endLocation: 'Moreton Island',
                    totalDays: 1,
                    totalEntries: 12,
                    totalDistance: 24.5,
                }}
            />
        ),
    },
];

describe.each(cases)('$name overlay layer', ({ dialogName, element }) => {
    it('portals to the document root above app chrome', () => {
        const { container } = render(element);
        const dialog = screen.getByRole('dialog', { name: dialogName });

        expect(container).not.toContainElement(dialog);
        expect(dialog).toHaveAttribute('data-overlay-layer', 'modal');
        expect(dialog.parentElement).toBe(document.body);
        expect(dialog).toHaveClass('fixed', 'inset-0', 'z-[1100]');
        expect(dialog.style.zIndex).toBe('1100');
    });
});
