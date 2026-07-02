/**
 * useNoticeLayer — Notices to Mariners ON THE CHART.
 *
 * Shane's ask (2026-07-02): "a little square of paper on the chart that the
 * punter can click on and get the notice to mariner about that area — e.g.
 * the Mooloolah River bar." Two sources, one layer:
 *
 *   • CURATED local notices (services/localNotices.ts — bundled JSON, the
 *     MSQ-class standing notices like the Mooloolah bar): ALWAYS shown, amber
 *     paper pill at the notice position.
 *   • BROADCAST warnings (services/NoticeToMarinersService.ts — NGA/AMSA/
 *     UKHO/LINZ): shown at their first extracted coordinate when inside the
 *     viewport at zoom ≥ 6, capped, refreshed on moveend. Cached-first so the
 *     chart never waits on the network; a background refresh fills in.
 *
 * DOM markers (guaranteed emoji rendering; counts are small) + a single
 * mapboxgl.Popup. All markers torn down on hide/unmount.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { loadLocalNotices, type LocalNotice } from '../../services/localNotices';
import { loadLowBridges, type LowBridge } from '../../services/lowBridges';
import { vesselAirDraftMetres } from '../../services/units';
import { useSettingsStore } from '../../stores/settingsStore';
import { NoticeToMarinersService, type Notice } from '../../services/NoticeToMarinersService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('useNoticeLayer');

const BROADCAST_MIN_ZOOM = 6;
const BROADCAST_CAP = 60;

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chipEl(kind: 'local' | 'broadcast'): HTMLDivElement {
    const el = document.createElement('div');
    el.textContent = '📄';
    Object.assign(el.style, {
        fontSize: kind === 'local' ? '15px' : '12px',
        lineHeight: '1',
        padding: kind === 'local' ? '3px 4px' : '2px 3px',
        background: 'rgba(15, 23, 42, 0.85)',
        border: `1px solid ${kind === 'local' ? 'rgba(251, 191, 36, 0.55)' : 'rgba(148, 163, 184, 0.4)'}`,
        borderRadius: '6px',
        cursor: 'pointer',
        boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
    } satisfies Partial<CSSStyleDeclaration>);
    return el;
}

function localPopupHtml(n: LocalNotice): string {
    const tag = n.permanent ? 'STANDING NOTICE' : (n.issued ?? 'NOTICE');
    const src = n.sourceUrl
        ? `<a href="${esc(n.sourceUrl)}" target="_blank" rel="noopener" style="color:#38bdf8;text-decoration:underline;">${esc(n.sourceName ?? 'Current notices')}</a>`
        : '';
    return `
      <div style="font-family:inherit;color:#e2e8f0;max-width:250px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:#fcd34d;margin-bottom:2px;">📄 ${esc(tag)}</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">${esc(n.title)}</div>
        <div style="font-size:11px;color:#cbd5e1;margin-bottom:4px;">${esc(n.summary)}</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">${esc(n.detail)}</div>
        ${src ? `<div style="font-size:11px;">${src}</div>` : ''}
      </div>`;
}

function bridgeEl(passable: boolean): HTMLDivElement {
    const el = document.createElement('div');
    el.textContent = '🌉';
    Object.assign(el.style, {
        fontSize: '14px',
        lineHeight: '1',
        padding: '2px 4px',
        background: 'rgba(15, 23, 42, 0.85)',
        border: `1px solid ${passable ? 'rgba(148, 163, 184, 0.4)' : 'rgba(239, 68, 68, 0.6)'}`,
        borderRadius: '6px',
        cursor: 'pointer',
        boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
    } satisfies Partial<CSSStyleDeclaration>);
    return el;
}

function bridgePopupHtml(b: LowBridge, airDraftM: number | null): string {
    const blocked = airDraftM !== null && airDraftM > b.clearanceM;
    const verdict =
        airDraftM === null
            ? '<span style="color:#94a3b8;">Set your air draft in Vessel settings for clearance checks.</span>'
            : blocked
              ? `<span style="color:#f87171;font-weight:700;">IMPASSABLE for your ${airDraftM.toFixed(1)} m air draft — routes are blocked here.</span>`
              : `<span style="color:#4ade80;">Clears your ${airDraftM.toFixed(1)} m air draft.</span>`;
    return `
      <div style="font-family:inherit;color:#e2e8f0;max-width:240px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:#94a3b8;margin-bottom:2px;">🌉 FIXED BRIDGE</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">${esc(b.name)}</div>
        <div style="font-size:11px;color:#cbd5e1;margin-bottom:4px;">Vertical clearance ${b.clearanceM.toFixed(1)} m${b.estimated ? ' (estimated — verify locally)' : ''}</div>
        <div style="font-size:11px;">${verdict}</div>
      </div>`;
}

function broadcastPopupHtml(n: Notice): string {
    const body = n.text.length > 700 ? `${n.text.slice(0, 700)}…` : n.text;
    return `
      <div style="font-family:inherit;color:#e2e8f0;max-width:250px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:#94a3b8;margin-bottom:2px;">📄 ${esc(n.areaLabel)} ${esc(String(n.msgNumber))}/${esc(String(n.msgYear))}</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">${esc(n.title)}</div>
        <div style="font-size:11px;color:#94a3b8;white-space:pre-wrap;max-height:180px;overflow-y:auto;">${esc(body)}</div>
      </div>`;
}

export function useNoticeLayer(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean, visible: boolean) {
    const localMarkersRef = useRef<mapboxgl.Marker[]>([]);
    const broadcastMarkersRef = useRef<mapboxgl.Marker[]>([]);
    const popupRef = useRef<mapboxgl.Popup | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible) return;
        let disposed = false;

        const closePopup = () => {
            popupRef.current?.remove();
            popupRef.current = null;
        };
        const popupAt = (lon: number, lat: number, html: string) => {
            closePopup();
            popupRef.current = new mapboxgl.Popup({ closeButton: true, maxWidth: '270px', offset: 12 })
                .setLngLat([lon, lat])
                .setHTML(html)
                .addTo(map);
        };

        // ── Curated local notices — always on the chart ──
        void loadLocalNotices().then((notices) => {
            if (disposed) return;
            for (const n of notices) {
                const el = chipEl('local');
                el.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    popupAt(n.lon, n.lat, localPopupHtml(n));
                });
                localMarkersRef.current.push(
                    new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([n.lon, n.lat]).addTo(map),
                );
            }
            if (notices.length > 0) log.warn(`[ntm-local] ${notices.length} chart icon(s) placed`);
        });

        // ── Curated low bridges — 🌉 with clearance-vs-air-draft verdict ──
        void loadLowBridges().then((bridges) => {
            if (disposed) return;
            const airDraftM = vesselAirDraftMetres(useSettingsStore.getState().settings.vessel);
            for (const b of bridges) {
                const mid = b.span[Math.floor(b.span.length / 2)];
                const passable = airDraftM === null || airDraftM <= b.clearanceM;
                const el = bridgeEl(passable);
                el.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    popupAt(mid[0], mid[1], bridgePopupHtml(b, airDraftM));
                });
                localMarkersRef.current.push(
                    new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([mid[0], mid[1]]).addTo(map),
                );
            }
        });

        // ── Broadcast warnings — viewport-scoped, cached-first ──
        const renderBroadcast = () => {
            if (disposed) return;
            for (const m of broadcastMarkersRef.current) m.remove();
            broadcastMarkersRef.current = [];
            if (map.getZoom() < BROADCAST_MIN_ZOOM) return;
            const { notices } = NoticeToMarinersService.getCached();
            if (notices.length === 0) return;
            const b = map.getBounds();
            if (!b) return;
            let placed = 0;
            for (const n of notices) {
                if (placed >= BROADCAST_CAP) break;
                const c = n.coordinates[0];
                if (!c || !b.contains([c.lon, c.lat])) continue;
                const el = chipEl('broadcast');
                el.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    popupAt(c.lon, c.lat, broadcastPopupHtml(n));
                });
                broadcastMarkersRef.current.push(
                    new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([c.lon, c.lat]).addTo(map),
                );
                placed++;
            }
        };
        renderBroadcast();
        // Background refresh once per mount (6 h TTL inside the service), then re-render.
        void NoticeToMarinersService.refresh()
            .then(() => renderBroadcast())
            .catch(() => {
                /* cached-only is fine */
            });
        map.on('moveend', renderBroadcast);

        return () => {
            disposed = true;
            map.off('moveend', renderBroadcast);
            closePopup();
            for (const m of localMarkersRef.current) m.remove();
            for (const m of broadcastMarkersRef.current) m.remove();
            localMarkersRef.current = [];
            broadcastMarkersRef.current = [];
        };
    }, [mapRef, mapReady, visible]);
}
