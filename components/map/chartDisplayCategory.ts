/** Presentation presets mapped to the existing scrubber; never hide its safety floor. */
export type ChartDisplayCategory = 'base' | 'standard' | 'all';
export const CATEGORY_DETAIL: Record<ChartDisplayCategory, number> = { base: 6, standard: 3, all: 0 };
export const DISPLAY_CATEGORIES: readonly ChartDisplayCategory[] = ['base', 'standard', 'all'];
