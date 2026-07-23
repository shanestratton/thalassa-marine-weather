import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ExportSheet } from '../pages/log/ExportSheet';
import { ImportSheet } from '../pages/log/ImportSheet';
import { ShareFormSheet } from '../pages/log/ShareFormSheet';
import { ShareSheet } from '../pages/log/ShareSheet';
import { StatsSheet } from '../pages/log/StatsSheet';

interface SheetCase {
    name: string;
    dialogName: string;
    renderSheet: (onClose: () => void) => ReactNode;
}

const sheetCases: SheetCase[] = [
    {
        name: 'export',
        dialogName: 'Export Voyage',
        renderSheet: (onClose) => (
            <ExportSheet
                onClose={onClose}
                selectedVoyageId={null}
                hasNonDeviceEntries={false}
                onExportPDF={vi.fn().mockResolvedValue(undefined)}
                onExportGPX={vi.fn().mockResolvedValue(undefined)}
            />
        ),
    },
    {
        name: 'import',
        dialogName: 'Import Tracks',
        renderSheet: (onClose) => (
            <ImportSheet
                onClose={onClose}
                onImportGPXFile={vi.fn().mockResolvedValue(undefined)}
                onShowCommunityBrowser={vi.fn()}
                onImportComplete={vi.fn()}
            />
        ),
    },
    {
        name: 'community share form',
        dialogName: 'Community Share',
        renderSheet: (onClose) => (
            <ShareFormSheet
                onClose={onClose}
                onBack={vi.fn()}
                onShowCommunityBrowser={vi.fn()}
                onShareToCommunity={vi.fn()}
                shareAutoTitle="Moreton Bay"
                shareAutoRegion="QLD, Australia"
            />
        ),
    },
    {
        name: 'share',
        dialogName: 'Share',
        renderSheet: (onClose) => (
            <ShareSheet
                onClose={onClose}
                onShowShareForm={vi.fn()}
                onShowCommunityBrowser={vi.fn()}
                onShareImage={vi.fn()}
                hasNonDeviceEntries={false}
                selectedVoyageId={null}
            />
        ),
    },
    {
        name: 'statistics',
        dialogName: 'Voyage Statistics',
        renderSheet: (onClose) => (
            <StatsSheet
                onClose={onClose}
                onSelectVoyage={vi.fn()}
                onShowStats={vi.fn()}
                entries={[]}
                selectedVoyageId={null}
                currentVoyageId={null}
                voyageGroups={[]}
            />
        ),
    },
];

describe.each(sheetCases)('$name log action sheet accessibility', ({ dialogName, renderSheet }) => {
    it('contains focus, closes with Escape, and restores the opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Open sheet</button>);
        const opener = screen.getByRole('button', { name: 'Open sheet' });
        opener.focus();

        rerender(
            <>
                <button>Open sheet</button>
                {renderSheet(onClose)}
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: dialogName });
        const close = within(dialog).getByRole('button', { name: 'Close' });
        expect(dialog).toHaveAttribute('data-overlay-layer', 'modal');
        expect(dialog.parentElement).toBe(document.body);
        expect(dialog.style.zIndex).toBe('1100');
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open sheet</button>);
        expect(screen.getByRole('button', { name: 'Open sheet' })).toHaveFocus();
    });
});
