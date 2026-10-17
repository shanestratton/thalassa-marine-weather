import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../services/PiOfflineWeatherService', () => ({ readPiMarineBulletins: read }));
import MarineBulletinsSheet from '../components/weather/MarineBulletinsSheet';
const snapshot = {
    schema: 1,
    coverage: 'Selected NOAA products only.',
    bulletins: [
        {
            id: 'noaa-hsf-at1',
            title: 'North Atlantic',
            text: 'ORIGINAL NOAA TEXT <not executable HTML>',
            issuedAt: '2026-10-16T10:30:00Z',
            fetchedAt: Date.UTC(2026, 9, 16, 11),
            sourceUrl: 'https://tgftp.nws.noaa.gov/data/raw/fz/fznt01.kwbc.hsf.at1.txt',
            attribution: 'NOAA/NWS public domain',
        },
    ],
};
beforeEach(() => {
    vi.clearAllMocks();
    read.mockResolvedValue(snapshot);
});
describe('cached official marine bulletin sheet', () => {
    it('shows the original text, issuer times and public official source for a covered point', async () => {
        render(<MarineBulletinsSheet onClose={() => {}} point={{ lat: 40, lon: -70 }} />);
        expect(await screen.findByText(snapshot.bulletins[0].text)).toBeInTheDocument();
        expect(screen.getByText(/Issued 2026-10-16 10:30 UTC · Received 2026-10-16 11:00 UTC/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Official source' })).toHaveAttribute(
            'href',
            snapshot.bulletins[0].sourceUrl,
        );
    });
    it('does not project a saved US product onto Australia', async () => {
        render(<MarineBulletinsSheet onClose={() => {}} point={{ lat: -27, lon: 153 }} />);
        expect(await screen.findByText(/No cached official marine bulletin for this area/)).toBeInTheDocument();
        expect(screen.queryByText(snapshot.bulletins[0].text)).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'BOM marine' })).toHaveAttribute(
            'href',
            'https://www.bom.gov.au/marine/',
        );
    });
    it('makes a local miss explicit without a remote fetch', async () => {
        read.mockResolvedValue(null);
        render(<MarineBulletinsSheet onClose={() => {}} point={null} />);
        expect(await screen.findByText(/No cached official marine bulletin for this area/)).toBeInTheDocument();
        expect(read).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('link', { name: 'Worldwide official services' })).toBeInTheDocument();
    });
});
