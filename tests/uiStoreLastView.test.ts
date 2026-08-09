/**
 * The breadcrumb that lets a killed web layer put the skipper back.
 *
 * When iOS reclaims the WebContent process there is no warning and no unload
 * event. Whatever is going to record where the skipper was must already have
 * been written, synchronously, before the process died — which is why this is
 * localStorage and not Preferences or IndexedDB.
 *
 * The crumb is a record only. Restoring from it happens once, after the native
 * side confirms a recent kill (services/webContentKill.ts). Cold-boot
 * behaviour is deliberately untouched: d812494a fixed a bug where the app
 * yanked the skipper to the dashboard mid-route-plan, and a restore that fired
 * on every launch would be the same class of surprise in the other direction.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readLastView, useUIStore } from '../stores/uiStore';

describe('the last-view breadcrumb', () => {
    beforeEach(() => {
        localStorage.clear();
        useUIStore.setState({ currentView: 'dashboard', previousView: 'dashboard' });
    });

    it('records the planning screen the moment the skipper opens it', () => {
        useUIStore.getState().setPage('voyage');
        expect(readLastView()?.view).toBe('voyage');
    });

    it('is written synchronously — a kill gives no chance to flush', () => {
        // No await anywhere. If this ever becomes async the crumb is lost in
        // exactly the situation it exists for.
        useUIStore.getState().setPage('voyage');
        expect(JSON.parse(localStorage.getItem('thalassa.lastView')!).view).toBe('voyage');
    });

    it('stamps a time, so a stale crumb can be told from a fresh one', () => {
        const before = Date.now();
        useUIStore.getState().setPage('nmea');
        const crumb = readLastView()!;
        expect(crumb.at).toBeGreaterThanOrEqual(before);
        expect(crumb.at).toBeLessThanOrEqual(Date.now());
    });

    it('follows the skipper across navigations', () => {
        useUIStore.getState().setPage('voyage');
        useUIStore.getState().setPage('details');
        expect(readLastView()?.view).toBe('details');
    });

    it('never records an overlay — nobody wants to reboot into Settings', () => {
        useUIStore.getState().setPage('voyage');
        useUIStore.getState().setPage('settings');
        expect(readLastView()?.view).toBe('voyage');
        useUIStore.getState().setPage('warnings');
        expect(readLastView()?.view).toBe('voyage');
    });

    it('refuses a corrupt or hand-edited crumb instead of navigating somewhere odd', () => {
        localStorage.setItem('thalassa.lastView', 'not json');
        expect(readLastView()).toBeNull();
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'voyage' }));
        expect(readLastView()).toBeNull(); // no timestamp
        localStorage.setItem('thalassa.lastView', JSON.stringify({ at: Date.now() }));
        expect(readLastView()).toBeNull(); // no view
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'settings', at: Date.now() }));
        expect(readLastView()).toBeNull(); // overlay, even if somehow stored
    });

    it('returns null when there is no crumb at all', () => {
        expect(readLastView()).toBeNull();
    });

    it('does not itself change the boot view', () => {
        // Writing the crumb must not navigate. The restore is a separate,
        // deliberate step gated on a confirmed kill.
        useUIStore.getState().setPage('voyage');
        useUIStore.setState({ currentView: 'dashboard' });
        expect(useUIStore.getState().currentView).toBe('dashboard');
        expect(readLastView()?.view).toBe('voyage');
    });
});
