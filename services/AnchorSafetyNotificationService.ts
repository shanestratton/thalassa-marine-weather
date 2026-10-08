import { Capacitor, registerPlugin } from '@capacitor/core';

export const ANCHOR_NOTIFICATION_REQUEST_COUNT = 21;

export interface AnchorNotificationReadiness {
    ready: boolean;
    authorizationStatus: 'authorized';
    timeSensitiveEnabled: boolean;
    lockScreenEnabled: boolean;
    availableSlots: number;
}

/**
 * The shared safety-notification path (build 125, 125-01): the anchor's
 * plugin also carries the collision alarm and (125-02) the distress alarm,
 * each with its own fixed ids, Time Sensitive, behind the same
 * verified-enabled check. The anchor's ids and behaviour are unchanged
 * (tests/NativeSafetyNotificationContract.test.ts).
 */
export type SafetyAlertKind = 'collision' | 'distress';
/** A primary and two reminders, 30 s apart; the anchor keeps its 21 slots. */
export const SAFETY_ALERT_REQUEST_COUNT = 3;

interface AnchorSafetyNotificationsPlugin {
    checkReadiness(options: { requiredSlots: number }): Promise<AnchorNotificationReadiness>;
    scheduleAlarm(options: { title: string; body: string }): Promise<{
        scheduled: number;
        interruptionLevel: 'timeSensitive';
    }>;
    cancelAlarm(): Promise<{ cancelled: boolean }>;
    scheduleSafetyAlert(options: { kind: SafetyAlertKind; title: string; body: string }): Promise<{
        scheduled: number;
        interruptionLevel: 'timeSensitive';
    }>;
    cancelSafetyAlert(options: { kind: SafetyAlertKind }): Promise<{ cancelled: boolean }>;
}

/** The plugin's readiness messages name the anchor; say the feature that asked. */
function forKind(error: Error, kind: SafetyAlertKind): Error {
    const watch = kind === 'collision' ? 'the collision watch' : 'the distress alarm';
    return new Error(
        error.message
            .replace(/before (dropping anchor|using Anchor Watch|arming)/g, `before starting ${watch}`)
            .replace(/Anchor Watch/g, watch),
    );
}

const NativeAnchorNotifications = registerPlugin<AnchorSafetyNotificationsPlugin>('AnchorSafetyNotifications');

function nativeFailure(error: unknown, fallback: string): Error {
    if (error instanceof Error && error.message.trim()) return error;
    if (typeof error === 'string' && error.trim()) return new Error(error);
    if (error && typeof error === 'object' && 'message' in error) {
        const message = String((error as { message?: unknown }).message ?? '').trim();
        if (message) return new Error(message);
    }
    return new Error(fallback);
}

/**
 * Owns the iOS-only Time Sensitive fallback. Other platforms continue through
 * Capacitor LocalNotifications in AnchorWatchService; only this first-party
 * bridge can set UNMutableNotificationContent.interruptionLevel on iOS.
 */
class AnchorSafetyNotificationServiceClass {
    private mutationTail: Promise<void> = Promise.resolve();

    isNativeIOS(): boolean {
        return Capacitor.getPlatform() === 'ios';
    }

    async requireReadiness(): Promise<AnchorNotificationReadiness | null> {
        if (!this.isNativeIOS()) return null;
        try {
            const result = await NativeAnchorNotifications.checkReadiness({
                requiredSlots: ANCHOR_NOTIFICATION_REQUEST_COUNT,
            });
            if (
                result.ready !== true ||
                result.authorizationStatus !== 'authorized' ||
                result.timeSensitiveEnabled !== true ||
                result.lockScreenEnabled !== true ||
                result.availableSlots < ANCHOR_NOTIFICATION_REQUEST_COUNT
            ) {
                throw new Error(
                    'iOS did not confirm the Time Sensitive notification fallback required by Anchor Watch.',
                );
            }
            return result;
        } catch (error) {
            throw nativeFailure(
                error,
                'Time Sensitive notification readiness could not be verified. Check iOS Settings and try again.',
            );
        }
    }

    async scheduleAlarm(title: string, body: string): Promise<boolean> {
        if (!this.isNativeIOS()) return false;
        return this.runMutation(async () => {
            try {
                const result = await NativeAnchorNotifications.scheduleAlarm({ title, body });
                if (
                    result.scheduled !== ANCHOR_NOTIFICATION_REQUEST_COUNT ||
                    result.interruptionLevel !== 'timeSensitive'
                ) {
                    throw new Error(
                        `iOS confirmed only ${result.scheduled ?? 0} of ${ANCHOR_NOTIFICATION_REQUEST_COUNT} Anchor Watch notifications.`,
                    );
                }
                return true;
            } catch (error) {
                throw nativeFailure(
                    error,
                    'The Time Sensitive Anchor Watch notification fallback could not be scheduled.',
                );
            }
        });
    }

    async cancelAlarm(): Promise<boolean> {
        if (!this.isNativeIOS()) return false;
        return this.runMutation(async () => {
            try {
                const result = await NativeAnchorNotifications.cancelAlarm();
                if (result.cancelled !== true) {
                    throw new Error('iOS did not confirm cancellation of every Anchor Watch notification.');
                }
                return true;
            } catch (error) {
                throw nativeFailure(error, 'Anchor Watch notifications could not be cancelled cleanly.');
            }
        });
    }

    /** Time Sensitive readiness for a safety kind, checked when it is armed. */
    async requireSafetyReadiness(kind: SafetyAlertKind): Promise<AnchorNotificationReadiness | null> {
        if (!this.isNativeIOS()) return null;
        try {
            const result = await NativeAnchorNotifications.checkReadiness({
                requiredSlots: SAFETY_ALERT_REQUEST_COUNT,
            });
            if (result.ready !== true || result.timeSensitiveEnabled !== true || result.lockScreenEnabled !== true) {
                throw new Error('iOS did not confirm Time Sensitive lock-screen notifications.');
            }
            return result;
        } catch (error) {
            throw forKind(nativeFailure(error, 'Time Sensitive notification readiness could not be verified.'), kind);
        }
    }

    async scheduleSafetyAlert(kind: SafetyAlertKind, title: string, body: string): Promise<boolean> {
        if (!this.isNativeIOS()) return false;
        return this.runMutation(async () => {
            try {
                const result = await NativeAnchorNotifications.scheduleSafetyAlert({ kind, title, body });
                if (result.scheduled !== SAFETY_ALERT_REQUEST_COUNT || result.interruptionLevel !== 'timeSensitive') {
                    throw new Error(
                        `iOS confirmed only ${result.scheduled ?? 0} of ${SAFETY_ALERT_REQUEST_COUNT} alerts.`,
                    );
                }
                return true;
            } catch (error) {
                throw forKind(nativeFailure(error, 'The Time Sensitive alert could not be scheduled.'), kind);
            }
        });
    }

    async cancelSafetyAlert(kind: SafetyAlertKind): Promise<boolean> {
        if (!this.isNativeIOS()) return false;
        return this.runMutation(async () => {
            try {
                const result = await NativeAnchorNotifications.cancelSafetyAlert({ kind });
                if (result.cancelled !== true) throw new Error('iOS did not confirm the alert was withdrawn.');
                return true;
            } catch (error) {
                throw forKind(nativeFailure(error, 'The alert could not be withdrawn cleanly.'), kind);
            }
        });
    }

    private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationTail.then(operation, operation);
        this.mutationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}

export const AnchorSafetyNotificationService = new AnchorSafetyNotificationServiceClass();
