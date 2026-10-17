/** Primary public reporting entry points verified17 October2026. Nothing is submitted automatically.
 * Direct form coverage is explicit; other offices use the current IHO directory. */
export const HYDROGRAPHIC_REPORTING = Object.freeze([
    {
        id: 'AU',
        label: 'Australia · AHO Hydrographic Note',
        url: 'https://www.hydro.gov.au/resources/forms/hydrographic-note',
    },
    {
        id: 'NZ',
        label: 'New Zealand · LINZ Hydrographic Note',
        url: 'https://www.linz.govt.nz/products-services/maritime-safety/safety-sea/report-hazard-navigation-hydrographic-note',
    },
    {
        id: 'UK',
        label: 'United Kingdom · UKHO Hydrographic Notes',
        url: 'https://www.admiralty.co.uk/maritime-safety-information/hydrographic-notes',
    },
    {
        id: 'US',
        label: 'United States · NOAA ASSIST',
        url: 'https://www.nauticalcharts.noaa.gov/customer-service/assist/',
        help: 'https://www.nauticalcharts.noaa.gov/customer-service/assist.html',
    },
    {
        id: 'CA',
        label: 'Canada · CHS Marine Information Reporting',
        url: 'https://www.charts.gc.ca/help-aide/marep/index-eng.asp',
    },
    { id: 'IHO', label: 'Other offices · IHO official directory', url: 'https://iho.int/en/map-of-member-states' },
] as const);
