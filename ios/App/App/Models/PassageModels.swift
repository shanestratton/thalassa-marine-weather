// ═══════════════════════════════════════════════════════════════════════════════
//  THALASSA — SwiftData Passage Planning Schema
//
//  Offline-first persistence for passages, waypoints, checklists & provisions.
//  All data lives on-device with iCloud sync via SwiftData's CloudKit support.
//
//  Relationships:
//    Passage ──┬── [Waypoint]      (cascade delete)
//              ├── [ChecklistItem] (cascade delete)
//              └── Provisioning?   (cascade delete)
//
//  Requires: iOS 17+ / iPadOS 17+ (SwiftData)
// ═══════════════════════════════════════════════════════════════════════════════

import Foundation
import SwiftData


// MARK: - Passage (Root Model)

/// The root entity representing a complete passage plan.
/// Deleting a Passage cascades to all child waypoints, checklists, and provisions.
@Model
final class Passage {
    
    // ── Identity ─────────────────────────────────────────────────────
    
    /// Stable UUID for cross-referencing (e.g., linking to Supabase records)
    var id: UUID
    
    /// Human-readable name, e.g., "Newport to Noumea"
    var name: String
    
    // ── Voyage Details ───────────────────────────────────────────────
    
    /// Planned departure date/time
    var departureDate: Date
    
    /// Estimated arrival (computed from distance + speed, or AI-provided)
    var estimatedArrival: Date?
    
    /// Approximate distance in nautical miles
    var distanceNM: Double?
    
    /// Estimated duration as human-readable string (e.g., "3-4 days")
    var durationApprox: String?
    
    /// Origin port/location name
    var originName: String
    
    /// Destination port/location name
    var destinationName: String
    
    /// Origin coordinates
    var originLat: Double?
    var originLon: Double?
    
    /// Destination coordinates
    var destinationLat: Double?
    var destinationLon: Double?
    
    // ── AI-Generated Content ─────────────────────────────────────────
    
    /// Professional voyage overview from Gemini
    var overview: String?
    
    /// Route strategy — why this specific route was chosen
    var routeReasoning: String?
    
    /// Suitability status: "SAFE", "CAUTION", "UNSAFE"
    var suitabilityStatus: String?
    
    /// Suitability reasoning from AI analysis
    var suitabilityReasoning: String?
    
    /// Maximum wind speed encountered on route (kts)
    var maxWindKts: Double?
    
    /// Maximum wave height encountered on route (ft)
    var maxWaveFt: Double?
    
    /// Best departure window description
    var bestDepartureWindow: String?
    
    /// Reasoning for the suggested departure window
    var bestDepartureReasoning: String?
    
    // ── Customs ──────────────────────────────────────────────────────
    
    /// Whether customs clearance is required
    var customsRequired: Bool
    
    /// Departing country name
    var customsDepartingCountry: String?
    
    /// Departure procedures summary
    var customsDepartureProcedures: String?
    
    /// Destination country name
    var customsDestinationCountry: String?
    
    /// Arrival clearance procedures
    var customsProcedures: String?
    
    /// Customs contact phone number
    var customsContactPhone: String?
    
    // ── Metadata ─────────────────────────────────────────────────────
    
    /// When this passage plan was created
    var createdAt: Date
    
    /// Last modification timestamp
    var updatedAt: Date
    
    /// Whether this passage has been completed/archived
    var isArchived: Bool
    
    /// The vessel name this plan was created for
    var vesselName: String?
    
    /// The vessel draft at time of planning (metres) — for bathymetric routing
    var vesselDraftM: Double?
    
    // ── Relationships (CASCADE DELETE) ────────────────────────────────
    
    /// Ordered waypoints for this passage.
    /// Deleting the passage removes all waypoints.
    @Relationship(deleteRule: .cascade, inverse: \Waypoint.passage)
    var waypoints: [Waypoint]
    
    /// Pre-departure and passage checklist items.
    /// Deleting the passage removes all checklist items.
    @Relationship(deleteRule: .cascade, inverse: \ChecklistItem.passage)
    var checklist: [ChecklistItem]
    
    /// Calculated provisioning manifest.
    /// Deleting the passage removes the provisioning data.
    @Relationship(deleteRule: .cascade, inverse: \Provisioning.passage)
    var provisioning: Provisioning?
    
    /// Identified hazards for this passage.
    /// Deleting the passage removes all hazard records.
    @Relationship(deleteRule: .cascade, inverse: \PassageHazard.passage)
    var hazards: [PassageHazard]
    
    // ── Initialiser ──────────────────────────────────────────────────
    
    init(
        name: String,
        originName: String,
        destinationName: String,
        departureDate: Date = .now,
        vesselName: String? = nil,
        vesselDraftM: Double? = nil
    ) {
        self.id = UUID()
        self.name = name
        self.originName = originName
        self.destinationName = destinationName
        self.departureDate = departureDate
        self.vesselName = vesselName
        self.vesselDraftM = vesselDraftM
        self.customsRequired = false
        self.isArchived = false
        self.createdAt = .now
        self.updatedAt = .now
        self.waypoints = []
        self.checklist = []
        self.hazards = []
    }
    
    // ── Computed Properties ───────────────────────────────────────────
    
    /// Sorted waypoints by sequence order
    var sortedWaypoints: [Waypoint] {
        waypoints.sorted { $0.sequenceOrder < $1.sequenceOrder }
    }
    
    /// Checklist completion progress (0.0 – 1.0)
    var checklistProgress: Double {
        guard !checklist.isEmpty else { return 0 }
        return Double(checklist.filter(\.isCompleted).count) / Double(checklist.count)
    }
    
    /// Whether the full checklist is complete
    var isChecklistComplete: Bool {
        !checklist.isEmpty && checklist.allSatisfy(\.isCompleted)
    }
}


// MARK: - Waypoint

/// A navigation waypoint along the passage route.
/// Ordered by `sequenceOrder` (0 = departure, N = arrival).
@Model
final class Waypoint {
    
    var id: UUID
    
    /// Position in the route sequence (0-indexed)
    var sequenceOrder: Int
    
    /// Latitude in decimal degrees (-90 to 90)
    var latitude: Double
    
    /// Longitude in decimal degrees (-180 to 180)
    var longitude: Double
    
    /// Optional waypoint name (e.g., "Torres Strait", "Timor Sea")
    var name: String?
    
    /// Estimated wind speed at this waypoint (knots)
    var windSpeedKts: Double?
    
    /// Estimated wave height at this waypoint (feet)
    var waveHeightFt: Double?
    
    /// Estimated sea state description
    var seaState: String?
    
    /// Water depth at this position (metres, from bathymetric data)
    var depthM: Double?
    
    /// Notes or conditions for this waypoint
    var notes: String?
    
    /// ETA at this waypoint
    var eta: Date?
    
    // ── Inverse Relationship ─────────────────────────────────────────
    
    /// The passage this waypoint belongs to (optional to avoid init cycles)
    var passage: Passage?
    
    // ── Initialiser ──────────────────────────────────────────────────
    
    init(
        sequenceOrder: Int,
        latitude: Double,
        longitude: Double,
        name: String? = nil,
        windSpeedKts: Double? = nil,
        waveHeightFt: Double? = nil,
        depthM: Double? = nil
    ) {
        self.id = UUID()
        self.sequenceOrder = sequenceOrder
        self.latitude = latitude
        self.longitude = longitude
        self.name = name
        self.windSpeedKts = windSpeedKts
        self.waveHeightFt = waveHeightFt
        self.depthM = depthM
    }
    
    // ── Computed ──────────────────────────────────────────────────────
    
    /// Formatted coordinate string (e.g., "27°28.5'S 153°22.1'E")
    var formattedPosition: String {
        let latDir = latitude >= 0 ? "N" : "S"
        let lonDir = longitude >= 0 ? "E" : "W"
        let latDeg = Int(abs(latitude))
        let latMin = (abs(latitude) - Double(latDeg)) * 60
        let lonDeg = Int(abs(longitude))
        let lonMin = (abs(longitude) - Double(lonDeg)) * 60
        return String(format: "%d°%05.2f'%@ %d°%05.2f'%@",
                      latDeg, latMin, latDir, lonDeg, lonMin, lonDir)
    }
}


// MARK: - ChecklistItem

/// A toggleable checklist item for pre-departure or passage tasks.
@Model
final class ChecklistItem {
    
    var id: UUID
    
    /// The checklist item text (e.g., "Check engine oil level")
    var title: String
    
    /// Whether this item has been completed
    var isCompleted: Bool
    
    /// Category grouping (e.g., "Safety", "Navigation", "Engine", "Provisions")
    var category: String?
    
    /// Display order within its category
    var sortOrder: Int
    
    /// When this item was completed (nil if not yet done)
    var completedAt: Date?
    
    /// Optional notes (e.g., "Oil level was low — topped up 0.5L")
    var notes: String?
    
    // ── Inverse Relationship ─────────────────────────────────────────
    
    var passage: Passage?
    
    // ── Initialiser ──────────────────────────────────────────────────
    
    init(
        title: String,
        category: String? = nil,
        sortOrder: Int = 0,
        isCompleted: Bool = false
    ) {
        self.id = UUID()
        self.title = title
        self.category = category
        self.sortOrder = sortOrder
        self.isCompleted = isCompleted
    }
    
    /// Toggle completion state and record timestamp
    func toggle() {
        isCompleted.toggle()
        completedAt = isCompleted ? .now : nil
    }
}


// MARK: - Provisioning

/// Calculated provisioning manifest for a passage.
/// Computed from vessel specs, crew count, and passage duration.
@Model
final class Provisioning {
    
    var id: UUID
    
    // ── Fuel ─────────────────────────────────────────────────────────
    
    /// Estimated fuel required (litres, base consumption)
    var fuelRequiredL: Double
    
    /// Fuel with 30% safety reserve (litres)
    var fuelWithReserveL: Double
    
    /// Whether the vessel's fuel capacity is sufficient
    var fuelSufficient: Bool
    
    /// Estimated motoring hours (sail vessels: ~15% of duration)
    var motoringHours: Double
    
    // ── Water ────────────────────────────────────────────────────────
    
    /// Fresh water required (litres, 3L/person/day standard)
    var waterRequiredL: Double
    
    // ── Food ─────────────────────────────────────────────────────────
    
    /// Total meals required (crew × days × 3 meals)
    var mealsRequired: Int
    
    /// Days at sea (from passage duration)
    var daysAtSea: Double
    
    // ── Crew ─────────────────────────────────────────────────────────
    
    /// Number of crew for provisioning calculations
    var crewCount: Int
    
    // ── Custom Items ─────────────────────────────────────────────────
    
    /// User-added custom provision notes (e.g., "Buy 4 jerry cans diesel in Cairns")
    var customNotes: String?
    
    // ── Inverse Relationship ─────────────────────────────────────────
    
    var passage: Passage?
    
    // ── Initialiser ──────────────────────────────────────────────────
    
    init(
        fuelRequiredL: Double = 0,
        fuelWithReserveL: Double = 0,
        fuelSufficient: Bool = true,
        motoringHours: Double = 0,
        waterRequiredL: Double = 0,
        mealsRequired: Int = 0,
        daysAtSea: Double = 0,
        crewCount: Int = 2
    ) {
        self.id = UUID()
        self.fuelRequiredL = fuelRequiredL
        self.fuelWithReserveL = fuelWithReserveL
        self.fuelSufficient = fuelSufficient
        self.motoringHours = motoringHours
        self.waterRequiredL = waterRequiredL
        self.mealsRequired = mealsRequired
        self.daysAtSea = daysAtSea
        self.crewCount = crewCount
    }
    
    // ── Factory ──────────────────────────────────────────────────────
    
    /// Calculate provisioning from vessel specs and passage duration.
    static func calculate(
        durationHours: Double,
        crewCount: Int,
        fuelBurnRate: Double,    // L/hr
        fuelCapacity: Double,    // L
        isSailVessel: Bool
    ) -> Provisioning {
        let motorFraction = isSailVessel ? 0.15 : 1.0
        let motorHours = durationHours * motorFraction
        let fuelBase = fuelBurnRate * motorHours
        let fuelReserve = fuelBase * 1.3
        let days = durationHours / 24.0
        
        return Provisioning(
            fuelRequiredL: fuelBase,
            fuelWithReserveL: fuelReserve,
            fuelSufficient: fuelCapacity >= fuelReserve,
            motoringHours: motorHours,
            waterRequiredL: Double(crewCount) * days * 3.0,
            mealsRequired: Int(ceil(days * Double(crewCount) * 3.0)),
            daysAtSea: days,
            crewCount: crewCount
        )
    }
}


// MARK: - PassageHazard

/// An identified hazard along the passage route.
@Model
final class PassageHazard {
    
    var id: UUID
    
    /// Hazard name (e.g., "Great Barrier Reef", "Cyclone Season")
    var name: String
    
    /// Severity: "LOW", "MEDIUM", "HIGH", "CRITICAL"
    var severity: String
    
    /// Detailed description of the hazard
    var hazardDescription: String
    
    // ── Inverse Relationship ─────────────────────────────────────────
    
    var passage: Passage?
    
    // ── Initialiser ──────────────────────────────────────────────────
    
    init(name: String, severity: String, hazardDescription: String) {
        self.id = UUID()
        self.name = name
        self.severity = severity
        self.hazardDescription = hazardDescription
    }
}
