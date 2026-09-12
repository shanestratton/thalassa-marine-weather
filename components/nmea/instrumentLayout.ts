import type { CSSProperties } from 'react';

/** Pane measurements exist only in split view; normal pages retain their viewport sizing. */
export const WIND_GAUGE_HEIGHT = 'calc(var(--pane-height, 100vh) * 0.19)';
export const WIND_CELL_STYLE: CSSProperties = { maxHeight: WIND_GAUGE_HEIGHT };
export const CLOCK_MAX_WIDTH = 'min(100%, calc(var(--pane-height, 100vh) * 0.7))';
export const POSITION_FONT_SIZE = 'clamp(1.75rem, calc(var(--pane-width, 100vw) * 0.11), 3rem)';

export const windHeroStyle = (size: number): CSSProperties => ({
    width: `min(${size}px, ${WIND_GAUGE_HEIGHT})`,
    height: `min(${size}px, ${WIND_GAUGE_HEIGHT})`,
});
