import type { ShoreAlarmSnapshot } from '../../services/ShoreWatchAlarmService';
import type { ShorePushReadiness } from '../../services/AnchorWatchSyncService';

export interface ShoreWatchStatusPresentation {
    active: boolean;
    tone: 'blue' | 'yellow' | 'red';
    label: string;
    detail: string;
    notificationDetail: string;
    notificationsReady: boolean;
    notificationsChecking: boolean;
    reminderError: string | null;
    reminderPending: boolean;
}

/** Connection colour is about fresh vessel data, not merely an open socket.
 * Notification readiness is reported separately: connected is not a promise
 * that a locked phone will sound. Alarm causes override a healthy connection.
 */
export function presentShoreWatchStatus(
    watch: ShoreAlarmSnapshot,
    push: ShorePushReadiness,
): ShoreWatchStatusPresentation {
    const status: ShoreWatchStatusPresentation = {
        active: !!watch.sessionCode,
        tone: 'yellow',
        label: 'Waiting for vessel data',
        detail: 'Waiting for a fresh position from the vessel.',
        notificationsReady: push.status === 'ready',
        notificationsChecking: push.status === 'checking',
        reminderError: watch.reminderError ?? null,
        reminderPending: watch.reminderPending ?? false,
        notificationDetail:
            push.status === 'ready'
                ? 'Phone notifications registered. Sound still depends on phone settings and delivery.'
                : push.status === 'checking'
                  ? 'Checking background notifications…'
                  : push.reason || 'Phone notifications are not yet confirmed. Keep this app open and retry.',
    };
    if (!status.active) return status;
    if (watch.cause === 'drag') {
        status.tone = 'red';
        status.label = 'Vessel drag alarm';
        status.detail = 'The vessel reported an anchor alarm. Check the boat immediately.';
    } else if (watch.cause === 'contact-lost') {
        status.tone = 'red';
        status.label = 'Vessel connection lost';
        status.detail = 'No current vessel data. We cannot confirm the boat is holding.';
    } else if (watch.cause === 'gps-lost') {
        status.tone = 'red';
        status.label = 'Vessel GPS lost';
        status.detail = 'The vessel has no usable GPS position. We cannot confirm the boat is holding.';
    } else if (watch.cause === 'session-expiring') {
        status.label = 'Shore Watch expiring';
        status.detail = 'Open Shore Watch and renew its authorisation before it ends.';
    } else if (!watch.stale && watch.position && watch.lastContactAt !== null) {
        status.tone = 'blue';
        status.label = 'Receiving vessel data';
        status.detail = 'Connected · fresh vessel position received. Shore Watch continues when you change pages.';
    } else if (watch.lastContactAt !== null) {
        status.label = 'Waiting for fresh vessel data';
        status.detail = 'The last vessel position is stale. Waiting for the next update.';
    }
    if (watch.cause && watch.muted) status.detail += ' In-app sound is silenced; monitoring continues.';
    return status;
}
