import type { IsochroneResult, TurnWaypoint } from '../isochrone/types';
import type { VoyagePlan } from '../../types';
import type { AuthIdentityScope } from '../authIdentityScope';
import type { PlanLinkRow } from '../VoyageLogService';
import type { WindGrid } from '../weather/windGridEncoding';
import type { OwnshipPosition } from '../ownshipPosition';

export interface RouteReplanBase {
    token: string;
    owner: AuthIdentityScope;
    boatId: string;
    voyageId: string;
    sessionId: string;
    followKey: string;
    settingsKey: string;
    authority: { mode: string; deviceId: string | null; claimedAt: string | null };
    link: PlanLinkRow;
    fix: OwnshipPosition;
    departureTime: string;
    speed: number;
    deadlineMs: number;
    original: VoyagePlan;
    oldCoords: Array<{ lat: number; lon: number }>;
    remainingNm: number;
    oldRemainingHours: number | null;
    wind: WindGrid;
    model: string;
    sourceKey: string;
    sourceLabel: string;
}
export interface RouteReplanCandidate {
    result: IsochroneResult;
    turns: TurnWaypoint[];
    caveats: string[];
    cells: string[];
    geometryKey: string;
}
export interface RouteReplanState {
    phase: 'idle' | 'preparing' | 'computing' | 'ready' | 'accepting' | 'error';
    base: RouteReplanBase | null;
    candidate: RouteReplanCandidate | null;
    message: string | null;
}
let state: RouteReplanState = { phase: 'idle', base: null, candidate: null, message: null };
const listeners = new Set<() => void>();
export const readRouteReplan = () => state;
export const subscribeRouteReplan = (fn: () => void) => {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
};
export function setRouteReplan(next: RouteReplanState): void {
    state = next;
    listeners.forEach((fn) => fn());
}
export function cancelRouteReplan(): void {
    if (state.phase === 'accepting') return;
    setRouteReplan({ phase: 'idle', base: null, candidate: null, message: null });
}
