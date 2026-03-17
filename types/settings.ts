/**
 * types/settings.ts — User settings type
 */

import type { DisplayMode, DashboardMode, ScreenOrientationType, UnitPreferences } from './units';
import type { NotificationPreferences, WeatherModel } from './weather';
import type { VesselProfile, VesselDimensionUnits } from './vessel';
import type { PolarData } from './navigation';

/** User-defined safety thresholds for passage planning.
 *  The isochrone router treats zones exceeding these as obstacles.
 *  Undefined fields = no limit (disabled). */
export interface ComfortParams {
    maxWindKts?: number; // Max sustained wind (default: off)
    maxWaveM?: number; // Max significant wave height (default: off)
    maxGustKts?: number; // Max gust (default: off)
}

export interface UserSettings {
    isPro: boolean;
    firstName?: string;
    lastName?: string;
    alwaysOn?: boolean;
    notifications: NotificationPreferences;
    units: UnitPreferences;
    defaultLocation?: string;
    savedLocations: string[];
    vessel?: VesselProfile;
    vesselUnits?: VesselDimensionUnits;
    timeDisplay: 'location' | 'device';
    displayMode: DisplayMode;
    preferredModel: WeatherModel;
    mapboxToken?: string;
    aiPersona?: number;
    heroWidgets?: string[];
    topHeroWidget?: string;
    detailsWidgets?: string[];
    rowOrder?: string[];
    dynamicHeaderMetrics?: boolean;
    dashboardMode?: DashboardMode;
    screenOrientation?: ScreenOrientationType;
    autoTrackEnabled?: boolean;
    backgroundLocationEnabled?: boolean;
    polarSource?: 'factory' | 'smart';
    nmeaHost?: string;
    nmeaPort?: number;
    smartPolarsEnabled?: boolean;
    comfortParams?: ComfortParams;
    gribMode?: 'direct' | 'iridium';
    satelliteMode?: boolean;
    cloudSyncSettings?: boolean;
    cloudSyncVoyages?: boolean;
    cloudSyncCommunity?: boolean;
    polarData?: PolarData;
    polarBoatModel?: string;
    polarSource_type?: 'database' | 'file_import' | 'manual';
}
