/**
 * useMpaLayer — React lifecycle wrapper around MpaLayer.
 *
 * Mounts the Australian Marine Protected Areas vector overlay
 * when `visible` flips on, tears it down when it flips off, and
 * wires a click handler that opens a popup describing the reserve
 * (name + restriction bucket + IUCN cat + managing authority).
 *
 * Why a popup vs. a side panel: most users will tap a polygon to
 * answer "can I fish here?" — that's a one-line answer, doesn't
 * deserve a panel. We keep the popup compact and dismissable.
 *
 * Feature-flagged via VITE_MPA_ENABLED so beta accounts can opt in
 * before we hit the public release.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { MPA_FILL_ID, mountMpaLayer, unmountMpaLayer } from './MpaLayer';

const log = createLogger('useMpaLayer');

const FEATURE_ENABLED = String(import.meta.env.VITE_MPA_ENABLED ?? 'false').toLowerCase() === 'true';

/** Restriction bucket → user-facing label for the popup. */
const RESTRICTION_LABEL: Record<string, { label: string; tone: string; hint: string }> = {
    no_take: {
        label: 'No-take zone',
        tone: '#dc2626',
        hint: 'No fishing, collecting, or extraction permitted.',
    },
    partial: {
        label: 'Partial protection',
        tone: '#d97706',
        hint: 'Restrictions apply — check local rules before fishing.',
    },
    general: {
        label: 'Multiple-use zone',
        tone: '#1d4ed8',
        hint: 'Recreational fishing usually permitted; verify local zoning.',
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
    restriction?: string;
}

function buildPopupHtml(props: MpaProps): string {
    const restriction = (props.restriction ?? 'general') as keyof typeof RESTRICTION_LABEL;
    const meta = RESTRICTION_LABEL[restriction] ?? RESTRICTION_LABEL.general;

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
    const area = props.area_km2 ? `${props.area_km2.toLocaleString()} km²` : '';
    const auth = props.authority ? escape(props.authority) : '';

    return `
        <div style="
            font-family: system-ui, -apple-system, sans-serif;
            min-width: 220px;
            max-width: 280px;
            padding-right: 22px;
            color: #f3f4f6;
            position: relative;
        ">
            <button
                type="button"
                class="mpa-popup-close"
                aria-label="Close"
                style="
                    position: absolute;
                    top: -4px;
                    right: -8px;
                    width: 26px;
                    height: 26px;
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
                area || auth
                    ? `<div style="font-size: 11px; color: #6b7280; padding-top: 6px; border-top: 1px solid #374151;">
                ${area ? `<div>Area: ${area}</div>` : ''}
                ${auth ? `<div>Managed by: ${auth}</div>` : ''}
            </div>`
                    : ''
            }
            <div style="font-size: 9px; color: #4b5563; margin-top: 6px; font-style: italic;">
                Indicative only — not for navigation.
            </div>
        </div>
    `;
}

export function useMpaLayer(mapRef: React.MutableRefObject<mapboxgl.Map | null>, mapReady: boolean, visible: boolean) {
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const mountedRef = useRef(false);
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

        if (!visible) {
            // Detach handlers before tearing down the layer.
            if (handlersRef.current.click) {
                map.off('click', MPA_FILL_ID, handlersRef.current.click);
            }
            if (handlersRef.current.mouseenter) {
                map.off('mouseenter', MPA_FILL_ID, handlersRef.current.mouseenter);
            }
            if (handlersRef.current.mouseleave) {
                map.off('mouseleave', MPA_FILL_ID, handlersRef.current.mouseleave);
            }
            handlersRef.current = {};
            popupRef.current?.remove();
            popupRef.current = null;
            if (mountedRef.current) {
                unmountMpaLayer(map);
                mountedRef.current = false;
            }
            return;
        }

        if (!mountedRef.current) {
            try {
                mountMpaLayer(map);
                mountedRef.current = true;

                const onClick = (e: mapboxgl.MapMouseEvent) => {
                    const features = map.queryRenderedFeatures(e.point, {
                        layers: [MPA_FILL_ID],
                    });
                    if (!features.length) return;
                    const feat = features[0];
                    const props = (feat.properties ?? {}) as MpaProps;

                    if (popupRef.current) popupRef.current.remove();
                    // Mapbox's default close button gets visually swallowed
                    // by our dark glassmorphic content (low contrast, sits
                    // on top of the title) — disable it and render our own
                    // styled X inside the popup HTML, then wire the click
                    // by querying the rendered DOM after .addTo().
                    const popup = new mapboxgl.Popup({
                        closeButton: false,
                        maxWidth: '320px',
                        className: 'mpa-popup',
                        offset: 8,
                    })
                        .setLngLat(e.lngLat)
                        .setHTML(buildPopupHtml(props))
                        .addTo(map);
                    popupRef.current = popup;

                    const closeBtn = popup.getElement()?.querySelector<HTMLButtonElement>('.mpa-popup-close');
                    if (closeBtn) {
                        closeBtn.addEventListener('click', () => popup.remove());
                        // Subtle hover affordance — works on cursor devices
                        // without breaking the touch-target sizing.
                        closeBtn.addEventListener('mouseenter', () => {
                            closeBtn.style.background = 'rgba(220, 38, 38, 0.85)';
                            closeBtn.style.color = '#ffffff';
                        });
                        closeBtn.addEventListener('mouseleave', () => {
                            closeBtn.style.background = 'rgba(15, 23, 42, 0.85)';
                            closeBtn.style.color = '#d1d5db';
                        });
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

                handlersRef.current = {
                    click: onClick,
                    mouseenter: onEnter,
                    mouseleave: onLeave,
                };

                log.info('MPA layer mounted with click handler');
            } catch (err) {
                log.warn('Failed to mount MPA layer', err);
            }
        }
    }, [mapRef, mapReady, visible]);

    // Unmount cleanup on hook teardown.
    useEffect(() => {
        return () => {
            const map = mapRef.current;
            popupRef.current?.remove();
            popupRef.current = null;
            if (!map) return;
            if (handlersRef.current.click) {
                try {
                    map.off('click', MPA_FILL_ID, handlersRef.current.click);
                } catch {
                    /* best effort */
                }
            }
            try {
                if (mountedRef.current) {
                    unmountMpaLayer(map);
                }
            } catch {
                /* best effort */
            }
        };
    }, [mapRef]);
}

/** Exposed so the legend / radial menu can check the flag state. */
export function isMpaEnabled(): boolean {
    return FEATURE_ENABLED;
}
