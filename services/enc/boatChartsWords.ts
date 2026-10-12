/**
 * boatChartsWords — the one place the app says where a skipper's charts are
 * (127-C-c decision 11; 127-DESKMAP C1/C2 landed first, with the two web
 * states). Licensed charts never leave the boat (o-charts, 2026-10-10:
 * "Storing unencrypted data on any medium, and especially in the cloud, is
 * strictly prohibited"): they stay on her Pi and open in the phone's memory on
 * the boat's Wi-Fi only, so a browser — or a phone ashore — has the open
 * charts alone.
 *
 *  - 'web': an account whose paired Pi holds licensed charts
 *    (settings.boatCharts.licensed, written by the phone aboard).
 *  - 'web-open': everyone else (NOAA-only, no Pi, crew, signed out). Never
 *    "licensed", "stay on" or a boat name: those would claim a boat and a
 *    licence the account doesn't have.
 *  - 'away' (off the boat's Wi-Fi), 'tailnet' (remote access), 'off' (the
 *    BOAT_CELLS_ON_PHONE switch), 'opening' and 'slow' (the Route tracer's
 *    wait, decision 7a), 'recheck' (Cast Off over her licensed charts).
 *
 * 'strip' is the short form (the desk strip, Auto's status, the Charts card),
 * 'notice' the sentence. No second copy of these words lives in a component.
 */
export type BoatChartsState = 'web' | 'web-open' | 'away' | 'tailnet' | 'off' | 'opening' | 'slow' | 'recheck';
export type BoatChartsForm = 'strip' | 'notice';

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function boatChartsLine(
    state: BoatChartsState,
    boatName: string | null | undefined,
    form: BoatChartsForm = 'notice',
): string {
    const name = boatName?.trim();
    const her = `${name || 'your boat'}'s`;
    switch (state) {
        case 'web-open':
            return form === 'strip'
                ? 'No chart for this area'
                : 'No chart for this area. Open charts (NOAA) show here in US waters.';
        case 'web': {
            const line = name ? `Licensed charts stay on ${name}` : 'Licensed charts stay aboard';
            return form === 'strip' ? line : `${line}. Open charts show here where they exist (NOAA, US waters).`;
        }
        case 'away':
            return form === 'strip'
                ? `${cap(her)} charts open on the boat's Wi-Fi.`
                : `${cap(her)} licensed charts open on the boat's Wi-Fi. Open charts only here.`;
        case 'tailnet':
            return `Licensed charts open only on ${her} own Wi-Fi, not over remote access.`;
        case 'off':
            return `Licensed charts stay on ${her} Pi in this build.`;
        case 'opening':
            return `Opening ${her} charts from the Pi…`;
        case 'slow':
            return `${cap(her)} charts are slow to open from the Pi. Until they do, legs are checked on open charts.`;
        case 'recheck':
            return `Checked on ${her} charts. They open on the boat's Wi-Fi; recheck there before Cast Off.`;
    }
}

/** Save, Follow and Cast Off while her licensed charts are not open here (decision 7a). */
export function boatChartsRefusal(state: BoatChartsState, boatName: string | null | undefined): string {
    if (state === 'slow')
        return `${cap(`${boatName?.trim() || 'your boat'}'s`)} charts are still opening from the Pi. Check it once they open.`;
    const line =
        state === 'away'
            ? boatChartsLine('away', boatName, 'strip').replace(' charts', ' licensed charts')
            : boatChartsLine(state, boatName);
    return `${line} Check it on the boat's Wi-Fi.`;
}

/** The Charts card's summary aboard. */
export const boatChartsAboardLine = (count: number, boatName: string | null | undefined): string =>
    `${count.toLocaleString()} chart${count === 1 ? '' : 's'} aboard ${boatName?.trim() || 'your boat'} · opened in memory, never saved on this phone`;

export const BOAT_CHARTS_FOOT =
    "Licensed charts stay on your boat's Pi. This phone opens them in memory on the boat's Wi-Fi and never saves them, as the chart licences require. Open charts (NOAA) are kept on this phone.";
