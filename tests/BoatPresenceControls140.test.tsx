import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ request: vi.fn(), finish: null as ((v: unknown) => void) | null }));
vi.mock('../services/presence/boatPresence', async () => {
    const { BoatPresenceController } = await import('../services/presence/BoatPresenceController');
    return {
        boatPresence: new BoatPresenceController({
            context: () => ({
                key: 'fixture',
                identity: 'fixture',
                userId: 'owner',
                vesselId: '00000000-0000-4000-8000-000000000002',
                allowed: true,
            }),
            request: h.request,
            fix: () => null,
            uuid: () => '00000000-0000-4000-8000-000000000006',
            wall: () => Date.now(),
            monotonic: () => performance.now(),
        }),
    };
});
import { boatPresence } from '../services/presence/boatPresence';
import BoatPresenceSheet from '../components/map/presence/BoatPresenceSheet';
const config = {
    vesselId: '00000000-0000-4000-8000-000000000002',
    vesselName: 'Fictional boat',
    tier: 'friends',
    revision: '00000000-0000-4000-8000-000000000003',
    sequence: 1,
    readerRevision: '00000000-0000-4000-8000-000000000004',
    publisherRevision: '00000000-0000-4000-8000-000000000005',
    publisherActive: false,
    serverTime: new Date().toISOString(),
};
beforeEach(() => {
    h.request.mockReset();
    h.finish = null;
    boatPresence.retire();
    boatPresence.setForeground(true);
    h.request.mockImplementation(async (action: string) =>
        action === 'friends'
            ? { friends: [] }
            : action === 'begin'
              ? new Promise((r) => {
                    h.finish = r;
                })
              : config,
    );
});
afterEach(() => {
    cleanup();
    boatPresence.retire();
});
it('Stop stays enabled and cancels an in-flight start before its acknowledgement', async () => {
    render(<BoatPresenceSheet onClose={() => {}} />);
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Publish for this foreground session' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish for this foreground session' }));
    const stop = await screen.findByRole('button', { name: 'Stop publishing now' });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await waitFor(() => expect(boatPresence.snapshot().publishing).toBe(false));
    expect(h.request.mock.calls.find((x) => x[0] === 'end')?.[1]).toMatchObject({
        kind: 'publisher',
        nonce: '00000000-0000-4000-8000-000000000006',
    });
    await act(async () => {
        h.finish?.(config);
        await Promise.resolve();
    });
    expect(boatPresence.snapshot().publishing).toBe(false);
    expect(h.request.mock.calls.some((x) => x[0] === 'fix')).toBe(false);
});
