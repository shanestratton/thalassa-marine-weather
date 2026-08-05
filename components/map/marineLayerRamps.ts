/**
 * Shared visual contracts for CMEMS marine layers.
 *
 * The WebGL shaders still own their interpolation math, while the map legend
 * consumes these exact low-to-high stops. Keeping the CSS gradients here makes
 * it difficult for two legend surfaces to drift independently from the shader
 * palettes again.
 */

const verticalGradient = (colors: readonly string[]): string => `linear-gradient(to top, ${colors.join(', ')})`;

/** Current speed and significant-wave-height shaders use the same palette. */
export const CURRENT_WAVE_RAMP_HEX = ['#1a4d8c', '#33a6d9', '#8ccc8c', '#f2cc66', '#f2734d', '#d9404d'] as const;

export const SST_RAMP_HEX = ['#1f1466', '#2659bf', '#40b2d9', '#66cc73', '#f2eb66', '#f28c4d', '#d93333'] as const;

export const CHL_RAMP_HEX = ['#1a5966', '#268c59', '#59bf4d', '#bfd940', '#f2cc26', '#f28026'] as const;

export const MLD_RAMP_HEX = ['#f5eb66', '#fa9f33', '#eb4d4d', '#c72e80', '#73198c', '#1a0d4d'] as const;

export const CURRENT_WAVE_GRADIENT = verticalGradient(CURRENT_WAVE_RAMP_HEX);
export const SST_GRADIENT = verticalGradient(SST_RAMP_HEX);
export const CHL_GRADIENT = verticalGradient(CHL_RAMP_HEX);
export const MLD_GRADIENT = verticalGradient(MLD_RAMP_HEX);

/** Full plausible SST display domain accepted by the verified CMEMS loader. */
export const SST_DISPLAY_MIN_C = -3;
export const SST_DISPLAY_MAX_C = 40;
export const SST_DISPLAY_SPAN_C = SST_DISPLAY_MAX_C - SST_DISPLAY_MIN_C;

/** Encode signed SST to the normalized unsigned byte consumed by WebGL. */
export function encodeSstTemperatureByte(tempCelsius: number): number {
    if (!Number.isFinite(tempCelsius)) return 0;
    const normalized = (tempCelsius - SST_DISPLAY_MIN_C) / SST_DISPLAY_SPAN_C;
    return Math.round(Math.min(1, Math.max(0, normalized)) * 255);
}
