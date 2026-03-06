/**
 * Location data for Crew Finder dropdowns.
 * Country → States/Provinces for cascading selection.
 * Focused on major sailing nations.
 */

export const COUNTRIES = [
    'Australia',
    'Bahamas',
    'Brazil',
    'Canada',
    'Chile',
    'Croatia',
    'Denmark',
    'Fiji',
    'Finland',
    'France',
    'Germany',
    'Greece',
    'India',
    'Indonesia',
    'Ireland',
    'Italy',
    'Japan',
    'Malaysia',
    'Malta',
    'Mexico',
    'Monaco',
    'Montenegro',
    'Netherlands',
    'New Caledonia',
    'New Zealand',
    'Norway',
    'Panama',
    'Philippines',
    'Poland',
    'Portugal',
    'Singapore',
    'South Africa',
    'Spain',
    'Sweden',
    'Thailand',
    'Tonga',
    'Trinidad and Tobago',
    'Turkey',
    'United Arab Emirates',
    'United Kingdom',
    'United States',
    'Vanuatu',
] as const;

export type CountryName = typeof COUNTRIES[number];

export const STATES_BY_COUNTRY: Partial<Record<CountryName, string[]>> = {
    'Australia': [
        'Australian Capital Territory', 'New South Wales', 'Northern Territory',
        'Queensland', 'South Australia', 'Tasmania', 'Victoria', 'Western Australia',
    ],
    'Canada': [
        'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick',
        'Newfoundland and Labrador', 'Nova Scotia', 'Ontario',
        'Prince Edward Island', 'Quebec', 'Saskatchewan',
    ],
    'Croatia': [
        'Dubrovnik-Neretva', 'Istria', 'Primorje-Gorski Kotar',
        'Šibenik-Knin', 'Split-Dalmatia', 'Zadar',
    ],
    'France': [
        'Brittany', 'Corsica', 'French Riviera (PACA)',
        'Île-de-France', 'Normandy', 'Nouvelle-Aquitaine', 'Occitanie',
    ],
    'Germany': [
        'Bavaria', 'Berlin', 'Hamburg', 'Lower Saxony',
        'Mecklenburg-Vorpommern', 'Schleswig-Holstein',
    ],
    'Greece': [
        'Attica', 'Central Greece', 'Central Macedonia', 'Crete',
        'Ionian Islands', 'North Aegean', 'Peloponnese', 'South Aegean',
        'Thessaly', 'Western Greece',
    ],
    'Italy': [
        'Campania', 'Emilia-Romagna', 'Friuli Venezia Giulia',
        'Lazio', 'Liguria', 'Sardinia', 'Sicily', 'Tuscany', 'Veneto',
    ],
    'New Zealand': [
        'Auckland', 'Bay of Plenty', 'Canterbury', 'Gisborne',
        'Hawke\'s Bay', 'Manawatū-Whanganui', 'Marlborough',
        'Nelson', 'Northland', 'Otago', 'Southland',
        'Taranaki', 'Waikato', 'Wellington', 'West Coast',
    ],
    'Norway': [
        'Agder', 'Innlandet', 'Møre og Romsdal', 'Nordland',
        'Oslo', 'Rogaland', 'Troms og Finnmark',
        'Trøndelag', 'Vestfold og Telemark', 'Vestland', 'Viken',
    ],
    'Portugal': [
        'Algarve', 'Azores', 'Centro', 'Lisbon', 'Madeira', 'Norte',
    ],
    'South Africa': [
        'Eastern Cape', 'Gauteng', 'KwaZulu-Natal',
        'Northern Cape', 'Western Cape',
    ],
    'Spain': [
        'Andalusia', 'Balearic Islands', 'Basque Country',
        'Canary Islands', 'Catalonia', 'Galicia', 'Valencia',
    ],
    'Thailand': [
        'Chonburi', 'Krabi', 'Phang Nga', 'Phuket',
        'Surat Thani', 'Trat',
    ],
    'Turkey': [
        'Antalya', 'Bodrum (Muğla)', 'Çanakkale',
        'Istanbul', 'İzmir',
    ],
    'United Kingdom': [
        'England', 'Northern Ireland', 'Scotland', 'Wales',
    ],
    'United States': [
        'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California',
        'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
        'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
        'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
        'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri',
        'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
        'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
        'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
        'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
        'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
    ],
};

/**
 * Get states/provinces for a given country.
 * Returns empty array if no states are defined (smaller nations).
 */
export function getStatesForCountry(country: string): string[] {
    return STATES_BY_COUNTRY[country as CountryName] || [];
}
