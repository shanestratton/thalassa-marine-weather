/** Full marine credit lives in existing information sheets, not over the data. */
export function MarineDataCredit() {
    return (
        <a
            href="https://open-meteo.com/en/docs/marine-weather-api"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center text-sky-300 underline"
        >
            Marine: Météo-France; E.U. Copernicus Marine Service Information, © Mercator Ocean, via Open-Meteo (CC BY
            4.0).
        </a>
    );
}
