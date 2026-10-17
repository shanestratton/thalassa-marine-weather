import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OwnBoatSkill from '../components/dashboard/OwnBoatSkill';
import type { PrivateBoatSession } from '../services/weather/ownBoatSkillTransaction';
import type { OwnBoatProposal } from '../utils/ownBoatSkill';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture() {
    const session: PrivateBoatSession = {
        vesselName: 'Synthetic boat',
        saved: false,
        current: () => true,
        prepare: vi.fn(
            async (): Promise<OwnBoatProposal> => ({
                schema: 1,
                nonce: 'a'.repeat(64),
                expiresAt: Date.now() + 60_000,
                binding: {
                    ownerId: ID,
                    vesselId: ID,
                    vesselRevision: 1,
                    piDeviceId: ID,
                    controllerId: ID,
                    pairingRevision: 'a'.repeat(64),
                    enrollmentRevision: 'b'.repeat(64),
                    selfKey: 'c'.repeat(64),
                    windSourceKey: 'd'.repeat(64),
                    positionSourceKey: 'e'.repeat(64),
                },
                vesselName: 'Synthetic boat',
                windSource: 'synthetic.wind',
                positionSource: 'synthetic.gps',
            }),
        ),
        confirm: vi.fn(async () => {
            session.saved = true;
            return {} as never;
        }),
        read: vi.fn(async () => {
            throw Error('Private access unavailable');
        }),
        off: vi.fn(async () => {
            session.saved = false;
        }),
        release: vi.fn(),
        retire: vi.fn(),
    };
    return { session, open: vi.fn(async () => session) };
}
describe('private scorecard explicit UI', () => {
    it('loads no Pi session on mount/expansion, keeps logging off and requires explicit association before a grant', async () => {
        const f = fixture();
        render(<OwnBoatSkill openReview={f.open} />);
        expect(f.open).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Private boat scorecard'));
        fireEvent.click(await screen.findByRole('button', { name: 'Review instruments' }));
        const save = await screen.findByRole('button', { name: 'Save access with logging off' });
        expect(save).toBeDisabled();
        expect(screen.getAllByRole('checkbox').every((input) => !(input as HTMLInputElement).checked)).toBe(true);
        expect(screen.getByText(/Pairing alone does not prove/)).toBeVisible();
        expect(screen.getByText(/cannot reach an offline Pi/)).toBeVisible();
        fireEvent.click(screen.getByRole('checkbox', { name: /I confirm/ }));
        fireEvent.click(save);
        await waitFor(() => expect(f.session.confirm).toHaveBeenCalledWith(false));
        expect(await screen.findByText('Private access saved. Logging is off.')).toBeVisible();
        expect(f.open).toHaveBeenCalledTimes(1);
    });
    it('only the separate logging checkbox enables logging; clear is an explicit separate action', async () => {
        const f = fixture();
        render(<OwnBoatSkill openReview={f.open} />);
        fireEvent.click(screen.getByText('Private boat scorecard'));
        fireEvent.click(await screen.findByRole('button', { name: 'Review instruments' }));
        fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm/ }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Log true wind/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Enable private logging' }));
        await waitFor(() => expect(f.session.confirm).toHaveBeenCalledWith(true));
        fireEvent.click(await screen.findByRole('button', { name: 'Stop and clear private evidence' }));
        await waitFor(() => expect(f.session.off).toHaveBeenCalledWith(true));
    });
});
