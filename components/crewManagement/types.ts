/**
 * CrewManagement — shared types.
 *
 * Moved out of components/CrewManagement.tsx verbatim so the row shape the
 * whole Passage Planning page (and ReadinessCardStack) works with has one
 * home. CrewManagement.tsx re-exports VoyageRow, so external importers are
 * unchanged.
 */
import { type Voyage } from '../../services/VoyageService';

/**
 * VoyageRow — a Voyage augmented with departure/arrival coords AND
 * planned duration looked up from the matching logbook route. Used as
 * the dropdown's row type so Weather Windows + Ocean Currents cards
 * can run their analysis (need coords) and Voyage Provisioning can
 * auto-compute ETA from departure (needs duration). Lets us avoid a
 * voyages-table schema migration.
 */
export type VoyageRow = Voyage & {
    departureCoords?: { lat: number; lon: number };
    arrivalCoords?: { lat: number; lon: number };
    /** Full saved/planned geometry, in passage order. Kept on the row so
     *  Passage Summary does not have to guess from the global chart route. */
    routeCoordinates?: Array<{ lat: number; lon: number }>;
    /** Underlying planned-route log voyage. Distinct from this voyage-row ID. */
    plannedRouteId?: string;
    /** Distance supplied by this exact planned-route record, in NM. */
    distanceNm?: number;
    durationHours?: number;
    /** True when this voyage belongs to a captain who shared it with us. */
    isShared?: boolean;
    sharedOwnerEmail?: string;
};

export interface CrewManagementProps {
    onBack: () => void;
}
