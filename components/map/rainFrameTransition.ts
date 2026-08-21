/**
 * A load-aware handoff for parked rain raster layers.
 *
 * RainViewer/Rainbow frames are intentionally parked with
 * `layout.visibility: none`, otherwise every timeline frame downloads tiles
 * at once. That means a frame must be made visible at opacity zero and allowed
 * to load before it can replace the frame already on screen.
 */

/**
 * 0.85, was 0.75 (Shane 2026-08-21: "it needs to pop a bit more"). Rain is
 * the layer a skipper switches ON to see; at 0.75 over a dark chart it read
 * like a stain rather than weather. Still short of opaque so the coastline
 * and marks stay legible underneath.
 */
export const RAIN_FRAME_OPACITY = 0.85;
/**
 * Radar-frame enhancement (Shane 2026-08-21, "pop"). RainViewer bakes its
 * palette server-side, so these are the only dials that lift it off a dark
 * chart without inventing colours the legend does not describe. Values follow
 * the pressure-heatmap precedent (0.08/0.08), nudged up because rain competes
 * with marine-blue water rather than a neutral field.
 */
export const RAIN_FRAME_SATURATION = 0.15;
export const RAIN_FRAME_CONTRAST = 0.1;

export const RAIN_FRAME_FADE_MS = 220;
/**
 * How long a staged frame may sit tile-less before the stage is abandoned.
 * A frame whose tiles all fail (an expired RainViewer path 404s, offline
 * blip) never fires the crossfade, and without a deadline `isTransitioning()`
 * stayed true forever — which permanently froze autoplay's advance guard.
 * Failing open keeps the committed image on screen and lets playback move on.
 */
export const RAIN_FRAME_STAGE_DEADLINE_MS = 6000;

export type RainFrameEventListener = (event?: {
    sourceId?: string;
    sourceDataType?: 'metadata' | 'content' | 'visibility' | 'error';
    isSourceLoaded?: boolean;
    tile?: unknown;
}) => void;

/** The small subset of Mapbox's map API used by the transition controller. */
export interface RainFrameMap {
    getLayer(id: string): unknown;
    setLayoutProperty(id: string, property: 'visibility', value: 'visible' | 'none'): void;
    setPaintProperty(id: string, property: 'raster-opacity', value: number): void;
    on(event: 'sourcedata' | 'render', listener: RainFrameEventListener): void;
    off(event: 'sourcedata' | 'render', listener: RainFrameEventListener): void;
    isSourceLoaded(id: string): boolean;
}

type ErrorReporter = (error: unknown) => void;

function hasRainFrame(map: RainFrameMap, id: string, reportError?: ErrorReporter): boolean {
    try {
        return Boolean(map.getLayer(id));
    } catch (error) {
        reportError?.(error);
        return false;
    }
}

function setRainFrameOpacity(map: RainFrameMap, id: string, opacity: number, reportError?: ErrorReporter): boolean {
    try {
        if (!map.getLayer(id)) return false;
        map.setPaintProperty(id, 'raster-opacity', opacity);
        return true;
    } catch (error) {
        reportError?.(error);
        return false;
    }
}

function showRainFrame(map: RainFrameMap, id: string, reportError?: ErrorReporter): boolean {
    try {
        if (!map.getLayer(id)) return false;
        map.setLayoutProperty(id, 'visibility', 'visible');
        map.setPaintProperty(id, 'raster-opacity', RAIN_FRAME_OPACITY);
        return true;
    } catch (error) {
        reportError?.(error);
        return false;
    }
}

function stageRainFrame(map: RainFrameMap, id: string, reportError?: ErrorReporter): boolean {
    try {
        if (!map.getLayer(id)) return false;
        // Set opacity before making the layer relevant to Mapbox's renderer.
        // The zero-opacity frame requests its tiles without ever blanking the
        // currently committed frame underneath it.
        map.setPaintProperty(id, 'raster-opacity', 0);
        map.setLayoutProperty(id, 'visibility', 'visible');
        return true;
    } catch (error) {
        reportError?.(error);
        return false;
    }
}

function hideRainFrame(map: RainFrameMap, id: string, reportError?: ErrorReporter): void {
    try {
        if (!map.getLayer(id)) return;
        map.setLayoutProperty(id, 'visibility', 'none');
    } catch (error) {
        reportError?.(error);
    }
}

/**
 * Owns at most one staged source and one outgoing fade at a time.
 *
 * The incoming frame becomes the committed frame when its source is ready,
 * before the outgoing frame is faded out. Cancelling a rapid scrub therefore
 * keeps the latest committed image on screen instead of restoring (or briefly
 * exposing) an older image.
 */
export class RainFrameTransitionController {
    private generation = 0;
    private stagedId: string | null = null;
    private sourceListener: RainFrameEventListener | null = null;
    private renderListener: RainFrameEventListener | null = null;
    private fadeTimer: ReturnType<typeof setTimeout> | null = null;
    private stageDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    private fadingOutIds: string[] = [];

    constructor(private readonly reportError?: ErrorReporter) {}

    /** True while a requested frame is loading or its handoff is fading. */
    isTransitioning(): boolean {
        return this.stagedId !== null || this.fadingOutIds.length > 0;
    }

    cancel(map: RainFrameMap): void {
        this.generation += 1;
        this.detachLoadListeners(map);

        if (this.fadeTimer) {
            clearTimeout(this.fadeTimer);
            this.fadeTimer = null;
        }
        if (this.stageDeadlineTimer) {
            clearTimeout(this.stageDeadlineTimer);
            this.stageDeadlineTimer = null;
        }

        // A staged layer has never been committed, so it must disappear when
        // the user moves on to a newer scrubber value.
        if (this.stagedId) hideRainFrame(map, this.stagedId, this.reportError);
        this.stagedId = null;

        // Once a fade begins, the incoming frame is already the committed one.
        // Hiding only the old layers preserves that newest image through a
        // rapid A → B → C scrub.
        for (const id of this.fadingOutIds) hideRainFrame(map, id, this.reportError);
        this.fadingOutIds = [];
    }

    request(map: RainFrameMap, targetId: string, visibleIds: readonly string[], onCommitted: () => void): boolean {
        this.cancel(map);

        if (!hasRainFrame(map, targetId, this.reportError)) return false;

        const currentIds = [...new Set(visibleIds.filter((id) => id !== targetId && hasRainFrame(map, id)))];

        // The requested frame is already the one painted on screen. Repair any
        // stray duplicate visibility and leave it at the expected opacity.
        if (visibleIds.includes(targetId)) {
            if (!showRainFrame(map, targetId, this.reportError)) return false;
            for (const id of currentIds) hideRainFrame(map, id, this.reportError);
            onCommitted();
            return true;
        }

        const requestGeneration = this.generation;
        let transitionStarted = false;
        let onSourceData: RainFrameEventListener | null = null;
        let onRender: RainFrameEventListener | null = null;

        const detachRequestListeners = () => {
            if (onSourceData && this.sourceListener === onSourceData) {
                this.safeOff(map, 'sourcedata', onSourceData);
                this.sourceListener = null;
            }
            if (onRender && this.renderListener === onRender) {
                this.safeOff(map, 'render', onRender);
                this.renderListener = null;
            }
        };

        const beginCrossfade = () => {
            if (
                transitionStarted ||
                requestGeneration !== this.generation ||
                this.stagedId !== targetId ||
                !hasRainFrame(map, targetId, this.reportError)
            ) {
                return;
            }

            detachRequestListeners();
            if (this.stageDeadlineTimer) {
                clearTimeout(this.stageDeadlineTimer);
                this.stageDeadlineTimer = null;
            }
            if (!showRainFrame(map, targetId, this.reportError)) return;
            transitionStarted = true;

            // From this point, cancellation must retain targetId. It is fully
            // tile-ready and is therefore a safe image to keep under the next
            // requested frame while that next source warms up.
            this.stagedId = null;
            onCommitted();

            this.fadingOutIds = currentIds;
            for (const id of currentIds) setRainFrameOpacity(map, id, 0, this.reportError);

            if (currentIds.length === 0) return;

            this.fadeTimer = setTimeout(() => {
                if (requestGeneration !== this.generation) return;
                for (const id of currentIds) hideRainFrame(map, id, this.reportError);
                this.fadingOutIds = this.fadingOutIds.filter((id) => !currentIds.includes(id));
                this.fadeTimer = null;
            }, RAIN_FRAME_FADE_MS);
        };

        onSourceData = (event) => {
            // The visibility event fires while Mapbox recalculates its style,
            // before `updateSources()` has requested tiles for a previously
            // parked raster. Empty parked sources report as loaded at that
            // point, so accepting it would recreate the exact blank flash we
            // are preventing. Raster completion events carry a tile (rather
            // than sourceDataType: 'content'), so require that concrete proof
            // that this staged source has begun filling its viewport. Failed
            // tile events also carry a tile, but must keep the prior image.
            if (
                event?.sourceId === targetId &&
                event.tile != null &&
                event.sourceDataType !== 'error' &&
                (event.isSourceLoaded === true || this.isTargetReady(map, targetId))
            ) {
                beginCrossfade();
            }
        };
        onRender = () => {
            // A revisited frame can already be cached, in which case Mapbox
            // might not emit a fresh sourcedata event. Check after the staged
            // layout change has reached a render pass.
            if (onRender && this.renderListener === onRender) {
                this.safeOff(map, 'render', onRender);
                this.renderListener = null;
            }
            if (this.isTargetReady(map, targetId)) beginCrossfade();
        };

        this.sourceListener = onSourceData;
        this.renderListener = onRender;
        this.safeOn(map, 'sourcedata', onSourceData);
        this.safeOn(map, 'render', onRender);
        // Register listeners before making the layer relevant to Mapbox. A
        // cached source can report loaded immediately after this write.
        this.stagedId = targetId;
        if (!stageRainFrame(map, targetId, this.reportError)) {
            this.detachLoadListeners(map);
            this.stagedId = null;
            return false;
        }
        // Fail open if the staged frame never produces a tile — see
        // RAIN_FRAME_STAGE_DEADLINE_MS. The committed frame stays painted.
        this.stageDeadlineTimer = setTimeout(() => {
            this.stageDeadlineTimer = null;
            if (requestGeneration !== this.generation || this.stagedId !== targetId || transitionStarted) return;
            detachRequestListeners();
            hideRainFrame(map, targetId, this.reportError);
            this.stagedId = null;
        }, RAIN_FRAME_STAGE_DEADLINE_MS);
        return true;
    }

    private detachLoadListeners(map: RainFrameMap): void {
        if (this.sourceListener) this.safeOff(map, 'sourcedata', this.sourceListener);
        if (this.renderListener) this.safeOff(map, 'render', this.renderListener);
        this.sourceListener = null;
        this.renderListener = null;
    }

    private isTargetReady(map: RainFrameMap, id: string): boolean {
        try {
            return map.isSourceLoaded(id);
        } catch (error) {
            this.reportError?.(error);
            return false;
        }
    }

    private safeOn(map: RainFrameMap, event: 'sourcedata' | 'render', listener: RainFrameEventListener): void {
        try {
            map.on(event, listener);
        } catch (error) {
            this.reportError?.(error);
        }
    }

    private safeOff(map: RainFrameMap, event: 'sourcedata' | 'render', listener: RainFrameEventListener): void {
        try {
            map.off(event, listener);
        } catch (error) {
            this.reportError?.(error);
        }
    }
}
