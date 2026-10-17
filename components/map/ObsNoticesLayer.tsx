import { useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { NoticeToMarinersService } from '../../services/NoticeToMarinersService';
import { cachedQldNotices } from '../../services/qldNotices';
import { loadLocalNotices } from '../../services/localNotices';
import { OBS_NOTICE_MIN_ZOOM, selectObsNotices, type ObsNotice, type NoticeViewport } from '../../services/obsNotices';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import { safeExternalHttpUrl } from '../../utils/safeUrl';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';

export interface ObsNoticesLayerProps {
    map: mapboxgl.Map | null;
    mapReady: boolean;
    active: boolean;
    enabled: boolean;
}
function text(parent: HTMLElement, tag: string, value: string) {
    const el = document.createElement(tag);
    el.textContent = value;
    parent.append(el);
    return el;
}
export function obsNoticePopup(n: ObsNotice, now: number): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'obs-notice-content';
    Object.assign(root.style, {
        maxWidth: '250px',
        fontSize: 'max(12px, 0.75rem)',
        paddingRight: '40px',
        color: 'var(--text-primary, #f1f5f9)',
        overflowY: 'auto',
        overflowWrap: 'anywhere',
    });
    text(root, 'strong', n.title);
    text(root, 'p', n.issuer);
    text(root, 'p', `Issued: ${n.issued || 'not supplied by source'}`);
    const age = n.receivedAt === null ? 'unknown' : `${Math.max(0, Math.floor((now - n.receivedAt) / 3600000))}h ago`;
    text(root, 'p', `Source checked: ${age}. Cached listing; availability may have changed.`);
    const body = text(
        root,
        'p',
        n.text.length > 4000 ? `${n.text.slice(0, 4000)}\n[Excerpt — read the issuer's full notice.]` : n.text,
    );
    Object.assign(body.style, {
        whiteSpace: 'pre-wrap',
        maxHeight: '160px',
        overflowY: 'auto',
        overflowWrap: 'anywhere',
    });
    text(
        root,
        'p',
        `${n.approximate ? 'Approximate locality' : 'Location extracted from text'}, not a warning boundary. Coverage is incomplete; no icon does not mean no warnings.`,
    );
    const url = safeExternalHttpUrl(n.url, true);
    if (url) {
        const a = text(root, 'a', 'Read official source') as HTMLAnchorElement;
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.referrerPolicy = 'no-referrer';
        a.className = 'underline';
        a.style.color = 'var(--neon-cyan, #7dd3fc)';
    }
    return root;
}
/** Foreground browsing only. Public fixed-source refresh has no camera/boat query. */
export default function ObsNoticesLayer({ map, mapReady, active, enabled }: ObsNoticesLayerProps) {
    const [identityEpoch, setIdentityEpoch] = useState(0);
    useEffect(() => subscribeAuthIdentityScope(() => setIdentityEpoch((n) => n + 1)), []);
    useEffect(() => {
        if (!map || !mapReady || !active || !enabled) return;
        let disposed = false,
            markers: mapboxgl.Marker[] = [],
            popup: mapboxgl.Popup | null = null;
        let local: Awaited<ReturnType<typeof loadLocalNotices>> = [],
            attemptedAt = 0;
        const clear = () => {
            for (const m of markers) m.remove();
            markers = [];
            popup?.remove();
            popup = null;
        };
        const render = () => {
            clear();
            if (disposed || document.hidden || map.getZoom() < OBS_NOTICE_MIN_ZOOM) return;
            const b = map.getBounds();
            const bounds: NoticeViewport | null = b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
            const qld = cachedQldNotices();
            const result = selectObsNotices({
                bounds,
                zoom: map.getZoom(),
                broadcast: NoticeToMarinersService.getCached().notices,
                health: NoticeToMarinersService.getSourceHealth(),
                local,
                qld: qld.notices,
                qldFetchedAt: qld.fetchedAt,
                now: Date.now(),
            });
            for (const n of result.notices) {
                const el = document.createElement('button');
                el.type = 'button';
                el.setAttribute('aria-label', `Notice: ${n.title}`);
                el.innerHTML =
                    '<span style="width:28px;height:28px;display:grid;place-items:center;border:1px solid #fbbf24;border-radius:6px;background:#172336"><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1h7l3 3v11H3zM9 1v4h4M5 8h6M5 11h6" fill="#172336" stroke="#fbbf24" stroke-width="1.2"/></svg></span>';
                Object.assign(el.style, {
                    width: '44px',
                    height: '44px',
                    display: 'grid',
                    placeItems: 'center',
                    border: '0',
                    padding: '0',
                    background: 'transparent',
                    cursor: 'pointer',
                });
                el.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (disposed) return;
                    popup?.remove();
                    const content = obsNoticePopup(n, Date.now());
                    content.style.maxHeight = `${Math.max(80, Math.min(280, (map.getContainer().clientHeight - 80) / 2))}px`;
                    popup = new mapboxgl.Popup({
                        className: 'ntm-popup',
                        maxWidth: '290px',
                        offset: 12,
                        focusAfterOpen: false,
                    })
                        .setLngLat([n.lon, n.lat])
                        .setDOMContent(content)
                        .addTo(map);
                    const close = popup.getElement()?.querySelector<HTMLButtonElement>('.mapboxgl-popup-close-button');
                    if (close) {
                        Object.assign(close.style, { minWidth: '44px', minHeight: '44px' });
                        close.focus({ preventScroll: true });
                    }
                    const panel = popup.getElement()?.querySelector<HTMLElement>('.mapboxgl-popup-content');
                    if (panel) panel.style.maxHeight = 'none';
                });
                const marker = new mapboxgl.Marker({ element: el }).setLngLat([n.lon, n.lat]).addTo(map);
                // Mapbox assigns role=img even to custom interactive elements.
                el.setAttribute('role', 'button');
                markers.push(marker);
            }
            // No source is queried below the display zoom or on a metered link.
            if (!satelliteModeBlocks('offline-download') && Date.now() - attemptedAt > 6 * 3600000) {
                attemptedAt = Date.now();
                void NoticeToMarinersService.refresh().catch(() => undefined);
            }
        };
        const retire = () => {
            disposed = true;
            clear();
        };
        const unsubscribeIdentity = subscribeAuthIdentityScope(retire);
        const unsubscribeSource = NoticeToMarinersService.onChange(() => {
            if (!disposed) render();
        });
        map.on('moveend', render);
        map.on('zoomend', render);
        document.addEventListener('visibilitychange', render);
        void loadLocalNotices().then((value) => {
            if (!disposed) {
                local = value;
                render();
            }
        });
        render();
        return () => {
            retire();
            unsubscribeIdentity();
            unsubscribeSource();
            map.off('moveend', render);
            map.off('zoomend', render);
            document.removeEventListener('visibilitychange', render);
        };
    }, [map, mapReady, active, enabled, identityEpoch]);
    return null;
}
