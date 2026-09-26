/**
 * WarningDetails — the Forecast alerts page's clear state (UX scorecard run 7).
 *
 * The clear state sent the skipper to "BoM marine warnings" as plain text, a
 * dead end. It is now a real link opened over the app, and the page's answer
 * is a heading so heading navigation reaches it.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setPage: vi.fn(), openExternalUrl: vi.fn(async () => undefined) }));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: mocks.setPage }),
}));
vi.mock('../services/externalLinks', () => ({ openExternalUrl: mocks.openExternalUrl }));

import { BOM_WARNINGS_URL, WarningDetails } from '../components/WarningDetails';

describe('WarningDetails clear state', () => {
    it('names the place in a heading and links to the Bureau', () => {
        render(<WarningDetails alerts={[]} placeName="Gladstone" checkedAt={new Date().toISOString()} />);

        expect(screen.getByRole('heading', { level: 2, name: 'No forecast alerts for Gladstone' })).toBeInTheDocument();

        const link = screen.getByRole('link', { name: /Open BoM warnings/ });
        expect(link).toHaveAttribute('href', BOM_WARNINGS_URL);
        expect(link.className).toContain('min-h-[44px]');
        // The link is a control, so it sits outside the status region.
        expect(screen.getByRole('status')).not.toContainElement(link);

        fireEvent.click(link);
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(BOM_WARNINGS_URL);
    });

    it('offers no link while alerts are listed', () => {
        render(<WarningDetails alerts={['Gale warning for coastal waters']} />);
        expect(screen.queryByRole('link', { name: /Open BoM warnings/ })).not.toBeInTheDocument();
    });
});
