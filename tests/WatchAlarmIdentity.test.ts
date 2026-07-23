import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const h = vi.hoisted(() => ({
    getUser: vi.fn(),
    listAssignments: vi.fn(),
    getPending: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
    requestPermissions: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
    },
}));

vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        requestPermissions: h.requestPermissions,
        getPending: h.getPending,
        schedule: h.schedule,
        cancel: h.cancel,
    },
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: h.getUser,
        },
    },
}));

vi.mock('../services/WatchAssignmentService', () => ({
    WatchAssignmentService: {
        list: h.listAssignments,
    },
}));

import { WatchAlarmService } from '../services/WatchAlarmService';

const assignment = {
    assigned_crew_email: 'a@example.com',
    watch_time_label: '1200–1600',
    watch_index: 1,
    watch_label: 'First Watch',
};

describe('WatchAlarmService account boundary', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        h.getUser.mockResolvedValue({
            data: { user: { id: 'watch-a', email: 'a@example.com' } },
        });
        h.listAssignments.mockResolvedValue([assignment]);
        h.getPending.mockResolvedValue({ notifications: [] });
        h.schedule.mockResolvedValue(undefined);
        h.cancel.mockResolvedValue(undefined);
        h.requestPermissions.mockResolvedValue({ display: 'granted' });
        setAuthIdentityScope(null);
        setAuthIdentityScope('watch-a');
        await Promise.resolve();
        vi.clearAllMocks();
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('drops deferred A authentication before reading assignments as B', async () => {
        let resolveUser!: (value: { data: { user: { id: string; email: string } } }) => void;
        h.getUser.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveUser = resolve;
            }),
        );
        const pending = WatchAlarmService.scheduleForVoyage('voyage-a', '2099-01-01T00:00:00.000Z', 15);

        act(() => {
            setAuthIdentityScope('watch-b');
        });
        resolveUser({ data: { user: { id: 'watch-a', email: 'a@example.com' } } });

        await expect(pending).resolves.toBe(0);
        expect(h.listAssignments).not.toHaveBeenCalled();
        expect(h.schedule).not.toHaveBeenCalled();
    });

    it('drops deferred A assignments before scheduling them as B', async () => {
        let resolveAssignments!: (value: (typeof assignment)[]) => void;
        h.listAssignments.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveAssignments = resolve;
            }),
        );
        const pending = WatchAlarmService.scheduleForVoyage('voyage-a', '2099-01-01T00:00:00.000Z', 15);
        await waitFor(() => expect(h.listAssignments).toHaveBeenCalledWith('voyage-a'));

        act(() => {
            setAuthIdentityScope('watch-b');
        });
        resolveAssignments([assignment]);

        await expect(pending).resolves.toBe(0);
        expect(h.schedule).not.toHaveBeenCalled();
    });

    it('rolls back native notifications if identity changes during scheduling', async () => {
        let resolveSchedule!: () => void;
        h.schedule.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                resolveSchedule = resolve;
            }),
        );
        const pending = WatchAlarmService.scheduleForVoyage('voyage-a', '2099-01-01T00:00:00.000Z', 15);
        await waitFor(() => expect(h.schedule).toHaveBeenCalledOnce());

        act(() => {
            setAuthIdentityScope('watch-b');
        });
        resolveSchedule();

        await expect(pending).resolves.toBe(0);
        await waitFor(() =>
            expect(h.cancel).toHaveBeenCalledWith({
                notifications: [expect.objectContaining({ id: expect.any(Number) })],
            }),
        );
    });

    it('tags new notifications with their exact owner scope', async () => {
        await expect(WatchAlarmService.scheduleForVoyage(' voyage-a ', '2099-01-01T00:00:00.000Z', 15)).resolves.toBe(
            1,
        );

        const notification = h.schedule.mock.calls[0][0].notifications[0];
        expect(notification.extra).toMatchObject({
            watchAlarmService: 'thalassa-watch-alarm',
            ownerScopeKey: 'user:watch-a',
            ownerUserId: 'watch-a',
            voyageId: 'voyage-a',
        });
    });
});
