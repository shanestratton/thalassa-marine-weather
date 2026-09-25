import { CONDITION_COLOURS, CONDITION_LABELS, type PlaceConditions } from '../../services/anchorages/placeConditions';
const esc = (s: unknown) =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
export function placeConditionsHtml(v: PlaceConditions): string {
    const time = (t: number) =>
        new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div style="margin-top:10px;border-top:1px solid #cbd5e1;padding-top:8px;font-size:12px;line-height:1.4">
      <strong style="color:#0f172a"><span style="color:${CONDITION_COLOURS[v.light]}">●</span> ${esc(CONDITION_LABELS[v.light])}</strong>
      <div>Next 12 h · worst conditions · until ${esc(time(v.toMs))}</div>
      ${v.reasons.map((r) => `<div style="margin-top:4px">${esc(r)}</div>`).join('')}
      ${v.worstAt ? `<div>First adverse hour: ${esc(time(v.worstAt))}</div>` : ''}
      <div style="margin-top:6px;font-size:10px;color:#475569">${v.fetchedAt ? `Forecast retrieved ${esc(time(v.fetchedAt))}. ` : ''}Device-local times. Forecast: Open-Meteo / national weather services; shoreline: © OpenStreetMap contributors.</div>
      <div style="margin-top:6px;font-size:11px;color:#854d0e">Weather advisory, not clearance. Check official warnings, depth/tide, holding, swing room, local gusts and access; mooring tag and condition still govern.</div>
    </div>`;
}
