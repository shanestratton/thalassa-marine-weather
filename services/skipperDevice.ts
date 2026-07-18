/**
 * skipperDevice — which device speaks for the boat.
 *
 * Two devices signed into one skipper account both wrote track points under the
 * same user_id, so the public page drew BOTH as separate voyages and the boat
 * marker jumped to whichever reported last (Shane 2026-07-19: "which one will be
 * the authority??"). Nothing in the schema could tell them apart — there was no
 * device identity anywhere in the tracking path.
 *
 * The claim is EXCLUSIVE: one device holds it, and a second must take it over
 * deliberately rather than quietly becoming a second source of truth.
 *
 * Design notes worth keeping:
 *
 *  • The gate is on PUBLISHING, not recording. A device without the claim still
 *    logs the passage locally — it simply doesn't push to the public track. A
 *    flat battery on the primary must never cost you the passage itself.
 *
 *  • Release is not only by un-ticking. A claim you can only release from the
 *    device holding it strands you the moment that device is overboard, soaked,
 *    flat or ashore — none of which are hypothetical on a boat. Takeover is
 *    always possible; it is just deliberate, and it shows who holds it and when
 *    they were last seen.
 *
 *  • The claim rides in settings, which sync last-write-wins. Two devices
 *    claiming while offline means one silently loses — tolerable, but the loser
 *    must FIND OUT (see hasBeenDisplaced). A device that believes it is
 *    publishing while the server disagrees is silent data loss on the public
 *    page, which is worse than not publishing at all.
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('skipperDevice');

const DEVICE_ID_KEY = 'thalassa_device_id';
const DEVICE_NAME_KEY = 'thalassa_device_name';

export interface SkipperClaim {
    /** Device that currently speaks for the boat. */
    deviceId: string;
    /** Human label for the takeover prompt ("Shane's iPhone"). */
    deviceName: string;
    /** ISO — when the claim was made or last refreshed. Drives "last seen". */
    claimedAt: string;
}

/** Stable per-install id. Survives sign-out; dies with the app's storage. */
export function getDeviceId(): string {
    try {
        const existing = localStorage.getItem(DEVICE_ID_KEY);
        if (existing) return existing;
        // Not crypto-sensitive — it only has to be distinct between a skipper's
        // own handful of devices.
        const id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        localStorage.setItem(DEVICE_ID_KEY, id);
        return id;
    } catch {
        // Private mode / storage disabled: a per-session id still keeps two
        // devices apart for as long as the app is open, which is the case that
        // matters underway.
        return 'dev-ephemeral';
    }
}

/** Best-effort friendly name, editable later. */
export function getDeviceName(): string {
    try {
        const saved = localStorage.getItem(DEVICE_NAME_KEY);
        if (saved && saved.trim()) return saved.trim();
    } catch {
        /* fall through to the derived default */
    }
    const platform = Capacitor.getPlatform();
    if (platform === 'ios') return 'This iPhone/iPad';
    if (platform === 'android') return 'This Android device';
    return 'This browser';
}

export function setDeviceName(name: string): void {
    try {
        localStorage.setItem(DEVICE_NAME_KEY, name.trim());
    } catch {
        log.warn('device name not persisted (storage unavailable)');
    }
}

/** Does THIS device hold the claim? */
export function holdsClaim(claim: SkipperClaim | null | undefined): boolean {
    return !!claim && claim.deviceId === getDeviceId();
}

/**
 * Unclaimed boats publish. Without this, every existing skipper would silently
 * stop appearing on their own public page the moment this shipped — a migration
 * that breaks the thing it is trying to protect. The claim only starts
 * excluding devices once somebody actually makes one.
 */
export function mayPublish(claim: SkipperClaim | null | undefined): boolean {
    if (!claim || !claim.deviceId) return true;
    return holdsClaim(claim);
}

/**
 * TRUE when a claim exists, is held elsewhere, and this device previously held
 * it — i.e. it has been taken over and is no longer publishing. The caller tells
 * the skipper; silence here is the failure mode this exists to prevent.
 */
export function hasBeenDisplaced(claim: SkipperClaim | null | undefined, previouslyHeld: boolean): boolean {
    return previouslyHeld && !!claim?.deviceId && !holdsClaim(claim);
}

/** A claim for this device, stamped now. */
export function buildClaim(): SkipperClaim {
    return { deviceId: getDeviceId(), deviceName: getDeviceName(), claimedAt: new Date().toISOString() };
}

/** "2 minutes ago" / "3 days ago" — for the takeover prompt. */
export function claimAgeLabel(claim: SkipperClaim | null | undefined): string {
    if (!claim?.claimedAt) return 'unknown';
    const ms = Date.now() - new Date(claim.claimedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const mins = Math.floor(ms / 60_000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

const HELD_MEMO_KEY = 'thalassa_skipper_held';

/** Remember whether this device held the claim, across cold boots.
 *  Without this, being displaced while the app is CLOSED goes unnoticed — and
 *  that is the likely case: the other device takes over between passages. */
export function rememberHeld(held: boolean): void {
    try {
        localStorage.setItem(HELD_MEMO_KEY, held ? '1' : '0');
    } catch {
        /* storage unavailable — in-session detection still works */
    }
}

export function readRememberedHeld(): boolean {
    try {
        return localStorage.getItem(HELD_MEMO_KEY) === '1';
    } catch {
        return false;
    }
}
