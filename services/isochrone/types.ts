/**
 * Isochrone Router — Type definitions and configuration.
 */

import type { ComfortParams } from '../../types/settings';

// ── Wind Field Interface ─────────────────────────────────────────

export interface WindField {
    /** Get wind at a position and time offset (hours from departure) */
    getWind(
        lat: number,
        lon: number,
        timeOffsetHours: number,
    ): {
        speed: number; // kts
        direction: number; // degrees true (from which wind blows)
    } | null;
}

// ── Configuration ────────────────────────────────────────────────

export interface IsochroneConfig {
    timeStepHours: number; // time between wavefronts (default: 3)
    maxHours: number; // maximum passage duration (default: 168 = 7 days)
    bearingCount: number; // number of fan-out bearings (default: 72 → 5°)
    minBearingDeg: number; // narrowest bearing to destination (default: -90)
    maxBearingDeg: number; // widest bearing from destination (default: +90)
    vesselDraft: number; // vessel draft in metres (for depth penalties)
    minDepthM: number | null; // minimum safe depth in metres (draft+1m for coastal) — null = disabled
    minWindSpeed: number; // kts — below this, use motoring speed
    motoringSpeed: number; // kts — fallback when wind too light
    useDepthPenalty: boolean; // query GEBCO for depth-aware routing
    comfortParams?: ComfortParams; // user safety thresholds — cells exceeding these are treated as obstacles
}

export const DEFAULT_ISOCHRONE_CONFIG: IsochroneConfig = {
    timeStepHours: 6, // 6h steps for speed (halves iterations vs 3h)
    maxHours: 720, // 30 days (long passages e.g. Townsville→Perth)
    bearingCount: 36, // 10° increments (good balance of speed vs resolution)
    minBearingDeg: -180, // Full 360° fan — enables around-continent routing
    maxBearingDeg: 180,
    vesselDraft: 2.5,
    minDepthM: null, // null = no shallow-water flagging (ocean passages)
    minWindSpeed: 4,
    motoringSpeed: 5,
    useDepthPenalty: true, // Land avoidance enabled (instant with BathymetryCache)
};

// ── Node & Result Types ──────────────────────────────────────────

export interface IsochroneNode {
    lat: number;
    lon: number;
    timeHours: number; // hours from departure
    bearing: number; // bearing taken to reach this node
    speed: number; // kts achieved
    tws: number; // true wind speed at this point
    twa: number; // true wind angle at this point
    depth_m?: number | null;
    distToDest?: number; // NM to destination (cached for pruning perf)
    parentIndex: number | null; // index in previous isochrone
    distance: number; // cumulative NM from departure
}

export interface Isochrone {
    timeHours: number;
    nodes: IsochroneNode[];
}

export interface IsochroneResult {
    route: IsochroneNode[]; // optimal path (departure → arrival)
    isochrones: Isochrone[]; // all wavefronts (for visualisation)
    totalDistanceNM: number;
    totalDurationHours: number;
    arrivalTime: string; // ISO
    routeCoordinates: [number, number][]; // [lon, lat] GeoJSON order
    shallowFlags: boolean[]; // parallel to routeCoordinates — true if depth < minDepthM
}

// ── Turn Waypoint Types ──────────────────────────────────────────

export interface TurnWaypoint {
    id: string; // "WP1", "WP2", etc.
    lat: number;
    lon: number;
    bearingChange: number; // degrees of course change
    bearing: number; // new bearing after turn
    timeHours: number; // hours from departure
    distanceNM: number; // cumulative NM from departure
    speed: number; // boat speed at this point
    tws: number; // true wind speed
    twa: number; // true wind angle
    eta: string; // ISO timestamp
}
