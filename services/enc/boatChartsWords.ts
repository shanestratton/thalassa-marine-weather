/**
 * boatChartsWords — the one place the app says where a skipper's charts are
 * (127-C-c decision 11; 127-DESKMAP C1/C2 landed first, with the two web
 * states). Licensed charts never leave the boat (o-charts, 2026-10-10:
 * "Storing unencrypted data on any medium, and especially in the cloud, is
 * strictly prohibited"), so a browser only ever has the open charts.
 *
 *  - 'web': an account whose paired Pi holds licensed charts
 *    (settings.boatCharts.licensed, written by the phone aboard).
 *  - 'web-open': everyone else (NOAA-only, no Pi, crew, signed out). Never
 *    "licensed", "stay on" or a boat name: those would claim a boat and a
 *    licence the account doesn't have.
 *
 * 'strip' is the one-line credits-strip line under the desk menu, 'notice' the
 * web Obs no-charts sentence. 127-C-c adds its own states here; no second copy
 * of these words lives in a component.
 */
export type BoatChartsState = 'web' | 'web-open';
export type BoatChartsForm = 'strip' | 'notice';

export function boatChartsLine(
    state: BoatChartsState,
    boatName: string | null | undefined,
    form: BoatChartsForm = 'notice',
): string {
    if (state === 'web-open')
        return form === 'strip'
            ? 'No chart for this area'
            : 'No chart for this area. Open charts (NOAA) show here in US waters.';
    const name = boatName?.trim();
    const line = name ? `Licensed charts stay on ${name}` : 'Licensed charts stay aboard';
    return form === 'strip' ? line : `${line}. Open charts show here where they exist (NOAA, US waters).`;
}
