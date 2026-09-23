import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
});
