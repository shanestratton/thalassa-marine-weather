import { describe, expect, it } from 'vitest';

import { waypointDepthDisplay } from '../utils/depthDisplay';

describe('waypoint depth display', () => {
    it('presents canonical negative bathymetry as a positive safe depth', () => {
        expect(waypointDepthDisplay(-45)).toEqual({ metres: 45, tone: 'safe', kind: 'water' });
    });

    it('classifies shallow negative bathymetry using its positive magnitude', () => {
        expect(waypointDepthDisplay(-8)).toEqual({ metres: 8, tone: 'danger', kind: 'water' });
    });

    it('never presents positive terrain elevation as navigable water depth', () => {
        expect(waypointDepthDisplay(8)).toEqual({ metres: 8, tone: 'danger', kind: 'land' });
    });

    it('keeps missing or corrupt depths unknown', () => {
        expect(waypointDepthDisplay(undefined)).toBeNull();
        expect(waypointDepthDisplay(Number.NaN)).toBeNull();
    });
});
