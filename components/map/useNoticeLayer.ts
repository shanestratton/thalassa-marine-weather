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
import { loadQldNotices, groupByAnchor, type QldNotice } from '../../services/qldNotices';
import {
    NTM_ROUTING_PACKS,
    ntmPackStatus,
    isPackAcked,
    ackPack,
    revokePackAck,
    type NtmRoutingPack,
    type NtmPackStatus,
} from '../../services/ntmRouting';
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

function qldGroupPopupHtml(label: string, group: readonly QldNotice[]): string {
    const items = group
        .slice(0, 4)
        .map(
            (n) => `
        <div style="margin-bottom:7px;">
          <a href="${esc(n.pdfUrl)}" target="_blank" rel="noopener" style="color:#38bdf8;text-decoration:underline;font-size:12px;font-weight:700;">${esc(n.number)}</a>
          <span style="font-size:10px;color:#64748b;"> · ${esc(n.dateStr)}</span>
          <div style="font-size:11px;color:#cbd5e1;">${esc(n.subject)}</div>
        </div>`,
        )
        .join('');
    const more =
        group.length > 4
            ? `<div style="font-size:10px;"><a href="${esc(group[0].datasetUrl)}" target="_blank" rel="noopener" style="color:#94a3b8;text-decoration:underline;">+${group.length - 4} more — all ${esc(group[0].region)} notices</a></div>`
            : `<div style="font-size:10px;"><a href="${esc(group[0].datasetUrl)}" target="_blank" rel="noopener" style="color:#94a3b8;text-decoration:underline;">All ${esc(group[0].region)} notices</a></div>`;
    return `
      <div style="font-family:inherit;color:#e2e8f0;max-width:260px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:#fcd34d;margin-bottom:2px;">📄 NOTICES TO MARINERS — MSQ</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:6px;">${esc(label)}</div>
        ${items}
        ${more}
      </div>`;
}

/**
 * Routing-guidance section appended to a notice popup when a curated routing
 * pack (services/ntmRouting.ts) exists for the anchor. The APPLY button is the
 * explicit acknowledgment — reading the PDF alone never changes routing.
 */
function packSectionHtml(pack: NtmRoutingPack, status: NtmPackStatus, acked: boolean): string {
    const depths = pack.zones.map((z) => `${esc(z.label)} ${z.depthM.toFixed(1)} m`).join(' · ');
    let action: string;
    if (status.status === 'superseded') {
        action = `<div style="font-size:11px;color:#f87171;">Superseded by ${esc(status.liveNumber)} — routing guidance disabled until this app's transcription is updated to the new notice. Read the current PDF above.</div>`;
    } else if (status.status === 'unverified') {
        action = `<div style="font-size:11px;color:#fbbf24;">Can't verify this notice is still current (${esc(status.reason)}) — routing guidance disabled. It re-enables when the notice feed refreshes.</div>`;
    } else if (acked) {
        action = `<div style="font-size:11px;color:#4ade80;">✓ Applied to routing for this passage.</div>
          <button id="ntm-revoke-${esc(pack.id)}" style="margin-top:4px;font-size:10px;padding:3px 8px;background:transparent;color:#94a3b8;border:1px solid rgba(148,163,184,0.4);border-radius:6px;cursor:pointer;">Remove from routing</button>`;
    } else {
        action = `<button id="ntm-apply-${esc(pack.id)}" style="margin-top:2px;font-size:11px;font-weight:700;padding:6px 10px;background:#7c3aed;color:#f5f3ff;border:none;border-radius:7px;cursor:pointer;">I've read it — apply surveyed depths to routing (24 h)</button>`;
    }
    return `
      <div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(148,163,184,0.25);">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:#c084fc;margin-bottom:3px;">⚓ ROUTING GUIDANCE — SURVEYED ${esc(pack.surveyed)}</div>
        <div style="font-size:11px;color:#cbd5e1;margin-bottom:5px;">${depths}</div>
        ${action}
        <div style="font-size:9px;color:#64748b;margin-top:5px;">Guidance only — never a substitute for the notice itself, your own eyes, or local knowledge. Coastal bars change rapidly.</div>
      </div>`;
}

/** Magenta virtual-AtoN symbol (AIS virtual aids from the notice — display always). */
function virtualMarkEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.textContent = '◈';
    Object.assign(el.style, {
        fontSize: '13px',
        lineHeight: '1',
        padding: '1px 3px',
        color: '#e879f9',
        background: 'rgba(15, 23, 42, 0.85)',
        border: '1px solid rgba(232, 121, 249, 0.55)',
        borderRadius: '50%',
        cursor: 'pointer',
        boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
    } satisfies Partial<CSSStyleDeclaration>);
    return el;
}

function virtualMarkPopupHtml(pack: NtmRoutingPack, name: string): string {
    return `
      <div style="font-family:inherit;color:#e2e8f0;max-width:230px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:#e879f9;margin-bottom:2px;">◈ VIRTUAL NAVIGATION AID</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">${esc(name)}</div>
        <div style="font-size:11px;color:#cbd5e1;margin-bottom:4px;">AIS virtual reference mark from NtM ${esc(pack.noticeKey)} — promulgated for an alternative route. There is NO physical mark in the water.</div>
        <div style="font-size:10px;color:#94a3b8;">Guidance only — do not rely on it as your only means of navigation.</div>
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
            // className wires the dark glass card in index.css (.ntm-popup) —
            // without it the content renders bare text over the chart.
            popupRef.current = new mapboxgl.Popup({
                closeButton: true,
                maxWidth: '290px',
                offset: 12,
                className: 'ntm-popup',
            })
                .setLngLat([lon, lat])
                .setHTML(html)
                .addTo(map);
        };

        // ── QLD LIVE notices (CKAN, direct PDF links) + curated fallback ──
        // One 📄 per locality anchor; the popup lists the freshest notices for
        // that spot each linked STRAIGHT to its PDF (the thing that is "very
        // difficult to find" on the MSQ site). Curated bundled notices only
        // render where no live anchor covers the same spot (offline fallback).
        void Promise.all([loadQldNotices().catch(() => []), loadLocalNotices()]).then(([live, curated]) => {
            if (disposed) return;
            const anchors = groupByAnchor(live);
            let placed = 0;
            for (const [label, group] of anchors) {
                const n0 = group[0];
                if (n0.lat === undefined || n0.lon === undefined) continue;
                // Routing pack for this anchor (Mooloolaba today) — status is
                // resolved fresh at TAP time so the popup never shows a stale
                // verdict, and the APPLY tap is the explicit routing ack.
                const pack = NTM_ROUTING_PACKS.find((p) => p.anchorLabel === label) ?? null;
                const el = chipEl('local');
                el.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    void (async () => {
                        let html = qldGroupPopupHtml(label, group);
                        let status: NtmPackStatus | null = null;
                        if (pack) {
                            status = await ntmPackStatus(pack);
                            html += packSectionHtml(pack, status, isPackAcked(pack));
                        }
                        if (disposed) return;
                        popupAt(n0.lon as number, n0.lat as number, html);
                        if (!pack) return;
                        const rerender = () => el.dispatchEvent(new MouseEvent('click'));
                        document.getElementById(`ntm-apply-${pack.id}`)?.addEventListener('click', () => {
                            ackPack(pack);
                            rerender();
                        });
                        document.getElementById(`ntm-revoke-${pack.id}`)?.addEventListener('click', () => {
                            revokePackAck(pack);
                            rerender();
                        });
                    })();
                });
                localMarkersRef.current.push(
                    new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([n0.lon, n0.lat]).addTo(map),
                );
                placed++;
            }
            // Virtual AIS marks from routing packs — display ALWAYS (MSQ
            // promulgated them for exactly this), routing never.
            for (const pack of NTM_ROUTING_PACKS) {
                for (const m of pack.marks) {
                    const el = virtualMarkEl();
                    el.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        popupAt(m.lon, m.lat, virtualMarkPopupHtml(pack, m.name));
                    });
                    localMarkersRef.current.push(
                        new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([m.lon, m.lat]).addTo(map),
                    );
                }
            }
            // Curated entries: only where no live anchor sits within ~600 m.
            const nearLive = (lat: number, lon: number): boolean => {
                for (const [, group] of anchors) {
                    const a = group[0];
                    if (a.lat === undefined || a.lon === undefined) continue;
                    const dx = (a.lon - lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
                    const dy = (a.lat - lat) * 110_540;
                    if (Math.hypot(dx, dy) < 600) return true;
                }
                return false;
            };
            for (const n of curated) {
                if (nearLive(n.lat, n.lon)) continue;
                const el = chipEl('local');
                el.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    popupAt(n.lon, n.lat, localPopupHtml(n));
                });
                localMarkersRef.current.push(
                    new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([n.lon, n.lat]).addTo(map),
                );
                placed++;
            }
            if (placed > 0) log.warn(`[ntm] ${placed} notice icon(s) placed (${anchors.size} live QLD anchors)`);
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
