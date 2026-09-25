import React from 'react';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PassageLogList, groupPassageLogs } from '../pages/log/PassageLogList';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import { PersonalRecordsStrip } from '../pages/log/PersonalRecordsStrip';
import { computePersonalRecords } from '../services/shiplog/VoyageSummary';
const voyage = (id: string, group?: string): VoyageSummary => ({
    voyageId: id,
    passageGroupId: group,
    entryCount: 100,
    startedAt: '2026-09-15T02:28:00Z',
    endedAt: '2026-09-17T00:44:00Z',
    totalDistanceNM: 306,
    avgSpeedKts: 6.8,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: -27,
    firstLon: 153,
    lastLat: -23,
    lastLon: 151,
    firstIsOnWater: true,
    landFraction: 0,
    spanM: 400000,
});
describe('passage log surround', () => {
    it('groups exact passage members at their newest position without dropping standalone voyages', () => {
        const voyages = [
            voyage('third', 'north'),
            voyage('other'),
            voyage('second', 'north'),
            voyage('first', 'north'),
            voyage('another', 'south'),
        ];
        expect(groupPassageLogs(voyages).map((g) => g.voyages.map((v) => v.voyageId))).toEqual([
            ['third', 'second', 'first'],
            ['other'],
            ['another'],
        ]);
        expect(groupPassageLogs([voyage('overnight'), voyage('also-overnight')]).every((g) => !g.passage)).toBe(true);
    });
    it('keeps all three map controls inside one labelled purple surround', () => {
        const onMap = vi.fn();
        render(
            <PassageLogList
                voyages={['third', 'second', 'first'].map((id) => voyage(id, 'north'))}
                renderVoyage={(v) => (
                    <div key={v.voyageId}>
                        <button onClick={() => onMap(v.voyageId)}>Map {v.voyageId}</button>
                    </div>
                )}
            />,
        );
        const group = screen.getByRole('region', { name: 'Passage · 3 legs' });
        expect(group.className).toContain('border-purple');
        expect(within(group).getByRole('heading', { name: 'PASSAGE' }).className).toContain('text-yellow');
        expect(within(group).getAllByRole('button')).toHaveLength(3);
        fireEvent.click(screen.getByRole('button', { name: 'Map second' }));
        expect(onMap).toHaveBeenCalledWith('second');
    });
    it('shows longest in days and hours rather than discarding nearly a whole day', () => {
        render(<PersonalRecordsStrip records={computePersonalRecords([voyage('first')])} />);
        expect(screen.getByText('1d 22h')).toBeInTheDocument();
    });
    it('confirms the exact leg count before archiving the whole group, with cancellation available', async () => {
        const archive = vi.fn().mockResolvedValue(undefined);
        render(
            <PassageLogList
                voyages={[
                    voyage('third', 'north'),
                    voyage('other'),
                    voyage('second', 'north'),
                    voyage('first', 'north'),
                ]}
                renderVoyage={(v) => <div key={v.voyageId}>{v.voyageId}</div>}
                onArchivePassage={archive}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Archive passage' }));
        const confirmation = screen.getByRole('dialog', { name: 'Archive this passage?' });
        expect(confirmation).toHaveTextContent('Move all 3 legs into Archived Voyages. Nothing is deleted');
        expect(archive).not.toHaveBeenCalled();
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Archive passage' }));
        fireEvent.click(screen.getByRole('button', { name: 'Archive 3 legs' }));
        await waitFor(() => expect(archive).toHaveBeenCalledWith('north', ['third', 'second', 'first']));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
    it('does not offer whole-passage archive while one of its legs is protected', () => {
        render(
            <PassageLogList
                voyages={[voyage('recording', 'north'), voyage('completed', 'north')]}
                protectedVoyageIds={['recording']}
                renderVoyage={(v) => <div key={v.voyageId}>{v.voyageId}</div>}
                onArchivePassage={vi.fn()}
            />,
        );
        expect(screen.getByRole('button', { name: 'Archive passage' })).toBeDisabled();
        expect(screen.getByText('End the active voyage to archive this passage.')).toBeVisible();
    });
    it('keeps an open confirmation bound to its original account handler after props change', async () => {
        const originalArchive = vi.fn().mockResolvedValue(undefined);
        const newAccountArchive = vi.fn().mockResolvedValue(undefined);
        const props = {
            voyages: [voyage('same-id', 'same-group')],
            renderVoyage: (v: VoyageSummary) => <div key={v.voyageId}>{v.voyageId}</div>,
        };
        const { rerender } = render(<PassageLogList {...props} onArchivePassage={originalArchive} />);
        fireEvent.click(screen.getByRole('button', { name: 'Archive passage' }));
        rerender(<PassageLogList {...props} onArchivePassage={newAccountArchive} />);
        fireEvent.click(screen.getByRole('button', { name: 'Archive 1 leg' }));
        await waitFor(() => expect(originalArchive).toHaveBeenCalledWith('same-group', ['same-id']));
        expect(newAccountArchive).not.toHaveBeenCalled();
    });
});
