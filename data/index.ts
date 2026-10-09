/**
 * Barrel exports for data modules.
 *
 * Central import point — `import { isSameCountry } from '../data'`
 */

export {
    findCountryData,
    difficultyStyle,
    joinClearance,
    loadCustomsClearance,
    peekCustomsClearance,
    CUSTOMS_CLEARANCE_URL,
} from './customsDb';
export type {
    ClearanceContact,
    RequiredDocument,
    CountryClearance,
    CountryClearanceDetails,
    CustomsClearanceGuide,
} from './customsDb';
export {
    CUSTOMS_PORT_INDEX,
    COUNTRY_ALIASES,
    findCountryKey,
    isSameCountry,
    resolveCountryName,
} from './customsPortIndex';
export type { CustomsCountry } from './customsPortIndex';
