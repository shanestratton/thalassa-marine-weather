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
 *
 *  • A forgotten device must not hold the page forever (build 125; Shane at
 *    the marina 2026-10-09: "iPhone/iPad · 1353 holds the skipper claim
 *    (active 32 days ago)" — an install that no longer existed). The holder
 *    heartbeats `lastSeenAt` while it actually publishes (LiveTrickle, at most
 *    every 30 min); a device tracking with live share on takes over a claim
 *    with no sign of life for 6 h (isClaimStale) and says so once. Within the
 *    window the takeover stays a deliberate confirm. On iOS the id lives in
 *    the Keychain too, so a reinstall is the same device (deviceIdReady).
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';
import { authScopedStorageKey } from './authIdentityScope';

const log = createLogger('skipperDevice');

const DEVICE_ID_KEY = 'thalassa_device_id';
const DEVICE_NAME_KEY = 'thalassa_device_name';
const HELD_MEMO_KEY = 'thalassa_skipper_held';
let ephemeralDeviceId: string | null = null;

function createDeviceId(): string {
    if (globalThis.crypto?.randomUUID) return `dev-${globalThis.crypto.randomUUID()}`;
    if (globalThis.crypto?.getRandomValues) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
        return `dev-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    // Last-resort compatibility for obsolete/private WebViews. The timestamp
    // prevents the old constant "ephemeral" ID from making two devices appear
    // to hold the same exclusive publishing claim.
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface SkipperClaim {
    /** Device that currently speaks for the boat. */
    deviceId: string;
    /** Human label for the takeover prompt ("iPhone · 9f3a"). */
    deviceName: string;
    /** ISO — when the claim was MADE. Written once, at takeover: on its own it
     *  says nothing about whether the holder is still alive. */
    claimedAt: string;
    /** ISO — the holder's last successful publish (its heartbeat, at most every
     *  30 min while it publishes). Absent on a claim from before build 125 and
     *  on one that has not published yet; then claimedAt is all we know. */
    lastSeenAt?: string;
}

/** The holder refreshes lastSeenAt no more often than this. */
export const CLAIM_HEARTBEAT_MS = 30 * 60_000;
/** No sign of life for this long and a tracking device may take over. */
export const CLAIM_STALE_AFTER_MS = 6 * 60 * 60_000;

/** A device id we will adopt from the Keychain: the shapes this app mints
 *  (`dev-…` here, `device_…` in LocalDatabase), nothing else. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,127}$/;

function validDeviceId(value: unknown): string | null {
    const id = typeof value === 'string' ? value.trim() : '';
    return DEVICE_ID_PATTERN.test(id) ? id : null;
}

function platformName(): string {
    try {
        return Capacitor.getPlatform();
    } catch {
        return 'web';
    }
}

function isIos(): boolean {
    return platformName() === 'ios';
}

let identityRestore: Promise<string> | null = null;
let identitySettled = false;

/**
 * Set beside the id once the Keychain holds it. It lives with the app's data,
 * so a backup restore or Quick Start carries it to a new phone — which the
 * ThisDeviceOnly Keychain item never travels to. Marker here, Keychain empty:
 * the data came from another device, and so did its id.
 */
const DEVICE_ID_KEPT_KEY = 'thalassa_device_id_keychain';

function markKeptInKeychain(id: string | null): void {
    try {
        if (id) localStorage.setItem(DEVICE_ID_KEPT_KEY, id);
        else localStorage.removeItem(DEVICE_ID_KEPT_KEY);
    } catch {
        /* storage unavailable — the next launch migrates again, harmlessly */
    }
}

function keptInKeychainMarker(): string | null {
    try {
        return localStorage.getItem(DEVICE_ID_KEPT_KEY);
    } catch {
        return null;
    }
}

/** The old phone's "this device held the claim" memos came across with its
 *  data; this phone never held anything. */
function forgetRestoredHeldMemos(): void {
    try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(`${HELD_MEMO_KEY}::`)) keys.push(key);
        }
        keys.forEach((key) => localStorage.removeItem(key));
    } catch {
        /* storage unavailable — nothing was restored into it either */
    }
}

/** Adopt the Keychain's id as this launch's id, in both local copies. */
function adoptDeviceId(id: string): void {
    ephemeralDeviceId = id;
    try {
        localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
        /* storage unavailable — the in-memory copy serves this launch */
    }
}

async function restoreDeviceIdFromKeychain(): Promise<string> {
    const { readNativeDeviceIdentity, writeNativeDeviceIdentity } = await import('./anchorWatchRecoveryStorage');
    let kept: string | null;
    try {
        kept = validDeviceId(await readNativeDeviceIdentity());
    } catch (error) {
        // Unreadable is not empty: never overwrite a Keychain id we could not
        // see. This launch keeps the localStorage id.
        log.warn('device id: Keychain unreadable, keeping the local id', error);
        return getDeviceId();
    }
    if (kept) {
        if (kept !== readLocalDeviceId()) adoptDeviceId(kept);
        markKeptInKeychain(kept);
        return kept;
    }
    // The Keychain is empty but this sandbox says its id was kept there: the
    // app's data was restored from ANOTHER phone (a backup or Quick Start
    // carries localStorage, never a ThisDeviceOnly Keychain item). That id is
    // the old phone's. Keeping it would make two phones one device in the
    // claim — both publishing, the marker jumping — and the Keychain would
    // make it permanent. This phone gets an id of its own.
    const restoredFromAnotherDevice = keptInKeychainMarker() !== null;
    let id: string;
    if (restoredFromAnotherDevice) {
        id = createDeviceId();
        adoptDeviceId(id);
        markKeptInKeychain(null);
        forgetRestoredHeldMemos();
        log.warn('device id: app data came from another device, so this one gets its own id');
    } else {
        // First run with the Keychain: migrate today's id, so today's holder
        // keeps its claim.
        id = getDeviceId();
    }
    try {
        await writeNativeDeviceIdentity(id);
        markKeptInKeychain(id);
    } catch (error) {
        log.warn('device id: not kept in the Keychain (a reinstall would mint a new one)', error);
    }
    return id;
}

/**
 * This install's device id once the iOS Keychain has answered.
 *
 * The id lived only in localStorage, so a reinstall or a cleared webview
 * minted a new one and the old install's claim went on naming a device that no
 * longer existed (field days lost 2026-08-03 and 2026-10-09). On iOS the id is
 * now kept in the Keychain — this device only, never synchronised — and read
 * back on every launch; localStorage stays the web and fallback copy. Anything
 * that compares a claim against this device awaits this first.
 */
export function deviceIdReady(): Promise<string> {
    if (!isIos()) return Promise.resolve(getDeviceId());
    identityRestore ??= restoreDeviceIdFromKeychain()
        .catch(() => getDeviceId())
        .finally(() => {
            identitySettled = true;
        });
    return identityRestore;
}

/** Has this launch's id settled (the Keychain answered, or there is none)?
 *  A claim built before then may name an id the Keychain is about to replace. */
export function deviceIdSettled(): boolean {
    return identitySettled || !isIos();
}

function readLocalDeviceId(): string | null {
    try {
        return localStorage.getItem(DEVICE_ID_KEY)?.trim() || null;
    } catch {
        return null;
    }
}

/** Stable per-install id. Survives sign-out, and on iOS a reinstall too (the
 *  Keychain copy, see deviceIdReady). */
export function getDeviceId(): string {
    // The first read of a launch starts the Keychain restore, so it is under
    // way long before a claim is compared.
    if (!identityRestore && isIos()) void deviceIdReady();
    try {
        const existing = localStorage.getItem(DEVICE_ID_KEY)?.trim();
        if (existing) return existing;
        const id = ephemeralDeviceId ?? createDeviceId();
        localStorage.setItem(DEVICE_ID_KEY, id);
        ephemeralDeviceId = id;
        return id;
    } catch {
        // Private mode / storage disabled: a per-session id still keeps two
        // devices apart for as long as the app is open, which is the case that
        // matters underway.
        ephemeralDeviceId ??= createDeviceId();
        return ephemeralDeviceId;
    }
}

/** 'iPhone' or 'iPad' from the webview's own user agent. An iPad's WKWebView
 *  asks for desktop pages, so it reads "Macintosh" with a touch screen. */
function appleDeviceKind(): 'iPhone' | 'iPad' | null {
    try {
        const ua = globalThis.navigator?.userAgent ?? '';
        if (/\biPad\b/.test(ua)) return 'iPad';
        if (/\b(iPhone|iPod)\b/.test(ua)) return 'iPhone';
        if (/\bMacintosh\b/.test(ua) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1) return 'iPad';
    } catch {
        /* no navigator */
    }
    return null;
}

/** What to call this device in a sentence: "this phone", "this iPad". */
function thisDeviceNoun(): string {
    const platform = platformName();
    if (platform === 'ios') return appleDeviceKind() === 'iPad' ? 'iPad' : 'phone';
    if (platform === 'android') return 'device';
    return 'browser';
}

/** Best-effort friendly name, editable later.
 *
 *  The default must read correctly ON THE OTHER DEVICE — it is shown in
 *  "<name> is publishing" when someone else holds the claim. The old default
 *  was "This iPhone/iPad", so the takeover card on Shane's iPhone said
 *  "This iPhone/iPad is publishing" about his IPAD, which reads as "this
 *  device". The short id suffix makes two same-model devices tellable apart. */
export function getDeviceName(): string {
    try {
        const saved = localStorage.getItem(DEVICE_NAME_KEY);
        if (saved && saved.trim()) return saved.trim();
    } catch {
        /* fall through to the derived default */
    }
    const suffix = getDeviceId().slice(-4);
    const platform = platformName();
    // Says what it is (build 125): "iPhone/iPad" made the other device guess.
    if (platform === 'ios') return `${appleDeviceKind() ?? 'iPhone/iPad'} · ${suffix}`;
    if (platform === 'android') return `Android device · ${suffix}`;
    return `Browser · ${suffix}`;
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

function parseMs(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/** "45 minutes" / "7 hours" / "32 days". */
function spanLabel(ms: number): string {
    const mins = Math.max(0, Math.floor(ms / 60_000));
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
}

function agoLabel(ms: number): string {
    if (!Number.isFinite(ms) || ms < 2 * 60_000) return 'just now';
    return `${spanLabel(ms)} ago`;
}

/** The holder's last sign of life: its heartbeat, else when it claimed. */
function claimLastSeenMs(claim: SkipperClaim | null | undefined): number | null {
    const seen = parseMs(claim?.lastSeenAt);
    const claimed = parseMs(claim?.claimedAt);
    if (seen === null) return claimed;
    return claimed === null ? seen : Math.max(seen, claimed);
}

/**
 * Has the holder shown no sign of life for CLAIM_STALE_AFTER_MS? `otherSignOfLifeMs`
 * is evidence the caller found elsewhere (the account's newest live point).
 * No claim is never stale: an unclaimed boat publishes freely.
 */
export function isClaimStale(
    claim: SkipperClaim | null | undefined,
    now = Date.now(),
    otherSignOfLifeMs: number | null = null,
): boolean {
    if (!claim?.deviceId) return false;
    const seen = Math.max(claimLastSeenMs(claim) ?? -Infinity, otherSignOfLifeMs ?? -Infinity);
    return !Number.isFinite(seen) || now - seen > CLAIM_STALE_AFTER_MS;
}

/** Is this device's claim due a heartbeat? A claim made in the last half hour
 *  is its own sign of life, so a takeover is not followed by a second write. */
export function heartbeatDue(claim: SkipperClaim | null | undefined, now = Date.now()): boolean {
    if (!holdsClaim(claim)) return false;
    const seen = claimLastSeenMs(claim);
    return seen === null || now - seen >= CLAIM_HEARTBEAT_MS;
}

/** The claim after a heartbeat: same holder, same claimedAt, seen now, under
 *  this device's current name (so an old "iPhone/iPad" label heals itself). */
export function withHeartbeat(claim: SkipperClaim, now = Date.now()): SkipperClaim {
    return { ...claim, deviceName: getDeviceName(), lastSeenAt: new Date(now).toISOString() };
}

/** The same claim, as far as a guarded write or a refresh cares. */
export function sameClaim(a: SkipperClaim | null | undefined, b: SkipperClaim | null | undefined): boolean {
    if (!a?.deviceId || !b?.deviceId) return !a?.deviceId && !b?.deviceId;
    return (
        a.deviceId === b.deviceId &&
        a.claimedAt === b.claimedAt &&
        (a.lastSeenAt ?? null) === (b.lastSeenAt ?? null) &&
        a.deviceName === b.deviceName
    );
}

/**
 * What we actually know about the holder, in words: "last published 2 hours
 * ago" when it heartbeats, "claimed 32 days ago" when all we have is the claim
 * (it used to read "active 32 days ago", which it was not). Never "no sign of
 * it since": a holder on an older build publishes without a heartbeat, and only
 * the trickle's live-track check can say it went quiet — when it has, this
 * device takes the page over and says so (autoHandoverMessage).
 */
export function claimSeenPhrase(claim: SkipperClaim | null | undefined, now = Date.now()): string {
    const seen = parseMs(claim?.lastSeenAt);
    if (seen !== null) return `last published ${agoLabel(now - seen)}`;
    const claimed = parseMs(claim?.claimedAt);
    return claimed === null ? 'claimed at an unknown time' : `claimed ${agoLabel(now - claimed)}`;
}

/** The short form for a one-line row: "published 2 hours ago" / "claimed 32 days ago". */
export function claimSeenShort(claim: SkipperClaim | null | undefined, now = Date.now()): string {
    const seen = parseMs(claim?.lastSeenAt);
    if (seen !== null) return `published ${agoLabel(now - seen)}`;
    const claimed = parseMs(claim?.claimedAt);
    return claimed === null ? 'not seen' : `claimed ${agoLabel(now - claimed)}`;
}

/**
 * Said once, plainly, when this device takes over a forgotten claim. The
 * silence runs from the holder's last sign of life — its heartbeat, its claim,
 * or the account's newest live point (`newestLiveMs`, which the trickle checked
 * before taking over) — whichever is latest.
 */
export function autoHandoverMessage(
    previous: SkipperClaim,
    now = Date.now(),
    newestLiveMs: number | null = null,
): string {
    const holder = previous.deviceName?.trim() || 'The other device';
    const heartbeat = parseMs(previous.lastSeenAt);
    const live = newestLiveMs !== null && Number.isFinite(newestLiveMs) ? newestLiveMs : null;
    const published = heartbeat === null ? live : live === null ? heartbeat : Math.max(heartbeat, live);
    const claimed = parseMs(previous.claimedAt);
    let why: string;
    if (published !== null && (claimed === null || published >= claimed)) {
        why = `${holder} hadn’t published for ${spanLabel(now - published)}`;
    } else if (claimed !== null) {
        why = `${holder} hadn’t been seen for ${spanLabel(now - claimed)}`;
    } else {
        why = `${holder} had gone quiet`;
    }
    return `Publishing from this ${thisDeviceNoun()} now. ${why}.`;
}

/**
 * The App's "no longer the skipper" toast, while it is on screen. A displaced
 * device that comes back and tracks can take a forgotten claim straight back
 * in the same tick; the handover's toast then withdraws this one, so the
 * skipper never reads "stopped publishing" and "publishing now" together.
 */
let displacedNoticeId: number | null = null;

export function noteDisplacedNotice(id: number | null): void {
    displacedNoticeId = id;
}

/** The displaced notice to withdraw, once. */
export function takeDisplacedNotice(): number | null {
    const id = displacedNoticeId;
    displacedNoticeId = null;
    return id;
}

/** Remember whether this device held the claim, across cold boots.
 *  Without this, being displaced while the app is CLOSED goes unnoticed — and
 *  that is the likely case: the other device takes over between passages. */
export function rememberHeld(held: boolean): void {
    try {
        localStorage.setItem(authScopedStorageKey(HELD_MEMO_KEY), held ? '1' : '0');
    } catch {
        /* storage unavailable — in-session detection still works */
    }
}

export function readRememberedHeld(): boolean {
    try {
        return localStorage.getItem(authScopedStorageKey(HELD_MEMO_KEY)) === '1';
    } catch {
        return false;
    }
}
