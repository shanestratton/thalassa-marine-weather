import { Capacitor } from '@capacitor/core';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';

/** User-initiated permission request; no owner-away push subscription. */
export async function enablePressureNotifications(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        return (await LocalNotifications.requestPermissions()).display === 'granted';
    }
    return typeof Notification !== 'undefined' && (await Notification.requestPermission()) === 'granted';
}

/** Immediate local delivery only. No server queue, future schedule or Pi alarm relay. */
export async function notifyPressureFall(body: string): Promise<void> {
    const scope = getAuthIdentityScope();
    try {
        if (Capacitor.isNativePlatform()) {
            const { LocalNotifications } = await import('@capacitor/local-notifications');
            const permission = await LocalNotifications.checkPermissions();
            if (!isAuthIdentityScopeCurrent(scope) || permission.display !== 'granted') return;
            await LocalNotifications.schedule({
                notifications: [
                    {
                        id: 133006,
                        title: 'Pressure falling quickly',
                        body,
                        extra: { service: 'pressure-fall', ownerScopeKey: scope.key },
                    },
                ],
            });
        } else if (
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            isAuthIdentityScopeCurrent(scope)
        ) {
            new Notification('Pressure falling quickly', { body, tag: 'thalassa-pressure-fall' });
        }
    } catch {
        /* The in-app warning remains available without OS permission. */
    }
}
