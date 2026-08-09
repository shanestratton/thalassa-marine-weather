/**
 * webContentKill — did iOS just kill our web layer out from under us?
 *
 * THE PROBLEM THIS SOLVES IS AN EVIDENCE PROBLEM. Shane has reported the
 * planning screen "crashing back to the Glass page" since 2026-08-01, and every
 * investigation hit the same wall: nothing in the logs. Two genuine causes were
 * found and fixed along the way — auth churn re-navigating (d812494a) and ENC
 * memory pressure (0a607bd3) — and it still happens when he zooms in while
 * adding a leg.
 *
 * The logs are empty because iOS is not killing the app. Under memory pressure
 * it kills the WebContent process, and every line of our JavaScript dies with
 * it, logger included. The app survives, the webview reloads, and `uiStore`
 * seeds `currentView` from `bootView` at module scope — 'dashboard'. So a
 * memory kill and an ordinary cold boot are indistinguishable from inside the
 * web layer. Same destination, no evidence, and no way to tell the two apart.
 *
 * `ThalassaBridgeViewController.webViewWebContentProcessDidTerminate` is the
 * only witness that outlives the event, because it is native. It stamps a
 * record into UserDefaults using Capacitor Preferences' own key format, and
 * this module reads it on the next boot.
 *
 * WHAT IT BUYS: the next time it happens, "the page crashed" becomes a count
 * and a timestamp. That is the difference between the last two fixes — which
 * came from a device log — and this one, which had nothing to go on.
 */
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('webContentKill');

/** Must match the key written in ThalassaBridgeViewController.swift. */
const KEY = 'thalassa.webContentKill';

export interface WebContentKillRecord {
    /** How many times the web layer has been killed on this install. */
    count: number;
    /** When the most recent one happened. */
    at: Date;
    /** The URL the webview was showing. */
    url: string;
}

/**
 * Read the kill record, if the native side left one.
 *
 * Non-destructive: reading must not clear it, because more than one surface
 * wants to know (boot restores the view, diagnostics shows the count) and
 * whichever ran first would otherwise hide it from the others.
 */
export async function readWebContentKill(): Promise<WebContentKillRecord | null> {
    if (Capacitor.getPlatform() !== 'ios') return null;
    try {
        const { value } = await Preferences.get({ key: KEY });
        if (!value) return null;
        const parsed = JSON.parse(value) as { count?: number; at?: number; url?: string };
        if (typeof parsed.count !== 'number' || typeof parsed.at !== 'number') return null;
        return {
            count: parsed.count,
            // Native writes seconds since epoch; JS Date wants milliseconds.
            // Getting this wrong puts every kill in January 1970, which reads
            // as a corrupt record rather than a unit mistake.
            at: new Date(parsed.at * 1000),
            url: parsed.url ?? '',
        };
    } catch (err) {
        // A diagnostic that throws during boot would be worse than the bug it
        // is here to explain.
        log.warn('could not read the kill record', err);
        return null;
    }
}

/**
 * Was the most recent kill within `windowMs`?
 *
 * The record persists for the life of the install, so "is there a record" is
 * not the same question as "did this boot follow a kill". Only a recent one
 * should be allowed to change behaviour — restoring a view the skipper left
 * three days ago would be its own bug.
 */
export function isRecentKill(record: WebContentKillRecord | null, windowMs = 30_000, now = Date.now()): boolean {
    if (!record) return false;
    const age = now - record.at.getTime();
    // A negative age means the device clock moved backwards between the write
    // and this read. Treat it as not-recent rather than trusting it.
    return age >= 0 && age <= windowMs;
}

/** Clear the record. For the diagnostics screen's "I've seen this" action. */
export async function clearWebContentKill(): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios') return;
    try {
        await Preferences.remove({ key: KEY });
    } catch (err) {
        log.warn('could not clear the kill record', err);
    }
}
