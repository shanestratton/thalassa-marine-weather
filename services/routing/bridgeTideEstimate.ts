/** An instant, aboard estimate in the bridge's actual height plane. No
 * operating schedule, safe window or navigation permission is inferred. */
import { chartStructureClearance, CLEARANCE_MARGIN_M, usableAirDraftM } from './overheadClearance';
import { isReviewedStationTideEstimate, type TideNavigationContext } from '../tides/sampledTideNavigation';
import { isReviewedSpatialTideEstimate } from '../tides/nearbySampledTides';

export interface ChartBridgeHeightContext {
    /** Exact feature and chart content selected by the complete local reader. */
    featureKey: string;
    chartContentKey: string;
    heightDatumId: string;
    heightDatumEpoch: string;
    /** Curated estimates cannot become charted/surveyed clearance. */
    estimated: boolean;
    properties: Record<string, unknown>;
}
export type BridgeTideEstimate =
    | { kind: 'unknown'; reason: string }
    | {
          kind: 'instant-estimate';
          featureKey: string;
          atMs: number;
          clearanceM: number;
          reserveAboveMarginM: number;
          aboveMargin: boolean;
          openingBridge: boolean;
          openingPermission: 'unknown';
          aboardOnly: boolean;
      };

export function bridgeClearanceAtSample(
    bridge: ChartBridgeHeightContext,
    airDraftM: number | null,
    water: unknown,
    context: TideNavigationContext,
): BridgeTideEstimate {
    const unknown = (reason: string): BridgeTideEstimate => ({ kind: 'unknown', reason });
    if (
        !bridge.featureKey ||
        bridge.featureKey.length > 512 ||
        bridge.estimated ||
        bridge.chartContentKey !== context.chartContentKey ||
        bridge.heightDatumId !== context.targetDatumId ||
        bridge.heightDatumEpoch !== context.targetDatumEpoch ||
        context.use !== 'overhead'
    )
        return unknown('Exact charted bridge/height datum evidence unavailable.');
    const air = usableAirDraftM(airDraftM),
        clearance = chartStructureClearance('BRIDGE', bridge.properties);
    if (air === null || clearance.clearanceM === null || clearance.estimated)
        return unknown('Measured air draft or closed/safe charted clearance unavailable.');
    if (!isReviewedStationTideEstimate(water, context) && !isReviewedSpatialTideEstimate(water, context))
        return unknown('Reviewed water level in this overhead datum is unavailable.');
    // High water is adverse for air clearance. The review's complete declared
    // uncertainty is already included in highM; do not credit lowM here.
    const clearanceM = clearance.clearanceM - water.highM;
    const reserveAboveMarginM = clearanceM - air - CLEARANCE_MARGIN_M;
    return {
        kind: 'instant-estimate',
        featureKey: bridge.featureKey,
        atMs: context.atMs,
        clearanceM,
        reserveAboveMarginM,
        aboveMargin: reserveAboveMarginM >= 0,
        openingBridge: clearance.opening,
        openingPermission: 'unknown',
        aboardOnly: water.aboardOnly,
    };
}
