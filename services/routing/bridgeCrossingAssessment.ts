/** Full interval estimate, pending integration with the complete local reader.
 * Existing routers are unchanged; unknown proof remains blocked. */
import { chartStructureClearance, CLEARANCE_MARGIN_M, usableAirDraftM } from './overheadClearance';
import { isReviewedWaterInterval, type WaterIntervalContext } from '../tides/reviewedWaterInterval';
import { isReviewedBridgeOpening, type BridgeOpeningRequest } from './bridgeOperatingWindows';
import type { ChartBridgeHeightContext } from './bridgeTideEstimate';
export type BridgeCrossingAssessment =
    | { kind: 'blocked'; reason: string }
    | {
          kind: 'closed-span-estimate' | 'opening-required';
          reserveAboveMarginM: number;
          fromMs: number;
          untilMs: number;
          aboardOnly: boolean;
          requiresActualOpening: boolean;
      };
export function assessBridgeCrossing(
    bridge: ChartBridgeHeightContext,
    airDraftM: number | null,
    water: unknown,
    context: WaterIntervalContext,
    opening: unknown = null,
    openingRequest: BridgeOpeningRequest | null = null,
): BridgeCrossingAssessment {
    const block = (reason: string): BridgeCrossingAssessment => ({ kind: 'blocked', reason });
    const air = usableAirDraftM(airDraftM),
        clearance = chartStructureClearance('BRIDGE', bridge.properties);
    if (
        !bridge.featureKey ||
        bridge.estimated ||
        air === null ||
        clearance.clearanceM === null ||
        clearance.estimated ||
        bridge.chartContentKey !== context.chartContentKey ||
        bridge.heightDatumId !== context.targetDatumId ||
        bridge.heightDatumEpoch !== context.targetDatumEpoch ||
        context.use !== 'overhead'
    )
        return block('Closed/safe charted clearance, measured air draft or exact overhead datum is unknown.');
    if (!isReviewedWaterInterval(water, context))
        return block('Complete reviewed overhead water interval is unavailable.');
    const required = air + CLEARANCE_MARGIN_M,
        closedReserve = clearance.clearanceM - water.maxHighM - required;
    if (closedReserve >= 0)
        return {
            kind: 'closed-span-estimate',
            reserveAboveMarginM: closedReserve,
            fromMs: context.fromMs,
            untilMs: context.untilMs,
            aboardOnly: water.aboardOnly,
            requiresActualOpening: false,
        };
    if (!clearance.opening) return block('The charted span is below the air-draft margin over this interval.');
    const raw = bridge.properties.VERCOP ?? bridge.properties.vercop;
    const openM = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(openM) || openM < 0) return block('Charted open clearance is unknown.');
    const openReserve = openM - water.maxHighM - required;
    if (openReserve < 0) return block('Even the charted open clearance is below the air-draft margin.');
    if (
        !openingRequest ||
        openingRequest.lifetimeKey !== context.lifetimeKey ||
        openingRequest.bridgeFeatureKey !== bridge.featureKey ||
        openingRequest.chartContentKey !== context.chartContentKey ||
        openingRequest.fromMs !== context.fromMs ||
        openingRequest.untilMs !== context.untilMs ||
        openingRequest.nowMs !== context.nowMs ||
        !isReviewedBridgeOpening(opening, openingRequest)
    )
        return block('A current reviewed full opening/notice/closure interval is required.');
    return {
        kind: 'opening-required',
        reserveAboveMarginM: openReserve,
        fromMs: context.fromMs,
        untilMs: context.untilMs,
        aboardOnly: water.aboardOnly,
        requiresActualOpening: true,
    };
}
