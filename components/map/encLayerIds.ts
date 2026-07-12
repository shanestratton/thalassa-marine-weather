/**
 * encLayerIds — the ENC chart layer's Mapbox source + layer IDs and
 * their canonical z-order, extracted from EncVectorLayer so the popup
 * module can reference layers without a dependency cycle.
 */

// ── Source IDs ─────────────────────────────────────────────────────

export const ENC_VEC_SRC = {
    LNDARE: 'enc-vec-lndare',
    DEPARE: 'enc-vec-depare', // DEPARE + DRGARE merged
    DEPARE_GLAZE: 'enc-vec-depare-glaze', // overlap-clipped twin for the satellite glaze
    DEPCNT: 'enc-vec-depcnt',
    COALNE: 'enc-vec-coalne',
    POINTS: 'enc-vec-points', // OBSTRN + WRECKS + UWTROC merged
    NAVAIDS: 'enc-vec-navaids', // LIGHTS + BOY*/BCN* merged
    RECTRC: 'enc-vec-rectrc', // recommended tracks / leading lines
    SOUNDG: 'enc-vec-soundg', // exploded spot soundings
} as const;

// NOTE: layer-id stability is load-bearing. Click handlers, the
// master-toggle probe (BCNLAT visibility) and the hide lists all
// reference these ids — the lateral/cardinal layers keep their
// legacy '-circle' suffix even though they're symbol layers now.
// Renaming is a separate mechanical commit, never a drive-by.
export const ENC_VEC_LAYERS = {
    LNDARE: 'enc-vec-lndare-fill',
    LNDARE_ISLET: 'enc-vec-lndare-islet',
    DEPARE: 'enc-vec-depare-fill',
    /** Fine-survey water REPAINTED ABOVE land (2026-07-11: the coarse
     *  1:90k cell's crude LNDARE blob swallowed the Mooloolah river +
     *  canal estates — "where is our beautiful layer??? help help").
     *  Land-over-water is right for a cell's OWN generalisation; wrong
     *  across scales. Harbour-grade bands overrule coarse land bleed. */
    DEPARE_FINE: 'enc-vec-depare-fine-fill',
    /** Satellite-glaze fill off the overlap-CLIPPED collection: exactly
     *  one translucent band per point of water, so overlapping surveys
     *  can't stack into the hard-edged dark wedges ("80's rendering",
     *  2026-07-12). Opacity-0 in chart mode; over imagery it replaces
     *  BOTH plain DEPARE fills (which go opacity-0 — translucent twins
     *  double-paint every fine feature). */
    DEPARE_GLAZE: 'enc-vec-depare-glaze-fill',
    DEPCNT_LINE: 'enc-vec-depcnt-line',
    DEPCNT_SAFETY: 'enc-vec-depcnt-safety',
    DEPCNT_LABEL: 'enc-vec-depcnt-label',
    COALNE: 'enc-vec-coalne-line',
    OBSTRN: 'enc-vec-obstrn-circle',
    WRECKS: 'enc-vec-wrecks-circle',
    UWTROC: 'enc-vec-uwtroc-circle',
    BOYLAT: 'enc-vec-boylat-circle',
    BOYCAR: 'enc-vec-boycar-circle',
    BCNLAT: 'enc-vec-bcnlat-circle',
    BCNCAR: 'enc-vec-bcncar-circle',
    BOYSPP: 'enc-vec-boyspp-symbol',
    BCNSPP: 'enc-vec-bcnspp-symbol',
    BOYSAW: 'enc-vec-boysaw-symbol',
    BCNSAW: 'enc-vec-bcnsaw-symbol',
    BOYISD: 'enc-vec-boyisd-symbol',
    BCNISD: 'enc-vec-bcnisd-symbol',
    LIGHTS: 'enc-vec-lights-symbol',
    RECTRC: 'enc-vec-rectrc-line',
    RECTRC_LABEL: 'enc-vec-rectrc-label',
    SOUNDG: 'enc-vec-soundg-label',
    NAVAIDS_LABEL: 'enc-vec-navaids-label',
    POINTS_LABEL: 'enc-vec-points-label',
} as const;

// All layer IDs, ordered bottom-to-top for correct stacking. The
// mount is idempotent-additive: each layer is inserted before the
// next HIGHER layer that already exists (see beforeIdFor), so new
// layers slot into a live map in the right place rather than
// appending on top.
export const ALL_LAYER_IDS = [
    ENC_VEC_LAYERS.DEPARE, // bottom (water fills)
    ENC_VEC_LAYERS.DEPARE_GLAZE, // satellite twin directly above (opacity-0 on chart)
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.LNDARE_ISLET,
    ENC_VEC_LAYERS.COALNE,
    ENC_VEC_LAYERS.DEPARE_FINE, // fine-survey water beats coarse land bleed
    // Contours + the bold safety contour sit ABOVE the fine repaint.
    // They used to sit just above DEPARE — when the fine-survey twin
    // landed (0eb6cc19) SOUNDG was re-slotted above it but the DEPCNT
    // trio was forgotten, so the 0.95-opacity repaint buried the one
    // keel-aware line on the chart across ALL fine-survey harbour
    // water in default chart mode (2026-07-12 audit, CRITICAL).
    ENC_VEC_LAYERS.DEPCNT_LINE,
    ENC_VEC_LAYERS.DEPCNT_SAFETY,
    ENC_VEC_LAYERS.DEPCNT_LABEL,
    ENC_VEC_LAYERS.SOUNDG, // depth numbers under everything interactive
    ENC_VEC_LAYERS.RECTRC, // leads under the marks that define them
    ENC_VEC_LAYERS.BOYLAT,
    ENC_VEC_LAYERS.BCNLAT,
    ENC_VEC_LAYERS.BOYCAR,
    ENC_VEC_LAYERS.BCNCAR,
    ENC_VEC_LAYERS.BOYSPP,
    ENC_VEC_LAYERS.BCNSPP,
    ENC_VEC_LAYERS.BOYSAW,
    ENC_VEC_LAYERS.BCNSAW,
    ENC_VEC_LAYERS.BOYISD,
    ENC_VEC_LAYERS.BCNISD,
    ENC_VEC_LAYERS.OBSTRN,
    ENC_VEC_LAYERS.WRECKS,
    ENC_VEC_LAYERS.UWTROC,
    ENC_VEC_LAYERS.LIGHTS,
    ENC_VEC_LAYERS.RECTRC_LABEL,
    ENC_VEC_LAYERS.NAVAIDS_LABEL, // labels topmost
    ENC_VEC_LAYERS.POINTS_LABEL,
];

// Layers that take click handlers. Excludes the text-only label
// layers — a tap on a label should fall through to the symbol or
// polygon underneath, not open a generic popup. RECTRC is excluded
// too: a thin lead line under a tracer tap must never swallow the
// pin drop with a popup.
export const CLICKABLE_LAYER_IDS = ALL_LAYER_IDS.filter(
    (id) =>
        id !== ENC_VEC_LAYERS.NAVAIDS_LABEL &&
        id !== ENC_VEC_LAYERS.POINTS_LABEL &&
        id !== ENC_VEC_LAYERS.RECTRC &&
        id !== ENC_VEC_LAYERS.RECTRC_LABEL &&
        id !== ENC_VEC_LAYERS.SOUNDG &&
        id !== ENC_VEC_LAYERS.DEPCNT_LABEL &&
        id !== ENC_VEC_LAYERS.DEPARE_FINE &&
        id !== ENC_VEC_LAYERS.DEPARE_GLAZE,
);
