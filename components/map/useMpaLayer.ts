/**
 * useMpaLayer — React lifecycle wrapper around MpaLayer.
 *
 * Mounts the Australian Marine Protected Areas vector overlay
 * when `visible` flips on, tears it down when it flips off, and
 * wires a click handler that opens a popup describing the reserve
 * (name + indicative protection class + IUCN cat + managing authority).
 *
 * The compact popup shows indicative CAPAD zone context only. It never
 * answers whether an activity is permitted; users must verify current
 * fishing and anchoring rules with the managing authority.
 *
 * Feature-flagged via VITE_MPA_ENABLED so beta accounts can opt in
 * before we hit the public release.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { toast } from '../Toast';
import {
    deactivateMpaLayerAndProveSafe,
    isMpaLayerMounted,
    isMpaLayerUnmounted,
    type MpaLayerDeactivation,
    MPA_FILL_ID,
    mountMpaLayer,
} from './MpaLayer';
import {
    fetchVerifiedMpaGeoJson,
    getVerifiedMpaDatasetStatus,
    MPA_CACHE_TTL_MS,
    releaseMpaDataset,
} from '../../services/weather/api/mpaDataset';

const log = createLogger('useMpaLayer');

const FEATURE_ENABLED = String(import.meta.env.VITE_MPA_ENABLED ?? 'false').toLowerCase() === 'true';

/** Neutral indicative protection class → user-facing popup context. */
const PROTECTION_CLASS_LABEL: Record<string, { label: string; tone: string; hint: string }> = {
    high: {
        label: 'Inferred high-protection class',
        tone: '#f87171',
        hint: 'This metadata classification does not establish a prohibition or permission. Verify current fishing and anchoring rules with the managing authority.',
    },
    conditional: {
        label: 'Inferred conditional-protection class',
        tone: '#fbbf24',
        hint: 'Rules vary by zone and activity. Verify current fishing and anchoring rules with the managing authority.',
    },
    multiple_use: {
        label: 'Inferred multiple-use class',
        tone: '#60a5fa',
        hint: 'This class does not establish permission. Verify current fishing and anchoring rules with the managing authority.',
    },
};

interface MpaProps {
    name?: string;
    type?: string;
    iucn?: string;
    zone?: string;
    authority?: string;
    state?: string;
    area_km2?: number;
    protection_class?: string;
    classification_source?: string;
}

export function buildMpaPopupHtml(props: MpaProps, verifiedSourceDate?: string): string {
    const protectionClass = (props.protection_class ?? 'multiple_use') as keyof typeof PROTECTION_CLASS_LABEL;
    const meta = PROTECTION_CLASS_LABEL[protectionClass] ?? PROTECTION_CLASS_LABEL.multiple_use;

    const escape = (s: unknown) =>
        String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

    const subParts: string[] = [];
    if (props.zone) subParts.push(escape(props.zone));
    else if (props.type) subParts.push(escape(props.type));
    if (props.iucn) subParts.push(`IUCN ${escape(props.iucn)}`);

    const sub = subParts.join(' · ');
    const areaValue = Number(props.area_km2);
    const areaDigits = areaValue >= 100 ? 0 : areaValue >= 1 ? 2 : areaValue >= 0.01 ? 3 : 6;
    const area =
        Number.isFinite(areaValue) && areaValue > 0
            ? `${escape(
                  areaValue.toLocaleString('en-AU', {
                      maximumFractionDigits: areaDigits,
                  }),
              )} km²`
            : '';
    const auth = props.authority ? escape(props.authority) : '';
    const sourceDate = formatMpaSourceDate(verifiedSourceDate);

    return `
        <style>
            .mpa-popup-close:focus-visible {
                outline: 2px solid #38bdf8;
                outline-offset: 2px;
            }
        </style>
        <div style="
            font-family: system-ui, -apple-system, sans-serif;
            min-width: 220px;
            max-width: 280px;
            padding-right: 38px;
            color: #f3f4f6;
            position: relative;
        ">
            <button
                type="button"
                class="mpa-popup-close"
                aria-label="Close"
                style="
                    position: absolute;
                    top: -10px;
                    right: -14px;
                    width: 44px;
                    height: 44px;
                    border-radius: 999px;
                    border: 1px solid rgba(255,255,255,0.18);
                    background: rgba(15,23,42,0.85);
                    color: #d1d5db;
                    font-size: 16px;
                    line-height: 1;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    transition: background 120ms, color 120ms;
                "
            >&times;</button>
            <div style="font-weight: 600; font-size: 14px; line-height: 1.3; margin-bottom: 4px;">
                ${escape(props.name ?? 'Marine reserve')}
            </div>
            ${sub ? `<div style="font-size: 11px; color: #9ca3af; margin-bottom: 8px;">${sub}</div>` : ''}
            <div style="
                display: inline-block;
                padding: 3px 8px;
                border-radius: 999px;
                background: ${meta.tone}33;
                color: ${meta.tone};
                font-size: 11px;
                font-weight: 600;
                margin-bottom: 8px;
                border: 1px solid ${meta.tone}66;
            ">${meta.label}</div>
            <div style="font-size: 12px; color: #d1d5db; line-height: 1.4; margin-bottom: 6px;">
                ${meta.hint}
            </div>
            ${
                area || auth || sourceDate
                    ? `<div style="font-size: 11px; color: #cbd5e1; padding-top: 6px; border-top: 1px solid #374151;">
                ${area ? `<div>Area: ${area}</div>` : ''}
                ${auth ? `<div>Managed by: ${auth}</div>` : ''}
                ${sourceDate ? `<div>Dataset snapshot: ${escape(sourceDate)}</div>` : ''}
            </div>`
                    : ''
            }
            <div style="font-size: 11px; color: #b6c2d1; margin-top: 6px; font-style: italic;">
                Indicative CAPAD overlay only — not legal advice and not for navigation.
            </div>
        </div>
    `;
}

export function formatMpaSourceDate(value: string | undefined): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value ?? '');
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        !Number.isFinite(date.getTime()) ||
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return '';
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[month - 1]} ${year}`;
}

export function useMpaLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    onVisibilityChange?: (next: boolean) => void,
) {
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const mountedRef = useRef(false);
    const generationRef = useRef<string | undefined>();
    const failureNoticeRef = useRef(false);
    const handlersRef = useRef<{
        click?: (e: mapboxgl.MapMouseEvent) => void;
        mouseenter?: () => void;
        mouseleave?: () => void;
    }>({});

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (!FEATURE_ENABLED) {
            if (visible) log.info('gated off — VITE_MPA_ENABLED=false');
            return;
        }

        const unmountPresentation = (): MpaLayerDeactivation => {
            const handlers = handlersRef.current;
            for (const [event, handler] of [
                ['click', handlers.click],
                ['mouseenter', handlers.mouseenter],
                ['mouseleave', handlers.mouseleave],
            ] as const) {
                if (!handler) continue;
                try {
                    map.off(event, MPA_FILL_ID, handler);
                } catch {
                    /* best effort */
                }
            }
            handlersRef.current = {};
            try {
                popupRef.current?.remove();
            } catch {
                /* best effort */
            }
            popupRef.current = null;
            const deactivation = deactivateMpaLayerAndProveSafe(map);
            // Hidden or unproven artifacts still belong to this generation.
            // Keep the refs so Retry cannot fetch over a stale Mapbox source.
            if (deactivation === 'absent') {
                mountedRef.current = false;
                generationRef.current = undefined;
            }
            return deactivation;
        };

        const teardown = (): MpaLayerDeactivation => {
            const deactivation = unmountPresentation();
            if (deactivation === 'absent') releaseMpaDataset();
            return deactivation;
        };

        const offerRetry = (message: string) => {
            if (failureNoticeRef.current) return;
            failureNoticeRef.current = true;
            toast.persistentError(message, {
                label: 'Retry',
                onClick: () => {
                    failureNoticeRef.current = false;
                    const deactivation = unmountPresentation();
                    if (deactivation !== 'absent') {
                        offerRetry('MPA data is unavailable and its old chart presentation is still being cleaned up.');
                        return;
                    }
                    releaseMpaDataset();
                    onVisibilityChange?.(true);
                },
            });
        };

        if (!visible) {
            const initial = teardown();
            if (initial === 'absent') return;
            let disposed = false;
            let noticeId: number | undefined;
            const stop = () => {
                if (disposed) return;
                disposed = true;
                map.off('styledata', retryCleanup);
                map.off('idle', retryCleanup);
                if (noticeId !== undefined) {
                    toast.dismiss(noticeId);
                    noticeId = undefined;
                }
                failureNoticeRef.current = false;
            };
            const retryCleanup = (): MpaLayerDeactivation => {
                if (disposed) return 'failed';
                const next = unmountPresentation();
                if (next !== 'absent') return next;
                releaseMpaDataset();
                stop();
                return 'absent';
            };
            const armCleanupNotice = () => {
                if (failureNoticeRef.current) return;
                failureNoticeRef.current = true;
                noticeId = toast.persistentError(
                    'MPA could not be fully removed from the chart and may still be visible. Do not rely on this overlay.',
                    {
                        label: 'Retry',
                        onClick: () => {
                            failureNoticeRef.current = false;
                            if (retryCleanup() !== 'absent') armCleanupNotice();
                        },
                    },
                );
            };
            map.on('styledata', retryCleanup);
            map.on('idle', retryCleanup);
            if (initial === 'failed') armCleanupNotice();
            return stop;
        }

        // A delayed Retry or style reload may leave a safely-hidden owned ID.
        // Clean/prove full absence before even requesting a fresh manifest.
        if (mountedRef.current || !isMpaLayerUnmounted(map)) {
            const prepared = unmountPresentation();
            if (prepared !== 'absent') {
                offerRetry('MPA data is unavailable until its previous chart presentation can be fully removed.');
                if (prepared === 'hidden') onVisibilityChange?.(false);
                return;
            }
            releaseMpaDataset();
        }

        const attachHandlers = () => {
            if (handlersRef.current.click) return;
            const onClick = (e: mapboxgl.MapMouseEvent) => {
                const features = map.queryRenderedFeatures(e.point, { layers: [MPA_FILL_ID] });
                if (!features.length) return;
                const props = (features[0].properties ?? {}) as MpaProps;
                popupRef.current?.remove();
                const popup = new mapboxgl.Popup({
                    closeButton: false,
                    maxWidth: '320px',
                    className: 'mpa-popup',
                    offset: 8,
                })
                    .setLngLat(e.lngLat)
                    .setHTML(buildMpaPopupHtml(props, getVerifiedMpaDatasetStatus()?.sourceDate))
                    .addTo(map);
                popupRef.current = popup;
                const closeBtn = popup.getElement()?.querySelector<HTMLButtonElement>('.mpa-popup-close');
                if (closeBtn) {
                    popup.on('close', () => map.getCanvas().focus());
                    closeBtn.addEventListener('click', () => popup.remove());
                    closeBtn.addEventListener('mouseenter', () => {
                        closeBtn.style.background = 'rgba(220, 38, 38, 0.85)';
                        closeBtn.style.color = '#ffffff';
                    });
                    closeBtn.addEventListener('mouseleave', () => {
                        closeBtn.style.background = 'rgba(15, 23, 42, 0.85)';
                        closeBtn.style.color = '#d1d5db';
                    });
                    closeBtn.focus();
                }
            };
            const onEnter = () => {
                map.getCanvas().style.cursor = 'pointer';
            };
            const onLeave = () => {
                map.getCanvas().style.cursor = '';
            };
            map.on('click', MPA_FILL_ID, onClick);
            map.on('mouseenter', MPA_FILL_ID, onEnter);
            map.on('mouseleave', MPA_FILL_ID, onLeave);
            handlersRef.current = { click: onClick, mouseenter: onEnter, mouseleave: onLeave };
        };

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const requestController = new AbortController();
        const failClosed = (message: string, error?: unknown) => {
            const deactivation = teardown();
            if (deactivation !== 'failed') {
                try {
                    onVisibilityChange?.(false);
                } catch {
                    /* the map is already proven absent or hidden */
                }
            }
            offerRetry(
                deactivation === 'failed'
                    ? 'MPA data could not be verified or safely removed. Do not rely on the visible overlay.'
                    : 'MPA data could not be verified. The overlay was switched off.',
            );
            log.warn(message, error);
        };
        const revalidate = async () => {
            let successful = false;
            try {
                const data = await fetchVerifiedMpaGeoJson(requestController.signal, (nextGeneration) => {
                    // The verified manifest says a replacement is coming.
                    // Remove the old Mapbox source before the loader allocates
                    // and parses the next <=16 MiB GeoJSON generation.
                    if (unmountPresentation() !== 'absent') {
                        throw new Error('MPA replacement teardown could not prove complete artifact removal');
                    }
                    log.info(`MPA generation ${nextGeneration} is replacing the mounted source`);
                });
                if (cancelled) return;
                if (!data) {
                    failClosed('MPA layer remains off because its trust refresh failed');
                    return;
                }
                const generation = getVerifiedMpaDatasetStatus()?.generation;
                const generationChanged = mountedRef.current && generationRef.current !== generation;
                if (generationChanged) {
                    if (unmountPresentation() !== 'absent') {
                        failClosed('MPA generation changed but the old presentation could not be removed');
                        return;
                    }
                }

                if (mountedRef.current && !isMpaLayerMounted(map)) {
                    if (unmountPresentation() !== 'absent') {
                        failClosed('MPA presentation became incomplete and could not be removed');
                        return;
                    }
                }

                if (!mountedRef.current) {
                    const mounted = await mountMpaLayer(map, {}, data);
                    if (cancelled) {
                        if (mounted) teardown();
                        return;
                    }
                    if (!mounted) {
                        failClosed('MPA layer could not mount verified data');
                        return;
                    } else {
                        mountedRef.current = true;
                        generationRef.current = generation;
                        failureNoticeRef.current = false;
                        attachHandlers();
                        log.info('MPA layer mounted with verified data and one handler set');
                    }
                }
                attachHandlers();
                successful = true;
            } catch (error) {
                if (!cancelled) failClosed('MPA style or trust refresh failed closed', error);
            } finally {
                if (successful && !cancelled) {
                    timer = setTimeout(() => void revalidate(), MPA_CACHE_TTL_MS + 100);
                }
            }
        };
        void revalidate();
        return () => {
            cancelled = true;
            requestController.abort(new Error('MPA layer hidden or unmounted'));
            if (timer !== undefined) clearTimeout(timer);
            teardown();
        };
    }, [mapRef, mapReady, onVisibilityChange, visible]);
}

/** Exposed so the legend / radial menu can check the flag state. */
export function isMpaEnabled(): boolean {
    return FEATURE_ENABLED;
}
