/**
 * The hero band's environmental chip strip.
 */
import React from 'react';
import { type MetricChipData } from './types';

/** Compact icon-and-metric chip used on the hero band's environmental
 *  strip. Tabular-num alignment + monospace so a row of chips reads
 *  like a row of instrument readouts. */
const MetricChip: React.FC<MetricChipData> = ({ icon, label, value, unit, suffix, color, ariaLabel }) => (
    <span
        className="inline-flex items-center gap-1 font-mono tabular-nums whitespace-nowrap text-[13px] leading-none"
        style={color ? { color } : undefined}
        aria-label={ariaLabel}
        title={ariaLabel}
    >
        {icon && (
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-white/70 [&_svg]:w-3.5 [&_svg]:h-3.5">
                {icon}
            </span>
        )}
        {label && <span className="text-[11px] uppercase tracking-wider text-white/60">{label}</span>}
        {/* The VALUE is the datum the skipper is actually reading at a glance,
            so it carries the size. Labels and units stay subordinate but sit at
            11px rather than 10px — the project's own stated legibility floor. */}
        <span className={color ? 'font-bold text-xl leading-none' : 'text-[17px] font-semibold text-white/90'}>
            {value}
        </span>
        {unit && <span className="text-[11px] text-white/60">{unit}</span>}
        {suffix && <span className="text-[11px] text-white/60 ml-0.5">{suffix}</span>}
    </span>
);

/** A flex-wrap strip of MetricChips, distributed evenly across the
 *  row. Renders nothing when empty so we don't draw a hairline border
 *  for no payload. The optional top border slots in only when the
 *  row above isn't already drawing one (i.e. when SOG/COG isn't
 *  present).
 *
 *  Layout: `justify-between` on the parent spreads chips edge-to-edge
 *  across the available width — wind on the far left, tide on the
 *  far right — instead of clumping to the left as a left-justified
 *  row. When too many chips fit and they wrap, the second row
 *  distributes the same way. */
export const MetricChipStrip: React.FC<{ chips: MetricChipData[]; showTopBorder?: boolean }> = ({
    chips,
    showTopBorder,
}) => {
    if (chips.length === 0) return null;
    return (
        <div
            className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 pt-1 pb-2 ${
                showTopBorder ? 'border-t border-white/6' : ''
            }`}
        >
            {chips.map((chip) => (
                <MetricChip {...chip} key={chip.key} />
            ))}
        </div>
    );
};
