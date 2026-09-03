/**
 * MapHub module-scope constants, moved out of MapHub.tsx as-is.
 */
import { ENC_VEC_LAYERS } from '../EncVectorLayer';

// The only scrubber-furniture layer the imagery hide-list also owns — the
// islet land-fill dot, hidden over satellite/hybrid so it can't blanket the
// imagery. Passed to applyChartDetailLevel so its restore side yields (audit
// rank 8: LNDARE_ISLET was the ~8 Hz default-config styledata loop).
export const IMAGERY_SCRUB_OWNED: ReadonlySet<string> = new Set([ENC_VEC_LAYERS.LNDARE_ISLET]);
