/**
 * MmsiDecoder — Parse Maritime Identification Digits (MID) from MMSI numbers
 *
 * The first 3 digits of a 9-digit MMSI encode the vessel's flag state
 * per ITU Radio Regulations (Article 19). This utility provides:
 *
 *   1. decodeMmsi(mmsi)       → { mid, country, flag, region }
 *   2. getScrapePriority(mmsi) → 1 (AU) | 2 (US) | 3 (EU) | 4 (Global)
 *   3. getMidInfo(mid)         → country/flag lookup by MID alone
 *
 * ~120 countries covered from the ITU MID allocation table.
 * Zero dependencies — pure TypeScript utility.
 */

export interface MidInfo {
    /** 3-digit Maritime Identification Digit */
    mid: number;
    /** Country name */
    country: string;
    /** Flag emoji */
    flag: string;
    /** Geographic region for scraper priority */
    region: 'oceania' | 'americas' | 'europe' | 'asia' | 'africa' | 'unknown';
}

export interface MmsiDecodedResult extends MidInfo {
    /** Original MMSI */
    mmsi: number;
    /** Whether this is a valid vessel MMSI (starts with 2-7) */
    isVessel: boolean;
}

// ── ITU MID Table (curated — all major maritime nations) ──

const MID_TABLE: Record<number, Omit<MidInfo, 'mid'>> = {
    // ── Oceania ──
    503: { country: 'Australia', flag: '🇦🇺', region: 'oceania' },
    512: { country: 'New Zealand', flag: '🇳🇿', region: 'oceania' },
    520: { country: 'Fiji', flag: '🇫🇯', region: 'oceania' },
    523: { country: 'Tonga', flag: '🇹🇴', region: 'oceania' },
    525: { country: 'Papua New Guinea', flag: '🇵🇬', region: 'oceania' },
    529: { country: 'Samoa', flag: '🇼🇸', region: 'oceania' },
    536: { country: 'Vanuatu', flag: '🇻🇺', region: 'oceania' },

    // ── Americas ──
    303: { country: 'Alaska (USA)', flag: '🇺🇸', region: 'americas' },
    316: { country: 'Canada', flag: '🇨🇦', region: 'americas' },
    338: { country: 'United States', flag: '🇺🇸', region: 'americas' },
    339: { country: 'United States', flag: '🇺🇸', region: 'americas' },
    366: { country: 'United States', flag: '🇺🇸', region: 'americas' },
    367: { country: 'United States', flag: '🇺🇸', region: 'americas' },
    368: { country: 'United States', flag: '🇺🇸', region: 'americas' },
    369: { country: 'United States', flag: '🇺🇸', region: 'americas' },
    304: { country: 'Antigua and Barbuda', flag: '🇦🇬', region: 'americas' },
    305: { country: 'Belize', flag: '🇧🇿', region: 'americas' },
    306: { country: 'Bermuda', flag: '🇧🇲', region: 'americas' },
    307: { country: 'Brazil', flag: '🇧🇷', region: 'americas' },
    308: { country: 'Bahamas', flag: '🇧🇸', region: 'americas' },
    309: { country: 'Barbados', flag: '🇧🇧', region: 'americas' },
    310: { country: 'Chile', flag: '🇨🇱', region: 'americas' },
    311: { country: 'Colombia', flag: '🇨🇴', region: 'americas' },
    312: { country: 'Costa Rica', flag: '🇨🇷', region: 'americas' },
    314: { country: 'Cuba', flag: '🇨🇺', region: 'americas' },
    319: { country: 'Cayman Islands', flag: '🇰🇾', region: 'americas' },
    321: { country: 'Dominican Republic', flag: '🇩🇴', region: 'americas' },
    323: { country: 'Ecuador', flag: '🇪🇨', region: 'americas' },
    325: { country: 'Guyana', flag: '🇬🇾', region: 'americas' },
    327: { country: 'Haiti', flag: '🇭🇹', region: 'americas' },
    329: { country: 'Jamaica', flag: '🇯🇲', region: 'americas' },
    331: { country: 'Mexico', flag: '🇲🇽', region: 'americas' },
    332: { country: 'Nicaragua', flag: '🇳🇮', region: 'americas' },
    334: { country: 'Panama', flag: '🇵🇦', region: 'americas' },
    336: { country: 'Peru', flag: '🇵🇪', region: 'americas' },
    341: { country: 'Trinidad and Tobago', flag: '🇹🇹', region: 'americas' },
    345: { country: 'Uruguay', flag: '🇺🇾', region: 'americas' },
    350: { country: 'Argentina', flag: '🇦🇷', region: 'americas' },
    351: { country: 'Argentina', flag: '🇦🇷', region: 'americas' },
    352: { country: 'Suriname', flag: '🇸🇷', region: 'americas' },
    353: { country: 'Venezuela', flag: '🇻🇪', region: 'americas' },
    355: { country: 'Saint Kitts and Nevis', flag: '🇰🇳', region: 'americas' },
    356: { country: 'Saint Lucia', flag: '🇱🇨', region: 'americas' },
    357: { country: 'Saint Vincent', flag: '🇻🇨', region: 'americas' },
    370: { country: 'Panama', flag: '🇵🇦', region: 'americas' },
    371: { country: 'Panama', flag: '🇵🇦', region: 'americas' },
    372: { country: 'Panama', flag: '🇵🇦', region: 'americas' },
    373: { country: 'Panama', flag: '🇵🇦', region: 'americas' },
    374: { country: 'Panama', flag: '🇵🇦', region: 'americas' },
    375: { country: 'Honduras', flag: '🇭🇳', region: 'americas' },

    // ── Europe ──
    201: { country: 'Albania', flag: '🇦🇱', region: 'europe' },
    202: { country: 'Andorra', flag: '🇦🇩', region: 'europe' },
    203: { country: 'Austria', flag: '🇦🇹', region: 'europe' },
    204: { country: 'Portugal (Azores)', flag: '🇵🇹', region: 'europe' },
    205: { country: 'Belgium', flag: '🇧🇪', region: 'europe' },
    206: { country: 'Belarus', flag: '🇧🇾', region: 'europe' },
    207: { country: 'Bulgaria', flag: '🇧🇬', region: 'europe' },
    209: { country: 'Cyprus', flag: '🇨🇾', region: 'europe' },
    210: { country: 'Cyprus', flag: '🇨🇾', region: 'europe' },
    211: { country: 'Germany', flag: '🇩🇪', region: 'europe' },
    212: { country: 'Cyprus', flag: '🇨🇾', region: 'europe' },
    213: { country: 'Georgia', flag: '🇬🇪', region: 'europe' },
    214: { country: 'Moldova', flag: '🇲🇩', region: 'europe' },
    215: { country: 'Malta', flag: '🇲🇹', region: 'europe' },
    218: { country: 'Germany', flag: '🇩🇪', region: 'europe' },
    219: { country: 'Denmark', flag: '🇩🇰', region: 'europe' },
    220: { country: 'Denmark', flag: '🇩🇰', region: 'europe' },
    224: { country: 'Spain', flag: '🇪🇸', region: 'europe' },
    225: { country: 'Spain', flag: '🇪🇸', region: 'europe' },
    226: { country: 'France', flag: '🇫🇷', region: 'europe' },
    227: { country: 'France', flag: '🇫🇷', region: 'europe' },
    228: { country: 'France', flag: '🇫🇷', region: 'europe' },
    229: { country: 'Malta', flag: '🇲🇹', region: 'europe' },
    230: { country: 'Finland', flag: '🇫🇮', region: 'europe' },
    231: { country: 'Faroe Islands', flag: '🇫🇴', region: 'europe' },
    232: { country: 'United Kingdom', flag: '🇬🇧', region: 'europe' },
    233: { country: 'United Kingdom', flag: '🇬🇧', region: 'europe' },
    234: { country: 'United Kingdom', flag: '🇬🇧', region: 'europe' },
    235: { country: 'United Kingdom', flag: '🇬🇧', region: 'europe' },
    236: { country: 'Gibraltar', flag: '🇬🇮', region: 'europe' },
    237: { country: 'Greece', flag: '🇬🇷', region: 'europe' },
    239: { country: 'Greece', flag: '🇬🇷', region: 'europe' },
    240: { country: 'Greece', flag: '🇬🇷', region: 'europe' },
    241: { country: 'Greece', flag: '🇬🇷', region: 'europe' },
    242: { country: 'Morocco', flag: '🇲🇦', region: 'africa' },
    243: { country: 'Hungary', flag: '🇭🇺', region: 'europe' },
    244: { country: 'Netherlands', flag: '🇳🇱', region: 'europe' },
    245: { country: 'Netherlands', flag: '🇳🇱', region: 'europe' },
    246: { country: 'Netherlands', flag: '🇳🇱', region: 'europe' },
    247: { country: 'Italy', flag: '🇮🇹', region: 'europe' },
    248: { country: 'Malta', flag: '🇲🇹', region: 'europe' },
    249: { country: 'Malta', flag: '🇲🇹', region: 'europe' },
    250: { country: 'Ireland', flag: '🇮🇪', region: 'europe' },
    251: { country: 'Iceland', flag: '🇮🇸', region: 'europe' },
    252: { country: 'Liechtenstein', flag: '🇱🇮', region: 'europe' },
    253: { country: 'Luxembourg', flag: '🇱🇺', region: 'europe' },
    254: { country: 'Monaco', flag: '🇲🇨', region: 'europe' },
    255: { country: 'Portugal (Madeira)', flag: '🇵🇹', region: 'europe' },
    256: { country: 'Malta', flag: '🇲🇹', region: 'europe' },
    257: { country: 'Norway', flag: '🇳🇴', region: 'europe' },
    258: { country: 'Norway', flag: '🇳🇴', region: 'europe' },
    259: { country: 'Norway', flag: '🇳🇴', region: 'europe' },
    261: { country: 'Poland', flag: '🇵🇱', region: 'europe' },
    263: { country: 'Portugal', flag: '🇵🇹', region: 'europe' },
    264: { country: 'Romania', flag: '🇷🇴', region: 'europe' },
    265: { country: 'Sweden', flag: '🇸🇪', region: 'europe' },
    266: { country: 'Sweden', flag: '🇸🇪', region: 'europe' },
    267: { country: 'Slovakia', flag: '🇸🇰', region: 'europe' },
    268: { country: 'San Marino', flag: '🇸🇲', region: 'europe' },
    269: { country: 'Switzerland', flag: '🇨🇭', region: 'europe' },
    270: { country: 'Czech Republic', flag: '🇨🇿', region: 'europe' },
    271: { country: 'Turkey', flag: '🇹🇷', region: 'europe' },
    272: { country: 'Ukraine', flag: '🇺🇦', region: 'europe' },
    273: { country: 'Russia', flag: '🇷🇺', region: 'europe' },
    274: { country: 'North Macedonia', flag: '🇲🇰', region: 'europe' },
    275: { country: 'Latvia', flag: '🇱🇻', region: 'europe' },
    276: { country: 'Estonia', flag: '🇪🇪', region: 'europe' },
    277: { country: 'Lithuania', flag: '🇱🇹', region: 'europe' },
    278: { country: 'Slovenia', flag: '🇸🇮', region: 'europe' },
    279: { country: 'Croatia', flag: '🇭🇷', region: 'europe' },

    // ── Asia ──
    401: { country: 'Afghanistan', flag: '🇦🇫', region: 'asia' },
    403: { country: 'Saudi Arabia', flag: '🇸🇦', region: 'asia' },
    405: { country: 'Bangladesh', flag: '🇧🇩', region: 'asia' },
    408: { country: 'Bahrain', flag: '🇧🇭', region: 'asia' },
    410: { country: 'Bhutan', flag: '🇧🇹', region: 'asia' },
    412: { country: 'China', flag: '🇨🇳', region: 'asia' },
    413: { country: 'China', flag: '🇨🇳', region: 'asia' },
    414: { country: 'China', flag: '🇨🇳', region: 'asia' },
    416: { country: 'Taiwan', flag: '🇹🇼', region: 'asia' },
    417: { country: 'Sri Lanka', flag: '🇱🇰', region: 'asia' },
    419: { country: 'India', flag: '🇮🇳', region: 'asia' },
    422: { country: 'Iran', flag: '🇮🇷', region: 'asia' },
    423: { country: 'Azerbaijan', flag: '🇦🇿', region: 'asia' },
    425: { country: 'Iraq', flag: '🇮🇶', region: 'asia' },
    428: { country: 'Israel', flag: '🇮🇱', region: 'asia' },
    431: { country: 'Japan', flag: '🇯🇵', region: 'asia' },
    432: { country: 'Japan', flag: '🇯🇵', region: 'asia' },
    434: { country: 'Turkmenistan', flag: '🇹🇲', region: 'asia' },
    436: { country: 'Kazakhstan', flag: '🇰🇿', region: 'asia' },
    437: { country: 'Uzbekistan', flag: '🇺🇿', region: 'asia' },
    438: { country: 'Jordan', flag: '🇯🇴', region: 'asia' },
    440: { country: 'South Korea', flag: '🇰🇷', region: 'asia' },
    441: { country: 'South Korea', flag: '🇰🇷', region: 'asia' },
    443: { country: 'Palestine', flag: '🇵🇸', region: 'asia' },
    445: { country: 'North Korea', flag: '🇰🇵', region: 'asia' },
    447: { country: 'Kuwait', flag: '🇰🇼', region: 'asia' },
    450: { country: 'Lebanon', flag: '🇱🇧', region: 'asia' },
    451: { country: 'Kyrgyzstan', flag: '🇰🇬', region: 'asia' },
    453: { country: 'Macao', flag: '🇲🇴', region: 'asia' },
    455: { country: 'Maldives', flag: '🇲🇻', region: 'asia' },
    457: { country: 'Mongolia', flag: '🇲🇳', region: 'asia' },
    459: { country: 'Nepal', flag: '🇳🇵', region: 'asia' },
    461: { country: 'Oman', flag: '🇴🇲', region: 'asia' },
    463: { country: 'Pakistan', flag: '🇵🇰', region: 'asia' },
    466: { country: 'Qatar', flag: '🇶🇦', region: 'asia' },
    468: { country: 'Syria', flag: '🇸🇾', region: 'asia' },
    470: { country: 'UAE', flag: '🇦🇪', region: 'asia' },
    471: { country: 'UAE', flag: '🇦🇪', region: 'asia' },
    472: { country: 'Tajikistan', flag: '🇹🇯', region: 'asia' },
    473: { country: 'Yemen', flag: '🇾🇪', region: 'asia' },
    475: { country: 'Timor-Leste', flag: '🇹🇱', region: 'asia' },

    // ── Southeast Asia ──
    501: { country: 'Antarctica (France)', flag: '🇫🇷', region: 'oceania' },
    508: { country: 'Brunei', flag: '🇧🇳', region: 'asia' },
    510: { country: 'Micronesia', flag: '🇫🇲', region: 'oceania' },
    511: { country: 'Palau', flag: '🇵🇼', region: 'oceania' },
    514: { country: 'Cambodia', flag: '🇰🇭', region: 'asia' },
    515: { country: 'Myanmar', flag: '🇲🇲', region: 'asia' },
    516: { country: 'Philippines', flag: '🇵🇭', region: 'asia' },
    518: { country: 'Cook Islands', flag: '🇨🇰', region: 'oceania' },
    524: { country: 'Thailand', flag: '🇹🇭', region: 'asia' },
    533: { country: 'Malaysia', flag: '🇲🇾', region: 'asia' },
    548: { country: 'Laos', flag: '🇱🇦', region: 'asia' },
    553: { country: 'Nauru', flag: '🇳🇷', region: 'oceania' },
    555: { country: 'Marshall Islands', flag: '🇲🇭', region: 'oceania' },
    557: { country: 'Solomon Islands', flag: '🇸🇧', region: 'oceania' },
    561: { country: 'Vietnam', flag: '🇻🇳', region: 'asia' },
    564: { country: 'Singapore', flag: '🇸🇬', region: 'asia' },
    565: { country: 'Singapore', flag: '🇸🇬', region: 'asia' },
    566: { country: 'Singapore', flag: '🇸🇬', region: 'asia' },
    567: { country: 'Thailand', flag: '🇹🇭', region: 'asia' },
    570: { country: 'Tuvalu', flag: '🇹🇻', region: 'oceania' },
    572: { country: 'Kiribati', flag: '🇰🇮', region: 'oceania' },
    574: { country: 'Vietnam', flag: '🇻🇳', region: 'asia' },
    576: { country: 'Tonga', flag: '🇹🇴', region: 'oceania' },
    577: { country: 'Vanuatu', flag: '🇻🇺', region: 'oceania' },
    578: { country: 'Indonesia', flag: '🇮🇩', region: 'asia' },

    // ── Africa ──
    601: { country: 'South Africa', flag: '🇿🇦', region: 'africa' },
    603: { country: 'Angola', flag: '🇦🇴', region: 'africa' },
    605: { country: 'Algeria', flag: '🇩🇿', region: 'africa' },
    607: { country: 'Cameroon', flag: '🇨🇲', region: 'africa' },
    609: { country: 'Cape Verde', flag: '🇨🇻', region: 'africa' },
    610: { country: 'Comoros', flag: '🇰🇲', region: 'africa' },
    611: { country: 'Congo', flag: '🇨🇬', region: 'africa' },
    612: { country: 'Ivory Coast', flag: '🇨🇮', region: 'africa' },
    613: { country: 'Djibouti', flag: '🇩🇯', region: 'africa' },
    616: { country: 'Egypt', flag: '🇪🇬', region: 'africa' },
    617: { country: 'Eritrea', flag: '🇪🇷', region: 'africa' },
    618: { country: 'Ethiopia', flag: '🇪🇹', region: 'africa' },
    619: { country: 'Gabon', flag: '🇬🇦', region: 'africa' },
    620: { country: 'Gambia', flag: '🇬🇲', region: 'africa' },
    621: { country: 'Ghana', flag: '🇬🇭', region: 'africa' },
    622: { country: 'Guinea', flag: '🇬🇳', region: 'africa' },
    624: { country: 'Kenya', flag: '🇰🇪', region: 'africa' },
    625: { country: 'Liberia', flag: '🇱🇷', region: 'africa' },
    626: { country: 'Libya', flag: '🇱🇾', region: 'africa' },
    627: { country: 'Madagascar', flag: '🇲🇬', region: 'africa' },
    629: { country: 'Mauritius', flag: '🇲🇺', region: 'africa' },
    630: { country: 'Mozambique', flag: '🇲🇿', region: 'africa' },
    631: { country: 'Namibia', flag: '🇳🇦', region: 'africa' },
    632: { country: 'Nigeria', flag: '🇳🇬', region: 'africa' },
    633: { country: 'Reunion', flag: '🇷🇪', region: 'africa' },
    636: { country: 'Seychelles', flag: '🇸🇨', region: 'africa' },
    637: { country: 'Sierra Leone', flag: '🇸🇱', region: 'africa' },
    638: { country: 'Somalia', flag: '🇸🇴', region: 'africa' },
    642: { country: 'Tanzania', flag: '🇹🇿', region: 'africa' },
    644: { country: 'Togo', flag: '🇹🇬', region: 'africa' },
    645: { country: 'Tunisia', flag: '🇹🇳', region: 'africa' },
    647: { country: 'Zanzibar', flag: '🇹🇿', region: 'africa' },
    649: { country: 'DR Congo', flag: '🇨🇩', region: 'africa' },
    650: { country: 'Guinea-Bissau', flag: '🇬🇼', region: 'africa' },
    654: { country: 'Mauritania', flag: '🇲🇷', region: 'africa' },
    655: { country: 'Senegal', flag: '🇸🇳', region: 'africa' },
    657: { country: 'Sudan', flag: '🇸🇩', region: 'africa' },
    659: { country: 'Equatorial Guinea', flag: '🇬🇶', region: 'africa' },
    660: { country: 'Benin', flag: '🇧🇯', region: 'africa' },
    661: { country: 'Burkina Faso', flag: '🇧🇫', region: 'africa' },
    662: { country: 'Mali', flag: '🇲🇱', region: 'africa' },
    663: { country: 'Niger', flag: '🇳🇪', region: 'africa' },
    664: { country: 'Chad', flag: '🇹🇩', region: 'africa' },
    667: { country: 'Rwanda', flag: '🇷🇼', region: 'africa' },
    669: { country: 'Zimbabwe', flag: '🇿🇼', region: 'africa' },
    670: { country: 'Malawi', flag: '🇲🇼', region: 'africa' },
    672: { country: 'Uganda', flag: '🇺🇬', region: 'africa' },
    674: { country: 'Zambia', flag: '🇿🇲', region: 'africa' },
    676: { country: 'Lesotho', flag: '🇱🇸', region: 'africa' },
    677: { country: 'Botswana', flag: '🇧🇼', region: 'africa' },
    678: { country: 'Burundi', flag: '🇧🇮', region: 'africa' },
};

// ── US MID set (multiple allocations) ──
const US_MIDS = new Set([303, 338, 339, 366, 367, 368, 369]);

// ── Australia MID ──
const AU_MID = 503;

/**
 * Extract the 3-digit MID from a 9-digit MMSI.
 * Handles both number and string inputs.
 */
function extractMid(mmsi: number | string): number {
    const s = String(mmsi).padStart(9, '0');
    return parseInt(s.substring(0, 3), 10);
}

/**
 * Check if an MMSI represents a vessel (first digit 2-7).
 * Other ranges: coast stations (00x), SAR aircraft (111), etc.
 */
function isVesselMmsi(mmsi: number | string): boolean {
    const first = String(mmsi).padStart(9, '0')[0];
    return first >= '2' && first <= '7';
}

// ── PUBLIC API ──

/**
 * Decode a full MMSI to country, flag, and region.
 *
 * @example
 *   decodeMmsi(503123456)
 *   // → { mmsi: 503123456, mid: 503, country: 'Australia', flag: '🇦🇺', region: 'oceania', isVessel: true }
 */
export function decodeMmsi(mmsi: number | string): MmsiDecodedResult {
    const numericMmsi = typeof mmsi === 'string' ? parseInt(mmsi, 10) : mmsi;
    const mid = extractMid(numericMmsi);
    const info = MID_TABLE[mid];

    return {
        mmsi: numericMmsi,
        mid,
        country: info?.country ?? 'Unknown',
        flag: info?.flag ?? '🏴',
        region: info?.region ?? 'unknown',
        isVessel: isVesselMmsi(numericMmsi),
    };
}

/**
 * Get MID info by MID alone (without full MMSI).
 */
export function getMidInfo(mid: number): MidInfo {
    const info = MID_TABLE[mid];
    return {
        mid,
        country: info?.country ?? 'Unknown',
        flag: info?.flag ?? '🏴',
        region: info?.region ?? 'unknown',
    };
}

/**
 * Get scrape priority for routing scraper requests.
 *
 * Priority 1: Australia (MID 503) — AMSA register
 * Priority 2: USA (MID 338/366+) — USCG AVIS
 * Priority 3: Europe (MID 200-299) — Equasis/MCA
 * Priority 4: Global/Asia/Africa — ITU MARS / GFW
 */
export function getScrapePriority(mmsi: number | string): 1 | 2 | 3 | 4 {
    const mid = extractMid(mmsi);

    if (mid === AU_MID) return 1;
    if (US_MIDS.has(mid)) return 2;
    if (mid >= 200 && mid <= 299) return 3;
    return 4;
}

/**
 * Get just the flag emoji for an MMSI (lightweight — for map labels).
 */
export function getMmsiFlag(mmsi: number | string): string {
    const mid = extractMid(mmsi);
    return MID_TABLE[mid]?.flag ?? '🏴';
}

/**
 * Get just the country name for an MMSI.
 */
export function getMmsiCountry(mmsi: number | string): string {
    const mid = extractMid(mmsi);
    return MID_TABLE[mid]?.country ?? 'Unknown';
}
