/**
 * @filesize-justified Pure static data file (customs/immigration database). No logic to extract.
 */
// Extracted from CustomsClearanceCard.tsx for architecture cleanliness
/* ═══════════════════════════════════════════════════════════════
   COUNTRY CLEARANCE DATABASE
   ═══════════════════════════════════════════════════════════════ */

export interface ClearanceContact {
    name: string;
    phone?: string;
    email?: string;
    vhf?: string;
    website?: string;
    notes?: string;
}

export interface RequiredDocument {
    name: string;
    critical: boolean;
    notes?: string;
}

export interface CountryClearance {
    country: string;
    flag: string;
    departureProcedure: string[];
    arrivalProcedure: string[];
    contacts: ClearanceContact[];
    requiredDocuments: RequiredDocument[];
    yachtExport?: string; // Special rules for exporting your yacht
    importantNotes: string[];
    guideUrl?: string;
    guideLabel?: string;
    portsOfEntry: string[];
    fees?: string;
    difficulty: 'easy' | 'moderate' | 'complex';
}

export const COUNTRY_DB: Record<string, CountryClearance> = {
    australia: {
        country: 'Australia',
        flag: '🇦🇺',
        difficulty: 'complex',
        departureProcedure: [
            'Complete Customs Outward Manifest via Maritime Arrivals/Departures System (MADS)',
            'Submit online at least 96 hours before departure for international voyages',
            'Clear out with Australian Border Force (ABF) — book appointment',
            'Biosecurity clearance via Department of Agriculture',
            'If Australian-registered vessel: you must EXPORT your yacht through Customs',
            'Obtain Port Clearance from Harbour Master',
            'File voyage plan with AMSA (Australian Maritime Safety Authority)',
            'Cancel coastal radio schedule if you have one',
        ],
        arrivalProcedure: [
            'Report via Maritime Arrivals Reporting System (MARS) at least 96 hours before arrival',
            'Fly quarantine (Q) flag on arrival — yellow flag',
            'Do NOT go ashore until customs clearance is granted',
            'Call ABF on 1300 363 263 or report on VHF Ch 16',
            'Biosecurity inspection — declare ALL food, timber, and animal products',
            'Complete Incoming Passenger Card for each crew member',
            'All crew need valid visas unless Australian citizens',
            'Vessel will be inspected — have all documents accessible',
        ],
        contacts: [
            {
                name: 'Australian Border Force',
                phone: '1300 363 263',
                email: 'maritime@abf.gov.au',
                vhf: 'Ch 16',
                website: 'https://www.abf.gov.au/entering-and-leaving-australia/yachts-and-private-vessels',
            },
            { name: 'AMSA (Safety)', phone: '1800 641 792', vhf: 'Ch 16', website: 'https://www.amsa.gov.au' },
            {
                name: 'Dept of Agriculture (Biosecurity)',
                phone: '1800 900 090',
                email: 'imports@agriculture.gov.au',
                website: 'https://www.agriculture.gov.au/biosecurity/arriving',
            },
            {
                name: 'MADS (Departures)',
                website:
                    'https://www.abf.gov.au/entering-and-leaving-australia/crossing-the-border/maritime-arrivals-and-departures',
            },
        ],
        requiredDocuments: [
            { name: 'Vessel Registration Certificate', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Passports for all crew', critical: true },
            { name: 'Crew List (names, DOB, passport numbers)', critical: true },
            { name: 'Stores List (especially alcohol & tobacco)', critical: true },
            { name: 'Outward Customs Manifest', critical: true },
            { name: 'EPIRB Registration (406 MHz)', critical: true, notes: 'Must be registered with AMSA' },
            { name: 'Radio Operator Certificate', critical: false },
            { name: 'Safety Equipment Compliance', critical: false, notes: 'Life raft, flares, EPIRB, etc.' },
            {
                name: 'Yacht Export Declaration (if AU-registered)',
                critical: true,
                notes: 'Required to re-import duty-free',
            },
        ],
        yachtExport:
            "Australian-registered vessels MUST be exported through Customs before departing internationally. This involves:\n\n1. Complete an Export Declaration via the MADS system\n2. Apply for a Temporary Export permit (to re-import duty-free on return)\n3. ABF will issue an Export Clearance Number\n4. Without this, you may face import duties when you return (potentially 5% + 10% GST on the vessel's value)\n\nThis process is notoriously confusing. We strongly recommend following a detailed walkthrough.",
        importantNotes: [
            '⚠️ Biosecurity is EXTREMELY strict — any undeclared food items = heavy fines',
            '⚠️ Yacht export is essential for Australian-registered vessels to avoid massive import duties on return',
            '48-72 hour quarantine may apply if arriving from certain countries',
            'Some ports require pilot or VTS contact on approach — check port-specific requirements',
            'Firearms must be declared and may be held by authorities',
        ],
        guideUrl: 'https://www.serene-summer.com',
        guideLabel: 'Serene Summer — Complete Australian departure guide',
        portsOfEntry: [
            'Cairns',
            'Townsville',
            'Bundaberg',
            'Brisbane',
            'Gold Coast (Southport)',
            'Sydney',
            'Coffs Harbour',
            'Newcastle',
            'Darwin',
            'Thursday Island',
        ],
        fees: 'No standard clearance fee, but biosecurity inspection fees may apply ($200-$400+)',
    },
    'new zealand': {
        country: 'New Zealand',
        flag: '🇳🇿',
        difficulty: 'moderate',
        departureProcedure: [
            'Complete Customs Departure form (NZCS 5)',
            'Notify NZ Customs at least 24 hours before departure',
            'Submit via online JBMS (Joint Border Management System)',
            'Obtain Port Clearance',
        ],
        arrivalProcedure: [
            'Notify NZ Customs of arrival 48 hours ahead via CRAFT system',
            'Fly Q flag until cleared',
            'Do NOT go ashore — remain on vessel',
            'Call Customs on 0800 428 786 or VHF Ch 16',
            'Biosecurity (MPI) inspection is strict — no fresh fruit, meat, or plants',
            'All crew need valid visas or NZ passport',
        ],
        contacts: [
            {
                name: 'NZ Customs Service',
                phone: '0800 428 786',
                email: 'customs@customs.govt.nz',
                vhf: 'Ch 16',
                website: 'https://www.customs.govt.nz/personal/travel-to-and-from-nz/travelling-by-private-boat/',
            },
            { name: 'MPI Biosecurity', phone: '0800 008 333', website: 'https://www.mpi.govt.nz/bring-send-to-nz/' },
            { name: 'Coastguard NZ', phone: '*500 (mobile)', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Vessel Registration', critical: true },
            { name: 'Passports for all crew', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Stores List', critical: true },
            { name: 'CRAFT notification', critical: true, notes: 'Submit 48hrs before arrival' },
            { name: 'Insurance Certificate', critical: false },
        ],
        importantNotes: [
            'Opua (Bay of Islands) is the most popular yacht port of entry',
            'Biosecurity is very strict — no honey, fresh produce, or untreated timber',
            'Vessel may require anti-foul inspection (clean hull)',
            'Cyclone season: Nov–Apr — check insurance requirements',
        ],
        portsOfEntry: ['Opua', 'Whangarei', 'Auckland', 'Tauranga', 'Napier', 'Wellington', 'Nelson', 'Lyttelton'],
        fees: 'Biosecurity levy ~NZ$380 per vessel + MPI charges',
    },
    indonesia: {
        country: 'Indonesia',
        flag: '🇮🇩',
        difficulty: 'complex',
        departureProcedure: [
            'Clear out at your last port of call with Immigration, Customs, Harbour Master, and Quarantine',
            'Obtain Port Clearance (Surat Izin Berlayar / SIB)',
            'Return CAIT (Clearance Approval for Indonesian Territory) permit',
        ],
        arrivalProcedure: [
            'Apply for CAIT through an Indonesian agent before arrival',
            'Fly Q flag and request pratique on VHF Ch 16',
            'Clear in with: Immigration, Customs, Harbour Master, Quarantine (CIQP)',
            'Crew visas — check if Visa on Arrival (VOA) is available for your nationality',
            'Cruising permit (CAIT) specifies your approved route — stick to it',
        ],
        contacts: [
            { name: 'Indonesian Customs (DJBC)', phone: '+62 21 4890 0813', website: 'https://www.beacukai.go.id' },
            { name: 'Immigration', phone: '+62 21 2500 900' },
            { name: 'CAIT Applications', email: 'cait@hubla.dephub.go.id', notes: 'Apply 2-3 months ahead' },
        ],
        requiredDocuments: [
            { name: 'CAIT Permit', critical: true, notes: 'Apply 2-3 months before arrival' },
            { name: 'Passports (6+ months validity)', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Radio Licence', critical: false },
        ],
        importantNotes: [
            '⚠️ CAIT permit is ESSENTIAL — do not arrive without one',
            'Agent strongly recommended for clearing in/out (saves days of bureaucracy)',
            'Keep multiple copies of all documents',
            'Cruising between islands may require additional Surat Jalan',
            'Check current VOA countries — not all passports qualify',
        ],
        portsOfEntry: ['Sabang', 'Batam', 'Jakarta (Tanjung Priok)', 'Bali (Benoa)', 'Kupang', 'Jayapura', 'Manado'],
        fees: 'CAIT ~US$100-200 + port fees + agent fees (~US$100-300)',
    },
    fiji: {
        country: 'Fiji',
        flag: '🇫🇯',
        difficulty: 'easy',
        departureProcedure: [
            'Clear out with Customs & Immigration at nearest port of entry',
            'Submit Departure Declaration',
            'Obtain Port Clearance',
            'Duty-free stores can be sealed on board',
        ],
        arrivalProcedure: [
            'Fly Q flag and go directly to a Port of Entry',
            'Call Fiji Customs on VHF Ch 16',
            'Clear with Customs, Immigration, Health, and Biosecurity',
            'Most nationalities get 4-month visitor permit on arrival',
            'Yacht will receive Cruising Permit',
        ],
        contacts: [
            { name: 'Fiji Customs', phone: '+679 324 3000', vhf: 'Ch 16', email: 'info@frcs.org.fj' },
            { name: 'Fiji Immigration', phone: '+679 331 2622' },
            { name: 'Port Authority Suva', phone: '+679 331 2700', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Insurance Certificate', critical: false },
        ],
        importantNotes: [
            'Suva is the main port of entry — most facilities available',
            'Cyclone season Nov-Apr — consider timing carefully',
            'Reefs are extensive — approach in good light',
        ],
        portsOfEntry: ['Suva', 'Lautoka', 'Levuka', 'Savusavu'],
        fees: 'Minimal port fees (~FJ$50-100)',
    },
    'papua new guinea': {
        country: 'Papua New Guinea',
        flag: '🇵🇬',
        difficulty: 'complex',
        departureProcedure: [
            'Clear out with Customs, Immigration, and Harbour Master',
            'Obtain Port Clearance',
            'Return cruising permit if issued',
        ],
        arrivalProcedure: [
            'Contact Port Moresby Radio on VHF Ch 16 before arrival',
            'Fly Q flag and proceed to a Port of Entry',
            'Clear with Customs, Immigration, Health, and National Maritime Safety Authority',
            'All crew require visas — arrange before arrival if possible',
        ],
        contacts: [
            { name: 'PNG Customs', phone: '+675 322 6600' },
            { name: 'PNG Immigration', phone: '+675 323 1916' },
            { name: 'National Maritime Safety Authority', phone: '+675 320 0211', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports with visas', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Insurance Certificate', critical: true },
        ],
        importantNotes: [
            '⚠️ Check security situation before visiting — some areas are restricted',
            'Agent recommended for clearing in major ports',
            'Limited facilities outside Port Moresby and Lae',
            'Navigation charts may be outdated — use caution',
        ],
        portsOfEntry: ['Port Moresby', 'Lae', 'Madang', 'Rabaul', 'Kavieng', 'Alotau'],
        fees: 'Visa fees vary by nationality + port charges',
    },
    'united states': {
        country: 'United States',
        flag: '🇺🇸',
        difficulty: 'moderate',
        departureProcedure: [
            'File Float Plan with Coast Guard (recommended)',
            'Complete CBP ROAM app notification',
            'No formal export clearance required for US vessels on temporary voyages',
        ],
        arrivalProcedure: [
            'Report arrival immediately to CBP (Customs and Border Protection)',
            'Use CBP ROAM app or call local CBP port',
            'Captain goes ashore to clear — crew remains on board',
            'Present passports and vessel documentation',
            'ESTA or valid visa required for non-US citizens',
        ],
        contacts: [
            { name: 'CBP', phone: '1-877-227-5511', website: 'https://www.cbp.gov/travel/pleasure-boats-background' },
            { name: 'US Coast Guard', phone: '1-800-221-8724', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'US Customs User Fee Decal', critical: true, notes: 'US$27.50/year' },
            { name: 'Passports or ESTA', critical: true },
            { name: 'Vessel Documentation', critical: true },
            { name: 'Crew List', critical: true },
        ],
        importantNotes: [
            'CBP ROAM app streamlines the process significantly',
            'Penalties for not reporting arrival are severe',
        ],
        portsOfEntry: ['San Diego', 'Los Angeles', 'San Francisco', 'Honolulu', 'Miami', 'Key West', 'New York'],
        fees: 'User Fee Decal US$27.50/year + CBP overtime charges may apply',
    },

    // ═══════════════════════════════════════════════════════════════
    // PACIFIC ISLANDS
    // ═══════════════════════════════════════════════════════════════

    vanuatu: {
        country: 'Vanuatu',
        flag: '🇻🇺',
        difficulty: 'easy',
        departureProcedure: [
            'Clear out with Customs, Immigration, and Harbour Master at Port Vila or Luganville',
            'Submit departure declaration and crew list',
            'Obtain Port Clearance',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed directly to a Port of Entry',
            'Contact Port Vila Radio on VHF Ch 16',
            'Clear with Customs, Immigration, Health, and Biosecurity',
            'Most nationalities receive 30-day visa on arrival (extendable)',
            'Cruising permit issued on clearance',
        ],
        contacts: [
            { name: 'Vanuatu Customs', phone: '+678 22425', vhf: 'Ch 16' },
            { name: 'Immigration Dept', phone: '+678 22354' },
            { name: 'Port Vila Harbour Master', phone: '+678 22358', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Insurance Certificate', critical: false },
        ],
        importantNotes: [
            'Very yacht-friendly country — clearance is generally quick',
            'Kava is the national drink — try it!',
            'Cyclone season Nov–Apr',
            'Respect kastom (custom) in outer islands — ask before anchoring near villages',
        ],
        portsOfEntry: ['Port Vila', 'Luganville (Santo)'],
        fees: 'Minimal — port fees ~5,000 VUV (~AU$60)',
    },

    'new caledonia': {
        country: 'New Caledonia',
        flag: '🇳🇨',
        difficulty: 'moderate',
        departureProcedure: [
            'Clear out with French Customs (Douanes) and Police aux Frontières (PAF)',
            'Submit departure manifest',
            'Obtain Port Clearance from Harbour Master (Capitainerie)',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to Port Moselle marina (Nouméa)',
            'Contact VTS Nouméa on VHF Ch 12 for approach',
            'Clear with Douanes (French Customs), PAF (Immigration), and Biosecurity',
            'French territory — EU/Schengen rules do NOT apply here',
            '90-day visa-free stay for most Western nationalities',
        ],
        contacts: [
            { name: 'Douanes (Customs)', phone: '+687 27 21 23' },
            { name: 'Police aux Frontières (PAF)', phone: '+687 26 24 33' },
            { name: 'Port Moselle Marina', phone: '+687 27 55 48', vhf: 'Ch 9' },
            { name: 'Capitainerie (Harbour)', phone: '+687 27 71 97', vhf: 'Ch 12' },
        ],
        requiredDocuments: [
            { name: 'Passports (valid 6+ months)', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Insurance Certificate', critical: true, notes: 'Third-party liability required' },
            { name: 'French territory visa (if applicable)', critical: true, notes: 'Not same as Schengen' },
        ],
        importantNotes: [
            '⚠️ French overseas territory — visa requirements differ from mainland France',
            'Stunning lagoon (UNESCO World Heritage) — anchoring restrictions apply',
            'Biosecurity strict on fresh produce and animal products',
            'French language dominant — some English at marina office',
        ],
        portsOfEntry: ['Nouméa (Port Moselle)', 'Lifou', 'Wé (Maré)'],
        fees: 'Port fees ~2,000-5,000 CFP/night + customs charges',
    },

    'cook islands': {
        country: 'Cook Islands',
        flag: '🇨🇰',
        difficulty: 'easy',
        departureProcedure: [
            'Clear out with Customs, Immigration, and Ministry of Transport in Avarua',
            'Obtain Port Clearance',
            'Return cruising permit if you visited outer islands',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to Avatiu Harbour (Rarotonga)',
            'Contact Rarotonga Radio on VHF Ch 16',
            'Clear with Customs, Immigration, and Health',
            'NZ citizens enter freely; most others get 31-day permit on arrival',
            'Cruising permit required for outer islands',
        ],
        contacts: [
            { name: 'Cook Islands Customs', phone: '+682 29340' },
            { name: 'Immigration', phone: '+682 29347' },
            { name: 'Harbour Master', phone: '+682 21921', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Onward ticket or proof of onward travel', critical: false },
        ],
        importantNotes: [
            'Avatiu Harbour is small — contact ahead during busy season (Jun–Oct)',
            'Very welcoming to cruisers',
            'Limited repair facilities',
            'NZ dollar is used',
        ],
        portsOfEntry: ['Avatiu (Rarotonga)', 'Penrhyn', 'Aitutaki'],
        fees: 'Minimal port fees; cruising permit for outer islands ~NZ$100',
    },

    'french polynesia': {
        country: 'French Polynesia',
        flag: '🇵🇫',
        difficulty: 'moderate',
        departureProcedure: [
            'Clear out with Douanes (Customs) and Gendarmerie Maritime',
            'Return Duty-Free bond (if applicable)',
            'Obtain Port Clearance',
        ],
        arrivalProcedure: [
            'Fly Q flag and clear in at Papeete (Tahiti) — mandatory first port',
            'Contact Papeete Port on VHF Ch 12',
            'Clear with Douanes, Police aux Frontières, and Biosecurity',
            'Duty-free bond required (reimbursement guarantee on the vessel)',
            '90-day visa-free for most nationalities',
            'Long-stay bond may be required (~US$1,500/person — refundable)',
        ],
        contacts: [
            { name: 'Douanes Papeete', phone: '+689 40 54 45 00' },
            { name: 'Police aux Frontières', phone: '+689 40 80 06 09' },
            { name: 'Port Autonome de Papeete', phone: '+689 40 47 64 00', vhf: 'Ch 12' },
            { name: 'Gendarmerie Maritime', phone: '+689 40 46 73 73', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports (6+ months validity)', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Repatriation bond or return ticket', critical: true, notes: 'Refundable bond ~US$1,500/person' },
            { name: 'Duty-free guarantee', critical: true, notes: 'Bond or bank guarantee for vessel' },
        ],
        importantNotes: [
            '⚠️ Repatriation bond is controversial but enforced — budget for it',
            '⚠️ Must clear in at Papeete FIRST, even if arriving at Marquesas',
            'Moorea is close to Papeete and a great first stop after clearing',
            'Anchoring restrictions in some lagoons — check local regulations',
            'French language — limited English outside Papeete',
        ],
        portsOfEntry: ['Papeete (Tahiti)', 'Nuku Hiva (Marquesas)', 'Rikitea (Gambier)', 'Raiatea'],
        fees: 'Port fees variable + repatriation bond + duty bond. Budget ~US$500-2,000 total',
    },

    // ═══════════════════════════════════════════════════════════════
    // EUROPE — MEDITERRANEAN
    // ═══════════════════════════════════════════════════════════════

    france: {
        country: 'France',
        flag: '🇫🇷',
        difficulty: 'moderate',
        departureProcedure: [
            'No formal departure clearance required for EU/Schengen zone travel',
            'For non-EU vessels: clear with Douanes and obtain Port Clearance',
            'File a float plan with local Affaires Maritimes (recommended)',
        ],
        arrivalProcedure: [
            'EU/EEA vessels: no customs formalities within Schengen zone',
            'Non-EU vessels: fly Q flag and clear with Douanes at first port',
            'Clear with Police aux Frontières (PAF) if arriving from outside Schengen',
            'VAT status of vessel may be checked — have proof of EU tax-paid status',
            'Non-EU visitors: 90 days within any 180-day period (Schengen rule)',
        ],
        contacts: [
            { name: 'Douanes (French Customs)', phone: '0 800 94 40 40', website: 'https://www.douane.gouv.fr' },
            {
                name: 'Affaires Maritimes',
                phone: '+33 1 40 81 72 45',
                website: 'https://www.ecologie.gouv.fr/direction-des-affaires-maritimes',
            },
            { name: 'CROSS (Maritime Rescue)', phone: '196', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID cards', critical: true },
            { name: 'Vessel Registration', critical: true },
            {
                name: 'Proof of VAT-paid status',
                critical: true,
                notes: 'Or Temporary Admission (TA) for non-EU vessels',
            },
            { name: 'Insurance Certificate', critical: true, notes: 'Third-party liability required' },
            { name: 'Radio Licence (SRC or higher)', critical: false },
            {
                name: 'ICC (International Certificate of Competence)',
                critical: false,
                notes: 'Not legally required but recommended',
            },
        ],
        importantNotes: [
            'Mediterranean France can be expensive for berthing — budget carefully',
            'Non-EU vessels get 18 months Temporary Admission (TA) — VAT-free',
            "Anchoring restrictions common along Côte d'Azur",
            '⚠️ Schengen 90/180-day rule strictly enforced for non-EU crew',
        ],
        portsOfEntry: ['Marseille', 'Toulon', 'Nice', 'Cannes', 'La Rochelle', 'Brest', 'Cherbourg', 'Antibes'],
        fees: 'Port/marina fees vary hugely €20-€200+/night depending on location and season',
    },

    'united kingdom': {
        country: 'United Kingdom',
        flag: '🇬🇧',
        difficulty: 'moderate',
        departureProcedure: [
            'Submit C1331 departure form to HMRC (HM Revenue & Customs)',
            'Can be done online via National Yachtline',
            'No physical inspection usually required for departure',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to nearest port',
            'Submit C1331 arrival form to HMRC within 24 hours',
            'Call National Yachtline on 0300 123 2012 (or online)',
            'Non-UK/EU nationals may need visa clearance',
            'Post-Brexit: EU citizens need passport (ID card no longer accepted)',
        ],
        contacts: [
            {
                name: 'HMRC National Yachtline',
                phone: '0300 123 2012',
                website: 'https://www.gov.uk/government/organisations/hm-revenue-customs',
            },
            { name: 'Border Force', phone: '0300 123 7015' },
            {
                name: 'HM Coastguard',
                phone: '999 / 112',
                vhf: 'Ch 16',
                website: 'https://www.gov.uk/government/organisations/maritime-and-coastguard-agency',
            },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration (Part 1 or SSR)', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'C1331 form (arrival/departure)', critical: true },
            { name: 'Stores declaration (alcohol & tobacco)', critical: false },
            { name: 'ICC / RYA certificate', critical: false, notes: 'Not legally required for UK waters' },
        ],
        importantNotes: [
            '⚠️ Post-Brexit: UK is NOT in Schengen — separate entry rules apply',
            'Non-EU vessels entering UK for first time may face VAT assessment',
            'Tidal waters are extremely variable — check tide tables carefully',
            'VHF Ch 16 monitored continuously by Coastguard',
        ],
        portsOfEntry: [
            'Southampton',
            'Portsmouth',
            'Plymouth',
            'Falmouth',
            'Dover',
            'London (St Katharine Docks)',
            'Edinburgh (Granton)',
        ],
        fees: 'No clearance fees; marina fees vary £15-£80+/night',
    },

    // Alias for "England"
    england: {
        country: 'United Kingdom',
        flag: '🇬🇧',
        difficulty: 'moderate',
        departureProcedure: [
            'Submit C1331 departure form to HMRC (HM Revenue & Customs)',
            'Can be done online via National Yachtline',
            'No physical inspection usually required for departure',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to nearest port',
            'Submit C1331 arrival form to HMRC within 24 hours',
            'Call National Yachtline on 0300 123 2012 (or online)',
            'Non-UK/EU nationals may need visa clearance',
            'Post-Brexit: EU citizens need passport (ID card no longer accepted)',
        ],
        contacts: [
            { name: 'HMRC National Yachtline', phone: '0300 123 2012' },
            { name: 'Border Force', phone: '0300 123 7015' },
            { name: 'HM Coastguard', phone: '999 / 112', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'C1331 form', critical: true },
        ],
        importantNotes: [
            '⚠️ Post-Brexit: UK is NOT in Schengen',
            'Tidal waters are extremely variable — check tide tables',
        ],
        portsOfEntry: ['Southampton', 'Portsmouth', 'Plymouth', 'Falmouth', 'Dover'],
        fees: 'No clearance fees; marina fees vary £15-£80+/night',
    },

    türkiye: {
        country: 'Türkiye',
        flag: '🇹🇷',
        difficulty: 'moderate',
        departureProcedure: [
            'Clear out at a Turkish marina or port with Customs, Immigration, and Harbour Master',
            'Return Transit Log (if issued)',
            'Obtain Port Clearance',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to a designated port of entry',
            'Clear with Customs, Coast Guard (Sahil Güvenlik), Immigration, and Health',
            'Vessel receives a Transit Log — valid for the length of your stay',
            'Most nationalities can get e-visa before arrival',
            'Foreign-flagged vessels can stay up to 5 years (with annual renewal)',
        ],
        contacts: [
            { name: 'Turkish Customs', phone: '+90 312 306 80 00', website: 'https://www.ticaret.gov.tr' },
            { name: 'Sahil Güvenlik (Coast Guard)', phone: '158', vhf: 'Ch 16' },
            { name: 'Immigration', phone: '+90 312 422 7100' },
        ],
        requiredDocuments: [
            { name: 'Passports (6+ months validity)', critical: true },
            { name: 'e-Visa (if applicable)', critical: true, notes: 'www.evisa.gov.tr' },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Transit Log', critical: true, notes: 'Issued on arrival' },
        ],
        importantNotes: [
            'Transit Log is essential — carry it at all times on board',
            'Marinas are generally well-equipped and good value',
            'Winter haul-out in Türkiye is popular and affordable',
            'Check current security advisories for eastern Mediterranean',
            'Excellent boatyards for maintenance in Marmaris, Bodrum, Antalya',
        ],
        portsOfEntry: ['Marmaris', 'Bodrum', 'Fethiye', 'Antalya', 'İzmir (Çeşme)', 'Kuşadası', 'Kaş', 'Finike'],
        fees: 'Transit Log ~€30-50 + port/marina fees vary',
    },

    // Alias for "Turkey"
    turkey: {
        country: 'Türkiye',
        flag: '🇹🇷',
        difficulty: 'moderate',
        departureProcedure: [
            'Clear out at marina with Customs, Immigration, Harbour Master',
            'Return Transit Log',
            'Obtain Port Clearance',
        ],
        arrivalProcedure: [
            'Fly Q flag to port of entry',
            'Clear with Customs, Coast Guard, Immigration, Health',
            'Transit Log issued on arrival',
            'e-Visa recommended',
        ],
        contacts: [{ name: 'Sahil Güvenlik (Coast Guard)', phone: '158', vhf: 'Ch 16' }],
        requiredDocuments: [
            { name: 'Passports + e-Visa', critical: true },
            { name: 'Vessel Registration', critical: true },
        ],
        importantNotes: ['Transit Log must be carried on board at all times'],
        portsOfEntry: ['Marmaris', 'Bodrum', 'Fethiye', 'Antalya', 'İzmir'],
        fees: 'Transit Log ~€30-50',
    },

    greece: {
        country: 'Greece',
        flag: '🇬🇷',
        difficulty: 'moderate',
        departureProcedure: [
            'Clear out with Port Police (Limenarchion) at your last Greek port',
            'Obtain Dekpa (transit log) exit stamp',
            'Return cruising tax receipt if applicable',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to a Port of Entry',
            'Clear with Port Police (Limenarchion), Customs, and Immigration',
            'Non-EU vessels receive a Transit Log (DEKPA) — stamped at each port',
            'Cruising tax (TEPAI) payable based on vessel length',
            'EU vessels: no customs formalities within Schengen',
        ],
        contacts: [
            { name: 'Hellenic Coast Guard', phone: '108', vhf: 'Ch 16' },
            { name: 'Port Police (general)', phone: '+30 210 419 2000' },
            { name: 'Customs Authority', phone: '+30 210 691 6000', website: 'https://www.aade.gr' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Insurance Certificate', critical: true, notes: 'Third-party liability mandatory' },
            { name: 'DEKPA Transit Log (non-EU)', critical: true, notes: 'Stamped at each port' },
            { name: 'TEPAI receipt (cruising tax)', critical: true, notes: 'Based on LOA' },
            { name: 'Radio Licence', critical: false },
            { name: 'ICC or equivalent', critical: false },
        ],
        importantNotes: [
            '⚠️ TEPAI cruising tax introduced 2023 — based on vessel length, payable monthly',
            'DEKPA must be presented at each port — Port Police stamp it',
            'Anchoring restrictions in some islands during peak season',
            '⚠️ Turkish-Greek border zones — stay on your side',
            'Meltemi winds (Jun–Sep) in the Aegean can be very strong',
        ],
        portsOfEntry: [
            'Piraeus (Athens)',
            'Rhodes',
            'Corfu (Kerkyra)',
            'Kos',
            'Heraklion (Crete)',
            'Thessaloniki',
            'Zakynthos',
            'Syros',
        ],
        fees: 'TEPAI: €10-20/m LOA/month + port fees vary',
    },

    italy: {
        country: 'Italy',
        flag: '🇮🇹',
        difficulty: 'moderate',
        departureProcedure: [
            'No formal departure clearance for EU/Schengen travel',
            'Non-EU vessels: notify Guardia Costiera and Customs (Guardia di Finanza)',
            'Obtain Port Clearance from harbour office',
        ],
        arrivalProcedure: [
            'EU vessels — minimal formalities within Schengen',
            'Non-EU vessels: fly Q flag, clear with Guardia di Finanza (Customs) and Guardia Costiera',
            'Register with local Police (Questura) for non-EU crew',
            'Cruising tax (Tassa Stazionamento) was suspended — check current status',
            'Schengen 90/180-day rule for non-EU visitors',
        ],
        contacts: [
            {
                name: 'Guardia Costiera (Coast Guard)',
                phone: '1530',
                vhf: 'Ch 16',
                website: 'https://www.guardiacostiera.gov.it',
            },
            { name: 'Guardia di Finanza (Customs)', phone: '117' },
            { name: 'Capitaneria di Porto (Harbour)', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Radio Licence', critical: false },
            { name: 'ICC or Italian equivalent', critical: false, notes: 'May be requested for charter boats' },
        ],
        importantNotes: [
            'Italy has many Marine Protected Areas (AMP) — anchoring restricted',
            'VHF Ch 16 monitored by Guardia Costiera continuously',
            'Marina fees in peak summer (Sardinia, Amalfi) can be extremely expensive',
            'Sicilian Strait — heavy shipping traffic, stay alert',
        ],
        portsOfEntry: [
            'Genoa',
            'Naples',
            'Palermo',
            'Cagliari (Sardinia)',
            'Venice',
            'Brindisi',
            'Catania',
            'Olbia',
            'Civitavecchia (Rome)',
        ],
        fees: 'Marina fees €30-€300+/night depending on location and season',
    },

    spain: {
        country: 'Spain',
        flag: '🇪🇸',
        difficulty: 'moderate',
        departureProcedure: [
            'No formal departure clearance for Schengen/EU travel',
            'Non-EU vessels: clear with Guardia Civil and Aduanas (Customs)',
            'File departure with harbour office (Capitanía Marítima)',
        ],
        arrivalProcedure: [
            'EU/Schengen vessels — minimal formalities',
            'Non-EU vessels: fly Q flag, clear with Guardia Civil (Immigration) and Aduanas',
            'Vessel may receive Temporary Import document (non-EU flagged)',
            'Register at local Marina or Capitanía',
        ],
        contacts: [
            {
                name: 'Salvamento Marítimo (Maritime Rescue)',
                phone: '900 202 202',
                vhf: 'Ch 16',
                website: 'https://www.salvamentomaritimo.es',
            },
            { name: 'Guardia Civil (Immigration)', phone: '062' },
            { name: 'Aduanas (Customs)', phone: '+34 91 728 93 00' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Radio Licence', critical: false },
            { name: 'Titulín or ICC', critical: false, notes: 'Spanish skipper licence or ICC for Spanish waters' },
        ],
        importantNotes: [
            'Balearics (Mallorca, Ibiza) — anchoring restrictions in Posidonia seagrass zones',
            'Gibraltar Strait — heavy shipping, strong currents',
            'Non-EU vessels: 18 months Temporary Admission',
            'Marina Seca (dry dock) popular for winter storage',
        ],
        portsOfEntry: [
            'Barcelona',
            'Palma de Mallorca',
            'Valencia',
            'Alicante',
            'Gibraltar (UK)',
            'Málaga',
            'Las Palmas (Canaries)',
            'Ibiza',
        ],
        fees: 'Marina fees vary €15-€150+/night',
    },

    croatia: {
        country: 'Croatia',
        flag: '🇭🇷',
        difficulty: 'moderate',
        departureProcedure: [
            'Clear out at nearest Harbour Master office (Lučka kapetanija)',
            'Return Vignette receipt if applicable',
            'Obtain departure stamp on crew list',
        ],
        arrivalProcedure: [
            'Proceed to a Port of Entry and clear with Harbour Master',
            'Pay cruising permit (Vignette) — based on vessel length',
            'Non-EU crew: border police check (Croatia is now Schengen)',
            'Sojourn tax per person per night',
            'Register crew list at each new port',
        ],
        contacts: [
            {
                name: 'Harbour Master (general)',
                phone: '+385 21 329 200',
                vhf: 'Ch 10',
                website: 'https://luka-ploce.hr',
            },
            { name: 'MRCC Rijeka', phone: '+385 51 195', vhf: 'Ch 16' },
            { name: 'Border Police', phone: '192' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Vignette (cruising permit)', critical: true, notes: 'Purchased at Harbour Master' },
            { name: 'ICC or equivalent', critical: true, notes: 'Required for skipper in Croatian waters' },
            { name: 'VHF Radio Licence', critical: true },
        ],
        importantNotes: [
            '⚠️ ICC (International Certificate of Competence) is MANDATORY for the skipper',
            '⚠️ VHF radio licence required — checked by authorities',
            'Croatia joined Schengen in 2023 — easier for EU citizens now',
            'Kornati islands — national park fees apply',
            'Bura wind can be sudden and violent — watch forecasts',
        ],
        portsOfEntry: ['Split', 'Dubrovnik', 'Zadar', 'Rijeka', 'Pula', 'Šibenik', 'Korčula'],
        fees: 'Vignette €10-50/m LOA (annual or period) + sojourn tax ~€1/person/night',
    },

    montenegro: {
        country: 'Montenegro',
        flag: '🇲🇪',
        difficulty: 'easy',
        departureProcedure: ['Clear out with Harbour Master and Border Police', 'Obtain Port Clearance'],
        arrivalProcedure: [
            'Fly Q flag and proceed to Kotor, Bar, or Budva',
            'Clear with Harbour Master, Customs, and Border Police',
            'Cruising permit issued on clearance',
            'Most nationalities visa-free for 90 days',
        ],
        contacts: [
            { name: 'Harbour Master Bar', phone: '+382 30 312 366', vhf: 'Ch 16' },
            { name: 'Border Police', phone: '+382 20 241 424' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Crew List', critical: true },
        ],
        importantNotes: [
            'Bay of Kotor (Boka Kotorska) is stunning — UNESCO World Heritage',
            'Not EU/Schengen — separate entry requirements',
            'Marina facilities improving but limited compared to Croatia',
        ],
        portsOfEntry: ['Kotor', 'Bar', 'Budva', 'Tivat'],
        fees: 'Low — port fees ~€10-20/night for most vessels',
    },

    malta: {
        country: 'Malta',
        flag: '🇲🇹',
        difficulty: 'easy',
        departureProcedure: ['Clear out with Malta Transport (Harbour Master)', 'Customs clearance for non-EU vessels'],
        arrivalProcedure: [
            'Contact Valletta VTS on VHF Ch 12 for approach',
            'Fly Q flag and proceed to Grand Harbour Marina or Msida',
            'Clear with Malta Transport and Immigration (non-EU)',
            'EU vessels — minimal formalities',
        ],
        contacts: [
            { name: 'Valletta VTS', vhf: 'Ch 12' },
            { name: 'Malta Transport', phone: '+356 2122 2203', website: 'https://www.transport.gov.mt' },
            { name: 'Armed Forces of Malta (Search & Rescue)', phone: '+356 2124 4371', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Insurance Certificate', critical: true },
        ],
        importantNotes: [
            'English is an official language — clearance straightforward',
            'Grand Harbour Marina is well-equipped and central',
            'Popular winter berthing destination — good value',
        ],
        portsOfEntry: ['Valletta (Grand Harbour)', 'Msida Marina', 'Gozo (Mġarr)'],
        fees: 'Light dues ~€15 + marina fees vary',
    },

    cyprus: {
        country: 'Cyprus',
        flag: '🇨🇾',
        difficulty: 'moderate',
        departureProcedure: ['Clear out with Customs, Immigration, and Port Authority', 'Obtain Port Clearance'],
        arrivalProcedure: [
            'Fly Q flag and proceed to an approved port of entry',
            'Clear with Customs, Immigration, Port Authority, and Health',
            'Non-EU vessels: Temporary Import permit issued',
            '⚠️ Do NOT enter Northern Cyprus ports if you plan to visit Southern Cyprus (and vice versa)',
        ],
        contacts: [
            { name: 'JRCC Larnaca', phone: '+357 24 304 710', vhf: 'Ch 16' },
            { name: 'Customs Department', phone: '+357 22 601 751', website: 'https://www.mof.gov.cy/mof/customs' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Insurance Certificate', critical: true },
            { name: 'Crew List', critical: true },
        ],
        importantNotes: [
            '⚠️ Divided island — do NOT cross between North and South by yacht',
            'Popular wintering destination with good boatyards',
            'Larnaca Marina is the main yacht facility',
        ],
        portsOfEntry: ['Larnaca', 'Limassol', 'Paphos'],
        fees: 'Port fees ~€15-30/night + light dues',
    },

    portugal: {
        country: 'Portugal',
        flag: '🇵🇹',
        difficulty: 'easy',
        departureProcedure: [
            'No formal departure clearance within EU/Schengen',
            'Non-EU vessels: inform Capitania (Harbour Master)',
        ],
        arrivalProcedure: [
            'EU vessels — no formalities within Schengen',
            'Non-EU vessels: fly Q flag, clear with SEF (Immigration) and Alfândega (Customs)',
            'Friendly and straightforward clearance process',
        ],
        contacts: [
            { name: 'MRCC Lisboa', phone: '+351 21 440 19 19', vhf: 'Ch 16' },
            { name: 'Alfândega (Customs)', phone: '+351 21 881 3800' },
            { name: 'SEF (Immigration)', phone: '+351 808 202 653' },
        ],
        requiredDocuments: [
            { name: 'Passports or EU ID', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Insurance Certificate', critical: true },
        ],
        importantNotes: [
            'Lagos, Cascais, and Lisbon are popular stops for Atlantic crossings',
            'Azores and Madeira are autonomous regions with own port facilities',
            'Atlantic swell can make harbour entry difficult — check conditions',
        ],
        portsOfEntry: ['Lisbon', 'Lagos', 'Cascais', 'Porto (Leixões)', 'Horta (Azores)', 'Funchal (Madeira)'],
        fees: 'Marina fees vary €15-€80/night; Azores are good value',
    },

    // ═══════════════════════════════════════════════════════════════
    // CARIBBEAN
    // ═══════════════════════════════════════════════════════════════

    'british virgin islands': {
        country: 'British Virgin Islands',
        flag: '🇻🇬',
        difficulty: 'easy',
        departureProcedure: [
            'Clear out online via SailClear or at Customs office',
            'Submit departure manifest and crew list',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to a Port of Entry',
            'Clear using SailClear online system (recommended) or in person',
            'Customs and Immigration at Road Town, Jost Van Dyke, or other POE',
            'Cruising permit issued on clearance',
        ],
        contacts: [
            { name: 'BVI Customs', phone: '+1 284 468 3701', website: 'https://www.bvicustoms.vg' },
            { name: 'Immigration', phone: '+1 284 468 3471' },
            { name: 'SailClear (online clearance)', website: 'https://www.sailclear.com' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
        ],
        importantNotes: [
            'SailClear makes the process very easy — register before arrival',
            'Marine parks require mooring buoys — no anchoring',
            'National park fees apply for popular bays',
        ],
        portsOfEntry: ['Road Town (Tortola)', 'Jost Van Dyke', 'Virgin Gorda', 'Anegada'],
        fees: 'Cruising permit ~US$4/person/night; national park fees extra',
    },

    'antigua and barbuda': {
        country: 'Antigua and Barbuda',
        flag: '🇦🇬',
        difficulty: 'easy',
        departureProcedure: [
            "Clear out with Customs and Immigration at English Harbour or St John's",
            'Submit departure manifest',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to English Harbour or Jolly Harbour',
            'Clear with Customs and Immigration',
            'Cruising permit issued',
            'Most nationalities visa-free',
        ],
        contacts: [
            { name: 'Customs (English Harbour)', phone: '+1 268 460 1379' },
            { name: 'Immigration', phone: '+1 268 462 0579' },
            { name: 'Coast Guard', phone: '+1 268 462 0671', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
        ],
        importantNotes: [
            "English Harbour (Nelson's Dockyard) is a major yachting hub",
            'Antigua Sailing Week (late April) is world-famous',
            'Hurricane season Jun–Nov',
        ],
        portsOfEntry: ['English Harbour', "St John's", 'Jolly Harbour'],
        fees: 'Customs fees ~EC$50; cruising permit varies',
    },

    'saint lucia': {
        country: 'Saint Lucia',
        flag: '🇱🇨',
        difficulty: 'easy',
        departureProcedure: ['Clear out with Customs and Immigration at Rodney Bay or Castries'],
        arrivalProcedure: [
            'Fly Q flag and proceed to Rodney Bay Marina or Castries',
            'Clear with Customs, Immigration, and Health',
            'Cruising permit required for staying in marine reserves',
        ],
        contacts: [
            { name: 'Customs (Rodney Bay)', phone: '+1 758 452 2036' },
            { name: 'Immigration', phone: '+1 758 452 2940' },
            { name: 'Marine Police', phone: '+1 758 456 7352', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
        ],
        importantNotes: [
            'Pitons (Soufrière) — mooring buoys required, no anchoring',
            'ARC+ rally finishes in Rodney Bay — busy Dec/Jan',
            'Very friendly to cruisers',
        ],
        portsOfEntry: ['Rodney Bay', 'Castries', 'Marigot Bay', 'Soufrière'],
        fees: 'Cruising permit ~EC$40 + marine reserve fees ~US$5/day',
    },

    grenada: {
        country: 'Grenada',
        flag: '🇬🇩',
        difficulty: 'easy',
        departureProcedure: ['Clear out with Customs and Immigration at Port Louis or Prickly Bay'],
        arrivalProcedure: [
            'Fly Q flag and proceed to Port Louis Marina or Prickly Bay',
            'Clear with Customs, Immigration, and Health',
            'eSeaClear online clearance available',
        ],
        contacts: [
            { name: 'Customs', phone: '+1 473 440 2240' },
            { name: 'Immigration', phone: '+1 473 440 2113' },
            { name: 'Coast Guard', phone: '+1 473 444 1931', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
        ],
        importantNotes: [
            'Below the hurricane belt — popular for hurricane season storage',
            'Good boatyards for haul-out and maintenance',
            'Friendly and laid-back clearance process',
        ],
        portsOfEntry: ["St George's (Port Louis)", 'Prickly Bay', 'Hillsborough (Carriacou)'],
        fees: 'Customs fees ~EC$50-100',
    },

    'sint maarten': {
        country: 'Sint Maarten',
        flag: '🇸🇽',
        difficulty: 'easy',
        departureProcedure: ['Clear out with Customs and Immigration at Simpson Bay or Philipsburg'],
        arrivalProcedure: [
            'Fly Q flag and proceed to Simpson Bay lagoon or Philipsburg',
            'Clear with Customs and Immigration',
            'Dutch side (Sint Maarten) and French side (Saint-Martin) have SEPARATE clearance',
        ],
        contacts: [
            { name: 'Customs (Dutch side)', phone: '+1 721 542 1000' },
            { name: 'Immigration', phone: '+1 721 542 2346' },
            { name: 'Coast Guard', phone: '+1 721 542 2222', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
        ],
        importantNotes: [
            '⚠️ The island is split — Dutch (Sint Maarten) and French (Saint-Martin)',
            'Clearing on one side does NOT clear you for the other',
            'Simpson Bay Bridge opens at set times — check schedule',
            'Major charter and provisioning hub',
        ],
        portsOfEntry: ['Simpson Bay (Dutch)', 'Philipsburg (Dutch)', 'Marigot (French)'],
        fees: 'Customs fees ~US$10-25; bridge fee for Simpson Bay lagoon',
    },

    bahamas: {
        country: 'Bahamas',
        flag: '🇧🇸',
        difficulty: 'easy',
        departureProcedure: [
            'Clear out with Customs and Immigration at nearest port',
            'Submit departure card for each crew member',
        ],
        arrivalProcedure: [
            'Fly Q flag and proceed to a Port of Entry',
            'Clear with Customs, Immigration, and Health',
            'Captain clears ashore — crew remains on board',
            'Cruising permit and fishing licence available on clearance',
        ],
        contacts: [
            { name: 'Customs', phone: '+1 242 326 4401' },
            { name: 'Immigration', phone: '+1 242 322 7530' },
            { name: 'BASRA (Bahamas Air-Sea Rescue)', phone: '+1 242 325 8864', vhf: 'Ch 16' },
        ],
        requiredDocuments: [
            { name: 'Passports for all crew', critical: true },
            { name: 'Vessel Registration', critical: true },
            { name: 'Crew List', critical: true },
            { name: 'Port Clearance from last port', critical: true },
        ],
        importantNotes: [
            'Cruising permit valid for 12 months — covers all crew',
            'Fishing licence required and easily obtainable on clearance',
            'Shallow waters — need good charts, polarised sunnies, and daylight navigation',
        ],
        portsOfEntry: [
            'Nassau',
            'Marsh Harbour (Abacos)',
            'George Town (Exumas)',
            'Freeport (Grand Bahama)',
            'Spanish Wells',
        ],
        fees: 'Cruising permit ~US$300 for vessel + US$25/person over 4 months',
    },
};

/* ── Helpers ──────────────────────────────────────────────────── */

// Common name aliases so Gemini's free-text country names match our keys
export const COUNTRY_ALIASES: Record<string, string> = {
    tahiti: 'french polynesia',
    'french poly': 'french polynesia',
    bvi: 'british virgin islands',
    'virgin islands': 'british virgin islands',
    'st lucia': 'saint lucia',
    'st. lucia': 'saint lucia',
    'st maarten': 'sint maarten',
    'st. maarten': 'sint maarten',
    'saint martin': 'sint maarten',
    'saint-martin': 'sint maarten',
    'new cal': 'new caledonia',
    noumea: 'new caledonia',
    uk: 'united kingdom',
    'great britain': 'united kingdom',
    us: 'united states',
    usa: 'united states',
    america: 'united states',
    png: 'papua new guinea',
    nz: 'new zealand',
    turkey: 'türkiye',
    turkiye: 'türkiye',
    oz: 'australia',
    antigua: 'antigua and barbuda',
    barbuda: 'antigua and barbuda',
    cooks: 'cook islands',
    rarotonga: 'cook islands',
};

export function findCountryData(country: string | undefined): CountryClearance | undefined {
    if (!country) return undefined;
    const key = country.toLowerCase().trim();
    // Direct key match
    if (COUNTRY_DB[key]) return COUNTRY_DB[key];
    // Alias match
    if (COUNTRY_ALIASES[key] && COUNTRY_DB[COUNTRY_ALIASES[key]]) return COUNTRY_DB[COUNTRY_ALIASES[key]];
    // Partial alias match
    const aliasKey = Object.keys(COUNTRY_ALIASES).find((a) => key.includes(a) || a.includes(key));
    if (aliasKey && COUNTRY_DB[COUNTRY_ALIASES[aliasKey]]) return COUNTRY_DB[COUNTRY_ALIASES[aliasKey]];
    // Partial country name match
    return Object.values(COUNTRY_DB).find(
        (c) => c.country.toLowerCase().includes(key) || key.includes(c.country.toLowerCase()),
    );
}

export const difficultyStyle = {
    easy: {
        text: 'text-emerald-400',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/20',
        label: 'Straightforward',
    },
    moderate: {
        text: 'text-amber-400',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
        label: 'Moderate Paperwork',
    },
    complex: { text: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20', label: 'Complex — Plan Ahead' },
};
