/**
 * Curated low-bridge popup + icon verdict (pure: no map, no React), so it can
 * be tested without Mapbox.
 */
import type { LowBridge } from '../../services/lowBridges';
import {
    CLEARANCE_MARGIN_M,
    clearanceBlock,
    usableAirDraftM,
    type ClearanceBlock,
} from '../../services/routing/overheadClearance';

function esc(value: unknown): string {
    let text = '';
    try {
        text = String(value ?? '');
    } catch {
        return '';
    }
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The router's verdict on a curated bridge for this mast
 * (services/routing/overheadClearance.ts clearanceBlock): null = passes
 * (charted clearance ≥ air draft + the 1 m margin); otherwise why every route
 * is blocked there — too low, unknown or only estimated clearance, or no air
 * draft set. Phase 2a review (2026-09-30): the popup used to disagree with the
 * router (no margin, estimates read as charted, "Routing is NOT gated here"
 * over a bridge the router blocks).
 */
export function bridgeClearanceVerdict(b: LowBridge, airDraftM: number | null): ClearanceBlock | null {
    const clearanceM = typeof b.clearanceM === 'number' && Number.isFinite(b.clearanceM) ? b.clearanceM : null;
    return clearanceBlock({ clearanceM, opening: false, estimated: b.estimated === true }, airDraftM);
}

/** The icon is neutral only where the router lets a route pass. */
export function bridgeMarkerPassable(b: LowBridge, airDraftM: number | null): boolean {
    return bridgeClearanceVerdict(b, airDraftM) === null;
}

export function bridgePopupHtml(b: LowBridge, airDraftM: number | null): string {
    const block = bridgeClearanceVerdict(b, airDraftM);
    const air = usableAirDraftM(airDraftM);
    const margin = CLEARANCE_MARGIN_M.toFixed(1);
    const danger = (text: string) =>
        `<span style="color:var(--day-ui-danger, #f87171);font-weight:700;">${text}</span>`;
    const verdict =
        block === null
            ? `<span style="color:var(--day-ui-success, #4ade80);">Clears your ${(air as number).toFixed(1)} m air draft with the ${margin} m margin.</span>`
            : block === 'air-draft-unset'
              ? danger(
                    'Your air draft is not set, so this clearance cannot be checked — routes are blocked here. Set it in Vessel settings.',
                )
              : block === 'too-low'
                ? danger(
                      `IMPASSABLE for your ${(air as number).toFixed(1)} m air draft (it needs ${((air as number) + CLEARANCE_MARGIN_M).toFixed(1)} m with the ${margin} m margin) — routes are blocked here.`,
                  )
                : b.clearanceM === null
                  ? danger(
                        'No published clearance, so it is treated as too low — routes are blocked here. Verify locally.',
                    )
                  : danger(
                        'The clearance is only an estimate, so it is treated as unknown — routes are blocked here. Verify locally.',
                    );
    const clearanceLine =
        b.clearanceM === null
            ? 'Vertical clearance not charted'
            : `Vertical clearance ${b.clearanceM.toFixed(1)} m${b.estimated ? ' (estimated — verify locally)' : ''}`;
    return `
      <div style="font-family:inherit;color:var(--day-ui-text, #e2e8f0);max-width:240px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:var(--day-ui-muted, #94a3b8);margin-bottom:2px;">🌉 FIXED BRIDGE</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">${esc(b.name)}</div>
        <div style="font-size:11px;color:var(--day-ui-muted, #cbd5e1);margin-bottom:4px;">${clearanceLine}</div>
        <div style="font-size:11px;">${verdict}</div>
      </div>`;
}
