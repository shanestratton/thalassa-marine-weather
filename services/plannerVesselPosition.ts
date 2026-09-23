import { busFix, piFix, type BoatFix } from './boatPositionChain';
import { CloudTelemetryService } from './CloudTelemetryService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';

export const PLANNER_LIVE_FIX_MS = 60_000;
const LAST_KNOWN_LIMIT_MS = 24 * 60 * 60_000;

export function validPlannerVesselFix(fix: BoatFix | null, maxAgeMs: number, now = Date.now()): fix is BoatFix {
    return (
        !!fix &&
        Number.isFinite(fix.latitude) &&
        Math.abs(fix.latitude) <= 90 &&
        Number.isFinite(fix.longitude) &&
        Math.abs(fix.longitude) <= 180 &&
        Number.isFinite(fix.timestamp) &&
        fix.timestamp > 0 &&
        now - fix.timestamp >= -5_000 &&
        now - fix.timestamp <= maxAgeMs
    );
}

/** Display only: never writes a weather selection, route endpoint or GPS fix.
 * In a browser ashore the computer's position is NOT the yacht's position. */
export async function readPlannerVesselPosition(): Promise<BoatFix | null> {
    const scope = getAuthIdentityScope();
    const bus = busFix();
    if (validPlannerVesselFix(bus, 15_000)) return bus;
    const pi = await piFix(2_500);
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    if (validPlannerVesselFix(pi, 15_000)) return pi;
    if (!scope.userId) return null;
    const report = await CloudTelemetryService.readOnce();
    if (!isAuthIdentityScopeCurrent(scope) || !report) return null;
    const fix: BoatFix = {
        latitude: report.snapshot.lat ?? NaN,
        longitude: report.snapshot.lon ?? NaN,
        timestamp: Math.min(report.snapshot.positionSampleAt ?? report.reportedAt, report.reportedAt),
        rung: 'cloud',
        source: report.source === 'pi' ? 'pi-cloud' : 'skipper-device-cloud',
    };
    return validPlannerVesselFix(fix, LAST_KNOWN_LIMIT_MS) ? fix : null;
}

export function plannerVesselLabel(fix: BoatFix, now = Date.now()): string {
    const age = Math.max(0, now - fix.timestamp);
    if (age <= PLANNER_LIVE_FIX_MS) return 'Yacht position · reported just now';
    const minutes = Math.floor(age / 60_000);
    return `Last reported yacht position · ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`} ago`;
}
