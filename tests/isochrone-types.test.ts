/**
 * Isochrone Types & Config — Unit tests
 *
 * Tests default configuration values and type validation.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_ISOCHRONE_CONFIG } from '../services/isochrone/types';
import type { IsochroneConfig, IsochroneNode, IsochroneResult, TurnWaypoint } from '../services/isochrone/types';

describe('DEFAULT_ISOCHRONE_CONFIG', () => {
    it('has 6h time steps', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.timeStepHours).toBe(6);
    });

    it('allows 30-day passages (720 hours)', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.maxHours).toBe(720);
    });

    it('uses 36 bearings (10° increments)', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.bearingCount).toBe(36);
    });

    it('full 360° fan for around-continent routing', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.minBearingDeg).toBe(-180);
        expect(DEFAULT_ISOCHRONE_CONFIG.maxBearingDeg).toBe(180);
    });

    it('default vessel draft is 2.5m', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.vesselDraft).toBe(2.5);
    });

    it('minDepthM is null (no shallow-water flagging)', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.minDepthM).toBeNull();
    });

    it('motoring speed is 5 kts', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.motoringSpeed).toBe(5);
    });

    it('minWindSpeed is 4 kts', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.minWindSpeed).toBe(4);
    });

    it('depth penalty is enabled by default', () => {
        expect(DEFAULT_ISOCHRONE_CONFIG.useDepthPenalty).toBe(true);
    });
});

describe('IsochroneNode type', () => {
    it('has all required navigation fields', () => {
        const node: IsochroneNode = {
            lat: -33.868,
            lon: 151.209,
            timeHours: 12,
            bearing: 180,
            speed: 6.5,
            tws: 15,
            twa: 90,
            parentIndex: null,
            distance: 78,
        };
        expect(node.lat).toBe(-33.868);
        expect(node.timeHours).toBe(12);
        expect(node.parentIndex).toBeNull();
    });

    it('supports optional depth_m field', () => {
        const node: IsochroneNode = {
            lat: 0,
            lon: 0,
            timeHours: 0,
            bearing: 0,
            speed: 0,
            tws: 0,
            twa: 0,
            parentIndex: null,
            distance: 0,
            depth_m: -45,
        };
        expect(node.depth_m).toBe(-45);
    });
});

describe('TurnWaypoint type', () => {
    it('includes waypoint identification and navigation data', () => {
        const wp: TurnWaypoint = {
            id: 'WP1',
            lat: -33.5,
            lon: 151.5,
            bearingChange: 25,
            bearing: 205,
            timeHours: 6,
            distanceNM: 38.5,
            speed: 6.2,
            tws: 14,
            twa: 95,
            eta: '2025-06-15T18:00:00.000Z',
        };
        expect(wp.id).toBe('WP1');
        expect(wp.bearingChange).toBe(25);
        expect(wp.eta).toBeTruthy();
    });
});
