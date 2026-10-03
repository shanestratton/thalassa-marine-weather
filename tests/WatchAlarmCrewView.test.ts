/**
 * Pre-watch alarms and The Glass's Watch page keep working for crew once the
 * watch bill reaches them BY NAME (20261003140000): the crew view carries no
 * email, so "mine" comes from its isSelf flag. The alarm and the page use one
 * rule (isOwnWatch), so they can never disagree about whose watch it is.
 *
 * Fictional people and passages only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { WatchAssignment } from '../services/WatchAssignmentService';

const h = vi.hoisted(() => ({
    getUser: vi.fn(),
    listAssignments: vi.fn(),
    getActiveVoyage: vi.fn(),
    getPending: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        requestPermissions: vi.fn(async () => ({ display: 'granted' })),
        getPending: h.getPending,
        schedule: h.schedule,
        cancel: h.cancel,
    },
}));

vi.mock('../services/supabase', () => ({ supabase: { auth: { getUser: h.getUser } } }));

vi.mock('../services/WatchAssignmentService', () => ({ WatchAssignmentService: { list: h.listAssignments } }));

vi.mock('../services/VoyageService', () => ({ getActiveVoyage: h.getActiveVoyage }));

import { WatchAlarmService } from '../services/WatchAlarmService';
import { myWatches } from '../services/myWatches';

function crewViewRow(index: number, fields: Partial<WatchAssignment>): WatchAssignment {
    return {
        id: `crew-view_voyage-a_${index}`,
        voyage_id: 'voyage-a',
        watch_index: index,
        watch_label: `Watch ${index + 1}`,
        watch_time_label: index === 0 ? '1200–1600' : '1600–2000',
        assigned_crew_email: null,
        assigned_crew_name: null,
        assigned_crew_user_id: null,
        assigned_at: null,
        assigned_by: null,
        created_at: '2026-10-03T00:00:00.000Z',
        updated_at: '2026-10-03T00:00:00.000Z',
        ...fields,
    };
}

describe('crew alarms and watches from the by-name watch bill', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        h.getUser.mockResolvedValue({ data: { user: { id: 'crew-1', email: 'tom@example.com' } } });
        h.getPending.mockResolvedValue({ notifications: [] });
        h.schedule.mockResolvedValue(undefined);
        h.cancel.mockResolvedValue(undefined);
        h.getActiveVoyage.mockResolvedValue({ id: 'voyage-a', departure_time: '2099-01-01T00:00:00.000Z' });
        h.listAssignments.mockResolvedValue([
            crewViewRow(0, { is_assigned: true, is_self: true }),
            crewViewRow(1, { is_assigned: true, is_self: false, assigned_crew_name: 'Ana Reyes' }),
        ]);
        setAuthIdentityScope(null);
        setAuthIdentityScope('crew-1');
        await Promise.resolve();
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('schedules alarms for your own watch only, though no email came with it', async () => {
        await expect(WatchAlarmService.scheduleForVoyage('voyage-a', '2099-01-01T00:00:00.000Z', 15)).resolves.toBe(7);
        const scheduled = h.schedule.mock.calls[0][0].notifications as Array<{ extra: { watchIndex: number } }>;
        expect(new Set(scheduled.map((n) => n.extra.watchIndex))).toEqual(new Set([0]));
    });

    it("The Glass's Watch page shows the same watch", async () => {
        const watches = await myWatches(new Date('2098-12-31T00:00:00.000Z'));
        expect(watches.map((w) => w.index)).toEqual([0]);
    });

    it('the skipper’s raw rows still match by your address', async () => {
        h.listAssignments.mockResolvedValue([
            crewViewRow(0, { assigned_crew_email: 'TOM@example.com' }),
            crewViewRow(1, { assigned_crew_email: 'ana@example.com' }),
        ]);
        await expect(WatchAlarmService.scheduleForVoyage('voyage-a', '2099-01-01T00:00:00.000Z', 15)).resolves.toBe(7);
        expect((await myWatches(new Date('2098-12-31T00:00:00.000Z'))).map((w) => w.index)).toEqual([0]);
    });
});
