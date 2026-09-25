import { AlarmAudioService } from './AlarmAudioService';
import { AnchorWatchService } from './AnchorWatchService';
import {
    AnchorWatchSyncService,
    type PositionBroadcast,
    type SyncBroadcast,
    type SyncState,
} from './AnchorWatchSyncService';

export const SHORE_CONTACT_ALARM_MS = 60_000;
export const SHORE_POSITION_STALE_MS = 35_000;
export type ShoreAlarmCause = 'drag' | 'contact-lost' | 'gps-lost' | 'session-expiring';
export interface ShoreAlarmSnapshot {
    sessionCode: string | null;
    position: PositionBroadcast | null;
    lastContactAt: number | null;
    stale: boolean;
    cause: ShoreAlarmCause | null;
    muted: boolean;
    audioError: string | null;
    /** Local audio mute and server acknowledgement are separate outcomes. */
    reminderError?: string | null;
    reminderPending?: boolean;
}

const idle = (): ShoreAlarmSnapshot => ({
    sessionCode: null,
    position: null,
    lastContactAt: null,
    stale: true,
    cause: null,
    muted: false,
    audioError: null,
    reminderError: null,
    reminderPending: false,
});

/** App-lifetime coordinator. Page subscribers never own or stop the watch. */
export class ShoreWatchAlarmServiceClass {
    private snapshot = idle();
    private listeners = new Set<(snapshot: ShoreAlarmSnapshot) => void>();
    private started = false;
    private joinedAt = 0;
    private lastEventAt = 0;
    private sessionExpiring = false;
    private lease: string | null = null;
    private audioPending = false;
    /** Settles after native start either installs its lease or reports failure. */
    private pendingAudioStart: Promise<void> | null = null;
    private alarmEpoch = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private sync: SyncState | null = null;
    private lastBoatBroadcastAt = 0;
    private pendingMute: Promise<void> | null = null;
    private gpsUnavailable = false;
    private muteContext: {
        sessionCode: string;
        kind: 'drag' | 'gps_lost' | 'contact_lost';
        startedBefore: number;
    } | null = null;
    private reminderCheck: Promise<void> | null = null;

    getSnapshot = (): ShoreAlarmSnapshot => this.snapshot;
    subscribe = (listener: (snapshot: ShoreAlarmSnapshot) => void): (() => void) => {
        this.listeners.add(listener);
        listener(this.snapshot);
        return () => this.listeners.delete(listener);
    };

    start(): void {
        if (this.started) return;
        this.started = true;
        AnchorWatchSyncService.onStateChange((state) => this.receiveState(state));
        AnchorWatchSyncService.onBroadcast((data) => this.receive(data));
        const latest = AnchorWatchSyncService.getLatestBroadcast();
        const position = AnchorWatchSyncService.getLatestPosition();
        if (position) this.receive(position);
        if (latest && latest !== position) this.receive(latest);
    }

    private emit(patch: Partial<ShoreAlarmSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        this.listeners.forEach((listener) => listener(this.snapshot));
    }

    private receiveState(state: SyncState): void {
        this.sync = state;
        const sessionCode = state.role === 'shore' ? state.sessionCode : null;
        if (sessionCode !== this.snapshot.sessionCode) {
            this.releaseDetached();
            this.joinedAt = Date.now();
            this.lastEventAt = 0;
            this.sessionExpiring = false;
            this.gpsUnavailable = false;
            this.muteContext = null;
            this.reminderCheck = null;
            this.emit({ ...idle(), sessionCode });
        }
        // Includes the vessel publisher: leaving the vessel's page must not
        // stop the position feed to shore devices either.
        if (state.sessionCode && !this.timer) {
            this.timer = setInterval(() => this.tick(), 1_000);
        } else if (!state.sessionCode && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.tick();
    }

    private receive(data: SyncBroadcast): void {
        if (!this.snapshot.sessionCode || !this.validTime(data.timestamp) || data.timestamp < this.lastEventAt) return;
        const now = Date.now();
        // Replayed/stale "holding" packets must never cancel a live alarm or
        // refresh the contact watchdog. Ignore a badly skewed future clock too.
        if (now - data.timestamp > SHORE_POSITION_STALE_MS || data.timestamp > now + 30_000) return;
        if (data.type === 'position') {
            const fixAt = data.vessel?.timestamp;
            if (!this.validTime(fixAt) || now - fixAt > SHORE_POSITION_STALE_MS || fixAt > now + 30_000) return;
            if (
                !this.validCoordinates(data.vessel) ||
                !this.validCoordinates(data.anchor) ||
                !Number.isFinite(data.distance) ||
                data.distance < 0 ||
                !Number.isFinite(data.swingRadius) ||
                data.swingRadius <= 0
            )
                return;
            if (data.isAlarm !== true && data.isAlarm !== false) return;
            this.lastEventAt = data.timestamp;
            this.gpsUnavailable = false;
            this.emit({ position: data, lastContactAt: Math.min(now, data.timestamp, fixAt), stale: false });
            this.setCause(data.isAlarm ? 'drag' : this.sessionExpiring ? 'session-expiring' : null);
        } else if (data.type === 'status' && data.gpsAvailable === false) {
            this.lastEventAt = data.timestamp;
            this.gpsUnavailable = true;
            this.emit({ stale: true });
            if (this.snapshot.cause !== 'drag') this.setCause('gps-lost');
        } else if (data.type === 'alarm' && data.triggered) {
            this.lastEventAt = data.timestamp;
            this.setCause('drag');
        }
    }

    /** Foreground APNs is an independent alarm path when Realtime is down. */
    receivePush(data: Readonly<Record<string, unknown>>): void {
        this.start();
        const current = AnchorWatchSyncService.getState();
        if (current.role !== 'shore' || !current.sessionCode || data.session_code !== current.sessionCode) return;
        if (data.notification_type !== 'anchor_alarm') return;
        const kind = data.alarm_kind;
        const observedAt = typeof data.observed_at === 'string' ? Date.parse(data.observed_at) : NaN;
        if (Number.isFinite(observedAt) && (Date.now() - observedAt > 120_000 || observedAt > Date.now() + 30_000))
            return;
        if (kind === 'session_expiring') this.sessionExpiring = true;
        else if (Number.isFinite(observedAt) && observedAt < this.lastEventAt) return;
        // A lost link or expiring lease must never downgrade confirmed drag.
        if (this.snapshot.cause === 'drag' && kind !== 'drag') return;
        // A delayed pre-alarm holding packet cannot clear a newer APNs alarm.
        if (Number.isFinite(observedAt) && kind !== 'session_expiring') this.lastEventAt = observedAt;
        const incidentStartedAt =
            typeof data.incident_started_at === 'string' ? Date.parse(data.incident_started_at) : NaN;
        const newIncidentAfterMute =
            (this.snapshot.muted || this.pendingMute !== null) &&
            this.muteContext !== null &&
            Number.isFinite(incidentStartedAt) &&
            incidentStartedAt > this.muteContext.startedBefore &&
            incidentStartedAt <= Date.now() + 30_000;
        this.setCause(
            kind === 'session_expiring'
                ? 'session-expiring'
                : kind === 'contact_lost'
                  ? 'contact-lost'
                  : kind === 'gps_lost'
                    ? 'gps-lost'
                    : 'drag',
            newIncidentAfterMute,
        );
    }

    private validTime(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }

    private validCoordinates(value: { latitude: number; longitude: number } | undefined): boolean {
        return (
            !!value &&
            Number.isFinite(value.latitude) &&
            Math.abs(value.latitude) <= 90 &&
            Number.isFinite(value.longitude) &&
            Math.abs(value.longitude) <= 180
        );
    }

    private tick(): void {
        const now = Date.now();
        if (
            this.sync?.role === 'vessel' &&
            this.sync.sessionCode &&
            this.sync.connected &&
            now - this.lastBoatBroadcastAt >= 5_000
        ) {
            const boat = AnchorWatchService.getSnapshot();
            if ((boat.state === 'watching' || boat.state === 'alarm') && boat.anchorPosition && boat.vesselPosition) {
                AnchorWatchSyncService.broadcastPosition({
                    vessel: boat.vesselPosition,
                    anchor: boat.anchorPosition,
                    distance: boat.distanceFromAnchor,
                    swingRadius: boat.swingRadius,
                    isAlarm: boat.state === 'alarm',
                    config: boat.config,
                });
                this.lastBoatBroadcastAt = now;
            }
        }
        if (!this.snapshot.sessionCode) return;
        const age = now - (this.snapshot.lastContactAt ?? this.joinedAt);
        const stale =
            this.gpsUnavailable ||
            this.snapshot.cause === 'gps-lost' ||
            this.snapshot.lastContactAt === null ||
            age > SHORE_POSITION_STALE_MS;
        if (stale !== this.snapshot.stale) this.emit({ stale });
        // Do not replace a confirmed dragging alarm with the less specific
        // contact warning when the link subsequently disappears.
        if (age >= SHORE_CONTACT_ALARM_MS && !this.snapshot.cause) this.setCause('contact-lost');
    }

    private setCause(cause: ShoreAlarmCause | null, forceRearm = false): void {
        if (this.snapshot.cause === cause && !forceRearm) return;
        this.releaseDetached();
        this.muteContext = null;
        this.reminderCheck = null;
        this.emit({ cause, muted: false, audioError: null, reminderError: null, reminderPending: false });
        if (cause) this.sound();
    }

    private sound(): void {
        if (!this.snapshot.cause || this.snapshot.muted || this.lease || this.audioPending) return;
        const epoch = this.alarmEpoch;
        this.audioPending = true;
        const startOperation = AlarmAudioService.acquire('shore-watch')
            .then((lease) => {
                if (epoch !== this.alarmEpoch) {
                    AlarmAudioService.releaseEventually(lease);
                    return;
                }
                this.lease = lease;
                this.emit({ audioError: null });
            })
            .catch(() => {
                if (epoch === this.alarmEpoch)
                    this.emit({ audioError: 'The alarm could not sound. Check volume and audio output, then retry.' });
            })
            .finally(() => {
                if (epoch === this.alarmEpoch) this.audioPending = false;
                if (this.pendingAudioStart === startOperation) this.pendingAudioStart = null;
            });
        this.pendingAudioStart = startOperation;
    }

    retryAudio = (): void => this.sound();

    mute = async (): Promise<void> => {
        if (this.snapshot.muted) return this.retryReminderAcknowledgement();
        if (!this.pendingMute) {
            const epoch = this.alarmEpoch;
            const pendingStart = this.pendingAudioStart;
            const sessionCode = this.snapshot.sessionCode;
            const cause = this.snapshot.cause;
            const startedBefore = Date.now();
            // Install the click-time fence before awaiting native audio. A
            // newer same-kind incident arriving during stop must invalidate
            // this mute, not inherit it when the native bridge finally settles.
            this.muteContext =
                sessionCode && cause && cause !== 'session-expiring'
                    ? {
                          sessionCode,
                          kind: cause === 'drag' ? 'drag' : cause === 'gps-lost' ? 'gps_lost' : 'contact_lost',
                          startedBefore,
                      }
                    : null;
            const operation = (async () => {
                // A missing lease is not proof of silence while startAlarm is
                // in flight. Wait for its ownership token, then require the
                // explicit release to confirm stop before hiding the alarm.
                if (pendingStart) await pendingStart;
                if (epoch !== this.alarmEpoch) return;
                const lease = this.lease;
                if (lease) await AlarmAudioService.release(lease);
                if (epoch !== this.alarmEpoch) return;
                this.lease = null;
                this.alarmEpoch++;
                this.audioPending = false;
                this.emit({ muted: true, audioError: null });
                if (sessionCode && cause && cause !== 'session-expiring') {
                    // Never keep the speaker sounding because the internet is
                    // down. Confirm the remote reminder separately and expose
                    // any failure rather than claiming all alerts are muted.
                    void this.retryReminderAcknowledgement();
                }
            })();
            const tracked = operation.finally(() => {
                if (this.pendingMute === tracked) this.pendingMute = null;
            });
            this.pendingMute = tracked;
        }
        // Do not leave the UI disabled forever if the native bridge hangs.
        // The same underlying release remains pending; a timeout never claims
        // silence or queues another native stop behind it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.pendingMute,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Alarm silence was not confirmed.')), 8_000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };

    retryReminderAcknowledgement = (): Promise<void> => {
        if (this.reminderCheck) return this.reminderCheck;
        const context = this.muteContext;
        if (!context || !this.snapshot.muted || this.snapshot.sessionCode !== context.sessionCode)
            return Promise.resolve();
        this.emit({ reminderPending: true, reminderError: null });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const operation = Promise.race([
            AnchorWatchSyncService.acknowledgeAlarmReminders(context.kind, context.startedBefore),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Server acknowledgement timed out.')), 8_000);
            }),
        ])
            .then(() => {
                if (this.muteContext === context) this.emit({ reminderError: null });
            })
            .catch(() => {
                if (this.muteContext === context)
                    this.emit({
                        reminderError:
                            'Local sound stopped. Repeating notifications are not confirmed silenced—check your connection and retry.',
                    });
            })
            .finally(() => {
                clearTimeout(timer);
                if (this.muteContext === context) this.emit({ reminderPending: false });
                if (this.reminderCheck === operation) this.reminderCheck = null;
            });
        this.reminderCheck = operation;
        return operation;
    };

    private releaseDetached(): void {
        this.alarmEpoch++;
        this.pendingMute = null;
        this.audioPending = false;
        this.pendingAudioStart = null;
        const lease = this.lease;
        this.lease = null;
        if (lease) AlarmAudioService.releaseEventually(lease);
    }
}

export const ShoreWatchAlarmService = new ShoreWatchAlarmServiceClass();
