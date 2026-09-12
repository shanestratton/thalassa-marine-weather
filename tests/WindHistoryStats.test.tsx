import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { WindHistoryStats } from '../components/nmea/WindHistoryStats';
import type { WindHistorySummary } from '../utils/windHistory';

const now = Date.parse('2026-09-10T03:00:00Z');
const history: WindHistorySummary = {
    asOf: now,
    since: now - 3_500_000,
    latestAt: now,
    sampleCount: 700,
    source: 'boat wind',
    max1h: { kts: 31, at: now - 3_000_000 },
    gust10m: { kts: 19, at: now - 300_000 },
};

describe('wind history cards', () => {
    it('shows the already-recorded hour and ten-minute peak immediately, including after remount', () => {
        const props = { apparentWind: 12, history, onShowDetails: vi.fn() };
        const first = render(<WindHistoryStats {...props} />);
        expect(screen.getByText('31.0')).toBeInTheDocument();
        expect(screen.getByText('19.0')).toBeInTheDocument();
        first.unmount();
        render(<WindHistoryStats {...props} />);
        expect(screen.getByText('31.0')).toBeInTheDocument();
        expect(screen.getByText('19.0')).toBeInTheDocument();
        expect(screen.getByText('Max · 1h')).toBeInTheDocument();
        expect(screen.getByText('Gust 10m')).toBeInTheDocument();
    });

    it('does not invent calm wind when no preceding readings exist', () => {
        render(<WindHistoryStats apparentWind={null} history={null} onShowDetails={vi.fn()} />);
        expect(screen.getAllByText('—')).toHaveLength(3);
        expect(screen.queryByText('0.0')).not.toBeInTheDocument();
    });

    it('shows recorded zero and opens the existing explanation without adding another row', () => {
        const onShowDetails = vi.fn();
        const zero = { ...history, max1h: { kts: 0, at: now }, gust10m: { kts: 0, at: now } };
        render(<WindHistoryStats apparentWind={0} history={zero} onShowDetails={onShowDetails} />);
        expect(screen.getAllByText('0.0')).toHaveLength(3);
        fireEvent.click(screen.getByRole('button', { name: /Maximum recorded/ }));
        fireEvent.click(screen.getByRole('button', { name: /Highest recorded/ }));
        expect(onShowDetails).toHaveBeenCalledTimes(2);
    });

    it('the instrument page reads the shared clock-aged record, not a page-lifetime maximum', () => {
        const page = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');
        expect(page).toContain('NmeaStore.getWindHistory(nowMs)');
        expect(page).toContain('windHistory?.gust10m?.kts ?? null');
        expect(page).toContain('history={windHistory}');
        expect(page).not.toContain('gustRef');
        expect(page).not.toContain('setTwsMax');
    });
});
