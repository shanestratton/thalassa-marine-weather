import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../../stores/uiStore';

describe('uiStore', () => {
    beforeEach(() => {
        useUIStore.setState({
            currentView: 'dashboard',
            previousView: 'dashboard',
            transitionDirection: 'tab',
        });
    });

    describe('setPage', () => {
        it('sets current view', () => {
            useUIStore.getState().setPage('map');
            expect(useUIStore.getState().currentView).toBe('map');
        });

        it('stores previous view', () => {
            useUIStore.getState().setPage('map');
            expect(useUIStore.getState().previousView).toBe('dashboard');
        });

        it('uses tab direction between tab pages', () => {
            useUIStore.getState().setPage('map');
            expect(useUIStore.getState().transitionDirection).toBe('tab');
        });

        // Week-2 five-tab IA: chat (Scuttlebutt) moved under Vessel →
        // Wardroom, so leaving it for the Vessel hub is a POP up the
        // hierarchy, not a tab slide.
        it('uses pop direction from chat back to vessel', () => {
            useUIStore.setState({ currentView: 'chat' });
            useUIStore.getState().setPage('vessel');
            expect(useUIStore.getState().transitionDirection).toBe('pop');
        });

        it('uses push direction to overlay pages', () => {
            useUIStore.getState().setPage('settings');
            expect(useUIStore.getState().transitionDirection).toBe('push');
        });

        // voyage (Plan) was promoted from an overlay to a top-level tab in
        // the Week-2 restructure — dashboard → voyage is now tab-to-tab.
        it('uses tab direction to the voyage (Plan) tab', () => {
            useUIStore.getState().setPage('voyage');
            expect(useUIStore.getState().transitionDirection).toBe('tab');
        });

        it('uses tab direction to the details (Log) tab', () => {
            useUIStore.getState().setPage('details');
            expect(useUIStore.getState().transitionDirection).toBe('tab');
        });

        it('uses pop direction from overlay back to tab', () => {
            useUIStore.setState({ currentView: 'settings' });
            useUIStore.getState().setPage('dashboard');
            expect(useUIStore.getState().transitionDirection).toBe('pop');
        });

        it('uses push direction from tab to vessel child', () => {
            useUIStore.setState({ currentView: 'vessel' });
            useUIStore.getState().setPage('compass');
            expect(useUIStore.getState().transitionDirection).toBe('push');
        });

        it('uses push direction between vessel children', () => {
            useUIStore.setState({ currentView: 'compass' });
            useUIStore.getState().setPage('polars');
            expect(useUIStore.getState().transitionDirection).toBe('push');
        });

        it('uses pop direction from vessel child back to tab', () => {
            useUIStore.setState({ currentView: 'equipment' });
            useUIStore.getState().setPage('vessel');
            expect(useUIStore.getState().transitionDirection).toBe('pop');
        });

        it.each([
            'guardian',
            'radio',
            'mob',
            'crew',
            'checklists',
            'galley',
            'avnav',
            'encLibrary',
            // 'notices' retired as a route (binder review 2026-09-02) —
            // notices live on the OBS chart layer.
            'gpx-import',
        ])('treats %s as a Vessel child for return transitions', (child) => {
            useUIStore.setState({ currentView: child });
            useUIStore.getState().setPage('vessel');
            expect(useUIStore.getState().transitionDirection).toBe('pop');
        });
    });
});
