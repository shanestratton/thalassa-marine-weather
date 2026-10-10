import { CREDITS_STRIP_POSITION_CLASS, creditsStripTop } from './creditsStrip';
import { OPENSEAMAP_CREDIT_TEXT, OPENSEAMAP_URL } from './seamarkCredit';
import { openExternalUrl } from '../../services/externalLinks';

export interface DeskMapStripProps {
    /** Slot 0 (127-DESKMAP C1): where the charts are. Hidden keeps its box. */
    slot0: { text: string; hidden: boolean };
    /** Slot 1 (B2): OpenSeaMap's label while the Seamarks switch is on; 'down' when it is not answering. */
    seamarks: 'shown' | 'down' | null;
    /** Slot 2 (127-DESKMAP-b): the wind model's licence credit while the desk's wind draws. */
    wind?: string | null;
    /** The world tint is showing on Light (schedule brief 2): its depths are a model's. */
    seabed: boolean;
}

/**
 * The desk planner's lines under its menu, in the Obs credits strip's spot
 * (Shane 2026-09-06: "put them all in the same spot below the drop down box at
 * the top middle of the screen"). One stacked column in a fixed order, so a
 * line that wraps at a narrow width pushes the next one down instead of
 * overlapping it, and slot 0 always keeps its box: panning onto a NOAA cell
 * blanks its words, never moves the seamark line. The wind model's credit
 * (127-DESKMAP-b) is slot 2, after the seamarks. On a narrow window while tracing only
 * the seamark line stays, under the menu's icon pill (index.css
 * .thalassa-desk-tracing).
 */
export function DeskMapStrip({ slot0, seamarks, wind, seabed }: DeskMapStripProps) {
    return (
        <div
            data-testid="desk-map-strip"
            // Its look is index.css .thalassa-desk-strip (the radar pill's).
            className={`thalassa-desk-strip ${CREDITS_STRIP_POSITION_CLASS}`}
            style={{ top: creditsStripTop(0) }}
        >
            <div data-testid="desk-strip-slot-0" style={{ visibility: slot0.hidden ? 'hidden' : undefined }}>
                {slot0.text}
            </div>
            {seamarks && (
                // Cut out of the layer menu's scrim (data-map-credit), like every licence credit.
                <div
                    data-testid="desk-strip-slot-1"
                    data-map-credit
                    className={seamarks === 'down' ? 'text-amber-300' : undefined}
                >
                    {/* A narrow tracing window drops the name, which the ⓘ
                        carries: "Seamarks: community data, not verified". */}
                    Seamarks: <span className="thalassa-desk-wide">OpenSeaMap </span>
                    {seamarks === 'down' ? 'not answering' : 'community data, not verified'}{' '}
                    {/* A real link (copyable, long-presses like one), opened over
                        the app rather than replacing it: the RainViewer pill's pattern. */}
                    <a
                        href={OPENSEAMAP_URL}
                        onClick={(e) => {
                            e.preventDefault();
                            void openExternalUrl(OPENSEAMAP_URL);
                        }}
                        className="hit-target-44 text-[12px] text-slate-400"
                        aria-label={OPENSEAMAP_CREDIT_TEXT}
                    >
                        ⓘ
                    </a>
                </div>
            )}
            {wind && (
                <div data-testid="desk-strip-slot-2" data-map-credit>
                    {wind}
                </div>
            )}
            {seabed && <div data-testid="desk-strip-seabed">Seabed: model depth, not a chart</div>}
        </div>
    );
}
