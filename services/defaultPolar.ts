/**
 * Default Polar Data — Generic 38ft cruising yacht performance curve.
 *
 * Used when the user hasn't uploaded their own polar data.
 * Based on typical cruising yacht performance (e.g., Beneteau Oceanis 38).
 *
 * Matrix layout: matrix[angleIdx][windSpeedIdx] = boat speed in knots
 *
 * The values are conservative — real polars would be faster upwind
 * and much faster on a reach. This ensures the isochrone engine
 * produces reasonable routes without overestimating capability.
 */

import type { PolarData } from '../types';

export const DEFAULT_CRUISING_POLAR: PolarData = {
    windSpeeds: [4, 6, 8, 10, 12, 15, 20, 25, 30],
    angles: [30, 45, 60, 75, 90, 110, 120, 135, 150, 165, 180],
    matrix: [
        // TWA 30° — close-hauled, pinching
        [0.5, 1.5, 2.5, 3.2, 3.8, 4.2, 4.5, 4.2, 3.8],
        // TWA 45° — close-hauled
        [1.2, 2.5, 3.5, 4.2, 4.8, 5.2, 5.5, 5.0, 4.5],
        // TWA 60° — close reach
        [1.8, 3.2, 4.2, 5.0, 5.5, 6.0, 6.3, 5.8, 5.2],
        // TWA 75° — close reach to beam
        [2.0, 3.5, 4.5, 5.3, 5.8, 6.3, 6.5, 6.0, 5.5],
        // TWA 90° — beam reach (fastest point of sail)
        [2.2, 3.8, 4.8, 5.5, 6.0, 6.5, 6.8, 6.2, 5.5],
        // TWA 110° — broad reach
        [2.0, 3.5, 4.5, 5.2, 5.7, 6.2, 6.5, 6.0, 5.3],
        // TWA 120° — broad reach
        [1.8, 3.2, 4.2, 5.0, 5.5, 6.0, 6.3, 5.8, 5.0],
        // TWA 135° — broad reach to run
        [1.5, 2.8, 3.8, 4.5, 5.0, 5.5, 5.8, 5.3, 4.5],
        // TWA 150° — deep run
        [1.2, 2.5, 3.5, 4.2, 4.8, 5.2, 5.5, 5.0, 4.2],
        // TWA 165° — nearly dead downwind
        [1.0, 2.2, 3.0, 3.8, 4.3, 4.8, 5.0, 4.5, 3.8],
        // TWA 180° — dead downwind
        [0.8, 2.0, 2.8, 3.5, 4.0, 4.5, 4.8, 4.2, 3.5],
    ],
};

/**
 * Default motorboat performance — fixed speed regardless of wind.
 * Used when vessel type is 'motor' or no polars apply.
 */
export const DEFAULT_MOTOR_POLAR: PolarData = {
    windSpeeds: [0, 10, 20, 30, 40],
    angles: [0, 45, 90, 135, 180],
    matrix: [
        // Motor vessels maintain constant speed regardless of TWA
        // (slight penalty in heavy headwinds)
        [8.0, 8.0, 7.5, 6.5, 5.5],
        [8.0, 8.0, 7.5, 6.5, 5.5],
        [8.0, 8.0, 8.0, 7.0, 6.0],
        [8.0, 8.0, 8.0, 7.5, 6.5],
        [8.0, 8.0, 8.0, 7.5, 6.5],
    ],
};
