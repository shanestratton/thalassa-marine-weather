/**
 * Money on this phone (132-B17, binder audit GAL-09): which currency a
 * sailor's prices are in, and how this phone writes an amount.
 *
 * The Grocery list stamped every row 'AUD' and wrote every price as '$', so a
 * sailor provisioning in Nuku'alofa or Papeete saw Australian dollars. A new
 * row now takes the currency chosen in Settings → Preferences, or with none
 * chosen, the one of the phone's region. A stored row keeps the currency it
 * was saved in. Amounts are written the phone's way (Intl): Australian dollars
 * read '$12.50' on an Australian phone and 'A$12.50' on an American one.
 */

/** A currency Preferences offers: its ISO 4217 code and its name in words. */
export interface CurrencyChoice {
    code: string;
    name: string;
}

/**
 * The currencies Preferences offers: the Pacific first, where most of the
 * app's sailors provision, then Asia, the Americas and Europe.
 */
export const CURRENCY_CHOICES: readonly CurrencyChoice[] = [
    { code: 'AUD', name: 'Australian dollar' },
    { code: 'NZD', name: 'New Zealand dollar' },
    { code: 'FJD', name: 'Fijian dollar' },
    { code: 'XPF', name: 'Pacific franc (French Polynesia, New Caledonia)' },
    { code: 'VUV', name: 'Vanuatu vatu' },
    { code: 'TOP', name: 'Tongan paʻanga' },
    { code: 'WST', name: 'Samoan tālā' },
    { code: 'SBD', name: 'Solomon Islands dollar' },
    { code: 'PGK', name: 'Papua New Guinea kina' },
    { code: 'IDR', name: 'Indonesian rupiah' },
    { code: 'SGD', name: 'Singapore dollar' },
    { code: 'MYR', name: 'Malaysian ringgit' },
    { code: 'THB', name: 'Thai baht' },
    { code: 'PHP', name: 'Philippine peso' },
    { code: 'HKD', name: 'Hong Kong dollar' },
    { code: 'JPY', name: 'Japanese yen' },
    { code: 'USD', name: 'US dollar' },
    { code: 'CAD', name: 'Canadian dollar' },
    { code: 'MXN', name: 'Mexican peso' },
    { code: 'BSD', name: 'Bahamian dollar' },
    { code: 'XCD', name: 'East Caribbean dollar' },
    { code: 'BRL', name: 'Brazilian real' },
    { code: 'GBP', name: 'British pound' },
    { code: 'EUR', name: 'Euro' },
    { code: 'CHF', name: 'Swiss franc' },
    { code: 'NOK', name: 'Norwegian krone' },
    { code: 'SEK', name: 'Swedish krona' },
    { code: 'DKK', name: 'Danish krone' },
    { code: 'TRY', name: 'Turkish lira' },
    { code: 'ZAR', name: 'South African rand' },
];

/**
 * Where each currency is spent, by the ISO 3166 region a phone names, for the
 * currencies CURRENCY_CHOICES offers. The islands that spend another
 * country's money are listed with it (Kiribati with the Australian dollar,
 * the Cook Islands with the New Zealand dollar, Ecuador with the US dollar).
 */
const CURRENCY_REGIONS: Record<string, string> = {
    AUD: 'AU CC CX KI NF NR TV',
    NZD: 'NZ CK NU PN TK',
    FJD: 'FJ',
    XPF: 'PF NC WF',
    VUV: 'VU',
    TOP: 'TO',
    WST: 'WS',
    SBD: 'SB',
    PGK: 'PG',
    IDR: 'ID',
    SGD: 'SG',
    MYR: 'MY',
    THB: 'TH',
    PHP: 'PH',
    HKD: 'HK',
    JPY: 'JP',
    USD: 'US AS BQ EC FM GU MH MP PA PR PW SV TC TL VG VI',
    CAD: 'CA',
    MXN: 'MX',
    BSD: 'BS',
    XCD: 'AG AI DM GD KN LC MS VC',
    BRL: 'BR',
    GBP: 'GB GG IM JE',
    EUR: 'AD AT BE BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM VA YT',
    CHF: 'CH LI',
    NOK: 'NO SJ',
    SEK: 'SE',
    DKK: 'DK FO GL',
    TRY: 'TR',
    ZAR: 'ZA',
};

/** A phone's region to the currency spent there: 'AU' → 'AUD'. */
const REGION_CURRENCY: Record<string, string> = Object.fromEntries(
    Object.entries(CURRENCY_REGIONS).flatMap(([code, regions]) => regions.split(' ').map((region) => [region, code])),
);

/**
 * With no currency chosen and no region this phone names (a bare 'en'), the
 * Australian dollar: what every row was stamped before 132-B17, so nothing
 * changes for those phones until the sailor picks one.
 */
export const FALLBACK_CURRENCY = 'AUD';

/** An ISO 4217 code: three capitals. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** The region a language tag names: 'AU' in 'en-AU', 'HK' in 'zh-Hant-HK'; null for a bare 'en' or 'es-419'. */
function regionOf(tag: string): string | null {
    const parts = tag.split(/[-_]/);
    for (const part of parts.slice(1)) {
        if (/^[A-Za-z]{2}$/.test(part)) return part.toUpperCase();
    }
    return null;
}

/** The phone's languages, most preferred first: each one carries its region ('en-AU'). */
function phoneLanguages(): readonly string[] {
    if (typeof navigator === 'undefined') return [];
    return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/**
 * The currency of the phone's region: the first of its languages whose region
 * this table knows ('en-AU' → AUD, 'fr-PF' → XPF). Null when none does.
 */
export function regionCurrency(languages: readonly string[] = phoneLanguages()): string | null {
    for (const tag of languages) {
        const region = regionOf(tag);
        if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
    }
    return null;
}

/**
 * The currency new prices go in: the one chosen in Preferences when it is a
 * real code, else the phone region's, else the Australian dollar.
 */
export function resolveCurrency(chosen: string | null | undefined, languages?: readonly string[]): string {
    const code = chosen?.trim().toUpperCase();
    if (code && CURRENCY_CODE.test(code)) return code;
    return regionCurrency(languages) ?? FALLBACK_CURRENCY;
}

/** The name Preferences gives a code, or the code itself for one it does not list. */
export function currencyName(code: string): string {
    return CURRENCY_CHOICES.find((choice) => choice.code === code)?.name ?? code;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** One formatter per locale and currency: building one is the slow part. */
function moneyFormat(currency: string, locale?: string): Intl.NumberFormat | null {
    const key = `${locale ?? ''}|${currency}`;
    let format = formatters.get(key);
    if (!format) {
        try {
            format = new Intl.NumberFormat(locale, { style: 'currency', currency });
        } catch {
            // A code Intl refuses (not three letters) is written by hand below.
            return null;
        }
        formatters.set(key, format);
    }
    return format;
}

/** A stored row's code, read safely: anything unreadable is the fallback. */
function storedCode(currency: string | null | undefined): string {
    const code = currency?.trim().toUpperCase();
    return code && CURRENCY_CODE.test(code) ? code : FALLBACK_CURRENCY;
}

/**
 * An amount as this phone writes it in that currency: '$12.50', 'A$12.50',
 * '12,50 €', 'F 1 200'. `locale` is for tests; the app passes none, so the
 * phone's own language and region decide.
 */
export function formatMoney(amount: number, currency: string | null | undefined, locale?: string): string {
    const code = storedCode(currency);
    const format = moneyFormat(code, locale);
    return format ? format.format(amount) : `${code} ${amount.toFixed(2)}`;
}

/** The sign this phone writes before (or after) an amount in that currency: '$', 'A$', '€', 'F'. */
export function currencySymbol(currency: string | null | undefined, locale?: string): string {
    const code = storedCode(currency);
    const part = moneyFormat(code, locale)
        ?.formatToParts(0)
        .find((p) => p.type === 'currency');
    return part?.value ?? code;
}

/** What was spent, one total per currency, largest first: rows in two currencies are never added together. */
export function spendByCurrency(
    rows: readonly { actual_cost: number | null; currency?: string | null; purchased?: boolean }[],
): { currency: string; total: number }[] {
    const totals = new Map<string, number>();
    for (const row of rows) {
        if (row.purchased === false || row.actual_cost === null || !Number.isFinite(row.actual_cost)) continue;
        const code = storedCode(row.currency);
        totals.set(code, (totals.get(code) ?? 0) + row.actual_cost);
    }
    return [...totals.entries()]
        .map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 }))
        .filter((entry) => entry.total > 0)
        .sort((a, b) => b.total - a.total);
}

/** Spend in one line: '$42.10', or '$42.10 + US$8.00' across currencies; '' for none. */
export function formatSpend(totals: readonly { currency: string; total: number }[], locale?: string): string {
    return totals.map((entry) => formatMoney(entry.total, entry.currency, locale)).join(' + ');
}
