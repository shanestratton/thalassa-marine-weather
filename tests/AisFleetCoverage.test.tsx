import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { aisCoverageText, publishAisCoverage } from '../services/ais/aisCoverage';
import { AisCoverageNotice } from '../components/map/AisCoverageNotice';
const now = Date.parse('2026-10-16T00:00:00Z');
afterEach(() => {
    cleanup();
    publishAisCoverage(null);
});
describe('truthful informational fleet coverage', () => {
    it('does not equate a recent centre poll to complete200NM coverage', () => {
        expect(
            aisCoverageText({ state: 'recent', polledAt: new Date(now - 120000).toISOString(), truncated: false }, now),
        ).toBe('Map centre polled 2 min ago; surrounding coverage may be sparse');
    });
    it.each(['queued', 'held', 'unavailable'] as const)('reports%s explicitly', (state) => {
        expect(aisCoverageText({ state, polledAt: null, truncated: false }, now)).toMatch(
            /queued|licence review|unavailable/,
        );
    });
    it('reports old or future receipts as stale rather than active coverage', () => {
        for (const time of [now - 900001, now + 60001])
            expect(
                aisCoverageText({ state: 'recent', polledAt: new Date(time).toISOString(), truncated: false }, now),
            ).toMatch(/stale or unknown/);
    });
    it('keeps the linked contributor credit beside informational limitations', () => {
        publishAisCoverage({ state: 'recent', polledAt: new Date().toISOString() });
        render(<AisCoverageNotice />);
        expect(screen.getByRole('link', { name: 'Data: AISHub contributors' })).toHaveAttribute(
            'href',
            'https://www.aishub.net',
        );
        expect(screen.getByText(/No internet distress siren/)).toBeVisible();
    });
});
