import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ allowed: true, current: true, schedule: vi.fn(), request: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        requestPermissions: h.request,
        checkPermissions: async () => ({ display: h.allowed ? 'granted' : 'denied' }),
        schedule: h.schedule,
    },
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ key: 'A', userId: 'A' }),
    isAuthIdentityScopeCurrent: () => h.current,
}));
import { enablePressureNotifications, notifyPressureFall } from '../services/PressureNotificationService';
beforeEach(() => {
    vi.clearAllMocks();
    h.allowed = h.current = true;
    h.request.mockResolvedValue({ display: 'granted' });
});
describe('app-alive local pressure notification', () => {
    it('requests permission only through the explicit enable action', async () => {
        expect(await enablePressureNotifications()).toBe(true);
        expect(h.request).toHaveBeenCalledTimes(1);
    });
    it('delivers immediately through local notifications without a future schedule', async () => {
        await notifyPressureFall('Observed fall; check official warnings.');
        const notification = h.schedule.mock.calls[0][0].notifications[0];
        expect(notification.title).toBe('Pressure falling quickly');
        expect(notification.schedule).toBeUndefined();
        expect(h.request).not.toHaveBeenCalled();
    });
    it('does not deliver after permission denial or identity change', async () => {
        h.allowed = false;
        await notifyPressureFall('fall');
        h.allowed = true;
        h.current = false;
        await notifyPressureFall('fall');
        expect(h.schedule).not.toHaveBeenCalled();
    });
});
