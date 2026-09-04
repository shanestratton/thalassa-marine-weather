/**
 * Guard-zone alerts outlive the screen that happened to be open.
 *
 * Detection runs app-wide (AisGuardWatch), but the alert was owned by a
 * component mounted ONLY on the chart surface, holding its list in local
 * state. Two consequences, both bad:
 *
 *   - an alert raised while the skipper was on any other page was heard by
 *     nobody, because no listener existed;
 *   - returning to the chart replayed nothing, because the state died with
 *     the component.
 *
 * And AisGuardZone is EDGE-triggered — `activeAlertMmsis` alerts once per
 * entry and not again while the vessel stays inside. So losing the alert did
 * not mean "you will be told again in a moment". It meant the warning was
 * gone for as long as that vessel remained in your guard ring.
 *
 * The store listens at module scope, so it is running before any screen is,
 * and holds every alert until it is explicitly acknowledged.
 */
import type { GuardAlert } from './AisGuardZone';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AisGuardAlerts');

const MAX_HELD = 5;

let alerts: GuardAlert[] = [];
const listeners = new Set<(a: GuardAlert[]) => void>();

function emit(): void {
    for (const l of listeners) l(alerts);
}

function ingest(incoming: GuardAlert[]): void {
    if (!incoming?.length) return;
    // Newest first, one entry per vessel: a second alert for a vessel already
    // being warned about should refresh it, not stack up beside it.
    const byMmsi = new Map<number, GuardAlert>();
    for (const a of [...incoming, ...alerts]) if (!byMmsi.has(a.mmsi)) byMmsi.set(a.mmsi, a);
    alerts = [...byMmsi.values()].slice(0, MAX_HELD);
    log.warn(`AIS guard: ${incoming.length} vessel(s) in the ring — ${alerts.length} awaiting acknowledgement`);
    emit();
}

if (typeof window !== 'undefined') {
    window.addEventListener('ais-guard-alert', (e: Event) => {
        ingest((e as CustomEvent<GuardAlert[]>).detail);
    });
}

export const AisGuardAlertStore = {
    get(): GuardAlert[] {
        return alerts;
    },

    subscribe(listener: (a: GuardAlert[]) => void): () => void {
        listeners.add(listener);
        listener(alerts);
        return () => listeners.delete(listener);
    },

    /** Explicit acknowledgement — the only thing that removes an alert. */
    dismiss(mmsi: number): void {
        alerts = alerts.filter((a) => a.mmsi !== mmsi);
        emit();
    },

    /** Identity change / sign-out: this account's warnings are not the next one's. */
    clear(): void {
        alerts = [];
        emit();
    },
};
