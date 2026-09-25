/**
 * Determines the best label for precipitation based on Model Volume
 */
export const getPrecipitationLabelV2 = (
    _unused: unknown,
    modelRain: number | null,
): { label: string; value: string } => {
    // No precipitation value from the source: say so, never 'DRY'.
    if (modelRain == null) return { label: '--', value: '--' };
    // Precipitation labels based on marine model data
    if (modelRain > 5.0) return { label: 'HEAVY RAIN', value: `${modelRain.toFixed(1)} mm` };
    if (modelRain > 0.5) return { label: 'SHOWERS', value: `${modelRain.toFixed(1)} mm` };
    if (modelRain >= 0.15) {
        return { label: 'LIGHT', value: `${modelRain.toFixed(1)} mm` };
    }
    return { label: 'DRY', value: '0.0 mm' };
};
