/**
 * stores/draftConfirmStore.ts — the ONE way to ask "Your draft is set at
 * 2.40 m. Please confirm." (Shane 2026-09-29).
 *
 * Anything that plans against the draft — ⚡ Auto route, the Auto routing
 * trial, the inshore departure sweep, "Show charted leads" — calls
 * requireConfirmedDraft(reason) (or runWithConfirmedDraft) before it
 * runs. A confirmed draft passes straight through; otherwise the single
 * <DraftConfirmModal/> that App mounts asks once, and the promise resolves
 * true on Confirm / Save and confirm, false on close. Closing means the action
 * does not run; nothing nags afterwards.
 *
 * The confirmation itself is stored on the vessel profile
 * (services/draftConfirmation.ts), written through the same paths the Vessel
 * tab uses, so it syncs with the fleet like any other profile field.
 */
import { useSyncExternalStore } from 'react';
import type { VesselProfile } from '../types/vessel';
import { getAuthIdentityScope } from '../services/authIdentityScope';
import { draftSaveProfilePatch, isDraftConfirmed } from '../services/draftConfirmation';
import { VESSEL_SETTINGS_SEED } from '../utils/defaultVessel';
import { createLogger } from '../utils/createLogger';
import { useSettingsStore } from './settingsStore';

const log = createLogger('DraftConfirm');

/** What asked — for the log and the dialog's data attribute; the copy is the same for all. */
export type DraftConfirmReason = 'auto-route' | 'autorouting-trial' | 'departure-sweep' | 'charted-leads';

export interface DraftConfirmRequest {
    id: number;
    reason: DraftConfirmReason;
}

let request: DraftConfirmRequest | null = null;
let pending: { id: number; promise: Promise<boolean>; resolve: (confirmed: boolean) => void } | null = null;
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const getDraftConfirmRequest = (): DraftConfirmRequest | null => request;

export function useDraftConfirmRequest(): DraftConfirmRequest | null {
    return useSyncExternalStore(subscribe, getDraftConfirmRequest, getDraftConfirmRequest);
}

/** The active vessel profile — the one the Vessel tab edits. */
const currentVessel = (): VesselProfile | undefined => useSettingsStore.getState().settings?.vessel;

/** Called by DraftConfirmModal while mounted; returns its unregister. */
export function registerDraftConfirmHost(): () => void {
    hosts += 1;
    return () => {
        hosts -= 1;
        // The last modal leaving (sign-out teardown, a test unmount) must not
        // strand a caller: an unanswered ask is a "no".
        if (hosts === 0 && pending) settleDraftConfirm(pending.id, false);
    };
}

/**
 * Resolves true once the draft is confirmed — at once when it already is,
 * otherwise after the skipper confirms or saves one in the modal. False when
 * they close it. Asks made while the modal is up share its one answer.
 */
export function requireConfirmedDraft(reason: DraftConfirmReason): Promise<boolean> {
    if (isDraftConfirmed(currentVessel())) return Promise.resolve(true);
    if (pending) return pending.promise;
    if (hosts === 0) {
        // App always mounts the modal (tests/DraftConfirmModal.test.tsx holds
        // it to that). Without one there is nobody to ask, and a draft nobody
        // confirmed must not pass as confirmed.
        log.warn(`draft confirmation for ${reason} asked with no modal mounted; not running`);
        return Promise.resolve(false);
    }
    const id = nextId++;
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((done) => (resolve = done));
    pending = { id, promise, resolve };
    request = { id, reason };
    notify();
    return promise;
}

/**
 * Runs `action` straight away when the draft is confirmed — in the same tick,
 * so a tap handler stays a tap handler — or after the skipper confirms it.
 * Never runs it when they close the modal.
 */
export function runWithConfirmedDraft(reason: DraftConfirmReason, action: () => void): void {
    if (isDraftConfirmed(currentVessel())) {
        action();
        return;
    }
    void requireConfirmedDraft(reason).then((confirmed) => {
        if (confirmed) action();
    });
}

/** The modal's answer. Only the ask it was showing can be answered. */
export function settleDraftConfirm(id: number, confirmed: boolean): void {
    if (!pending || pending.id !== id) return;
    const { resolve } = pending;
    pending = null;
    request = null;
    notify();
    resolve(confirmed);
}

/**
 * Writes a draft confirmation patch to the active vessel profile the way the
 * Vessel tab does — the fleet patch when signed in, the local profile when
 * not — and reports whether the draft is now confirmed. Both paths apply the
 * change locally before their first await, so the answer is immediate; the
 * cloud write carries on (and queues offline) behind it.
 *
 * With no boat behind the draft, the patch grows into the Vessel tab's
 * starting boat, the guesses marked estimated (draftSaveProfilePatch) —
 * never a boat of zeros. Signed in, the selected fleet boat is the one that
 * counts should the local copy be missing, so her own figures are never
 * overwritten by guesses.
 */
export function saveDraftConfirmation(patch: Partial<VesselProfile>): boolean {
    const store = useSettingsStore.getState();
    try {
        const signedIn = Boolean(getAuthIdentityScope().userId);
        const selectedFleetBoat = store.vesselFleet.find((boat) => boat.id === store.activeVesselId)?.profile;
        const current = store.settings.vessel ?? (signedIn ? selectedFleetBoat : undefined);
        const profile = draftSaveProfilePatch(current, patch);
        const saving = signedIn
            ? store.patchActiveVesselProfile({ profile })
            : store.updateSettings({ vessel: { ...(store.settings.vessel ?? VESSEL_SETTINGS_SEED), ...profile } });
        void Promise.resolve(saving).catch((error: unknown) => {
            log.warn(`draft confirmation save deferred: ${error instanceof Error ? error.message : String(error)}`);
        });
    } catch (error) {
        log.warn(`draft confirmation save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return isDraftConfirmed(currentVessel());
}
