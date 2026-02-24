// ═══════════════════════════════════════════════════════════════════════════════
//  THALASSA — SwiftData Container Setup & Usage Examples
//
//  This file shows:
//  1. How to initialise the ModelContainer in the App struct
//  2. How to insert a new Passage with waypoints + checklist
//  3. How to query passages using @Query
//  4. How to build a passage from a VoyagePlan API response
// ═══════════════════════════════════════════════════════════════════════════════

import SwiftUI
import SwiftData


// MARK: - 1. Container Setup (Main App Struct)

/*
 Add .modelContainer to your App's WindowGroup.
 Only the root model (Passage) needs to be listed —
 SwiftData discovers child models via relationships.

 @main
 struct ThalassaApp: App {
     var body: some Scene {
         WindowGroup {
             ContentView()
         }
         .modelContainer(for: [Passage.self])
     }
 }
*/

// For programmatic container setup (e.g., in AppDelegate for Capacitor):
func configureModelContainer() -> ModelContainer {
    let schema = Schema([
        Passage.self,
        Waypoint.self,
        ChecklistItem.self,
        Provisioning.self,
        PassageHazard.self,
    ])

    let config = ModelConfiguration(
        "ThalassaPassages",
        schema: schema,
        isStoredInMemoryOnly: false,    // Persist to disk
        allowsSave: true
    )

    do {
        return try ModelContainer(for: schema, configurations: [config])
    } catch {
        fatalError("Failed to create ModelContainer: \(error)")
    }
}


// MARK: - 2. Insert a New Passage

/// Example: Create a passage from Newport QLD to Bali with waypoints.
func createExamplePassage(context: ModelContext) {
    // Create the passage
    let passage = Passage(
        name: "Newport to Bali",
        originName: "Newport, QLD",
        destinationName: "Bali, Indonesia",
        departureDate: Date(),
        vesselName: "Serene Summer",
        vesselDraftM: 2.1
    )

    // Set coordinates
    passage.originLat = -27.35
    passage.originLon = 153.22
    passage.destinationLat = -8.75
    passage.destinationLon = 115.17

    // AI-generated fields
    passage.overview = "A 1,200 NM passage through the Coral Sea and Arafura Sea."
    passage.routeReasoning = "Route navigates through Torres Strait to avoid exposed waters north of PNG."
    passage.suitabilityStatus = "CAUTION"
    passage.suitabilityReasoning = "SE trade winds 15-25 kts expected. Monitor tropical lows in the Coral Sea."
    passage.maxWindKts = 25
    passage.maxWaveFt = 8
    passage.distanceNM = 1200
    passage.durationApprox = "5-7 days"
    passage.bestDepartureWindow = "0600-0800 local"
    passage.bestDepartureReasoning = "Outgoing tide from Moreton Bay, light morning winds."

    // Customs
    passage.customsRequired = true
    passage.customsDepartingCountry = "Australia"
    passage.customsDepartureProcedures = "Clear outbound at Brisbane Customs House."
    passage.customsDestinationCountry = "Indonesia"
    passage.customsProcedures = "Report to Benoa Harbour Master on VHF 12. CAIT visa required."
    passage.customsContactPhone = "+62 361 720 024"

    // Add waypoints (bathymetric-safe positions)
    let waypoints = [
        Waypoint(sequenceOrder: 0, latitude: -27.35, longitude: 153.22,
                 name: "Newport, QLD", windSpeedKts: 10, waveHeightFt: 1.5),
        Waypoint(sequenceOrder: 1, latitude: -24.50, longitude: 152.80,
                 name: "Bundaberg Offshore", windSpeedKts: 15, waveHeightFt: 3),
        Waypoint(sequenceOrder: 2, latitude: -15.50, longitude: 145.80,
                 name: "Cairns Offshore", windSpeedKts: 18, waveHeightFt: 4),
        Waypoint(sequenceOrder: 3, latitude: -10.60, longitude: 142.20,
                 name: "Torres Strait", windSpeedKts: 20, waveHeightFt: 5),
        Waypoint(sequenceOrder: 4, latitude: -9.50, longitude: 133.00,
                 name: "Arafura Sea", windSpeedKts: 22, waveHeightFt: 6),
        Waypoint(sequenceOrder: 5, latitude: -9.00, longitude: 123.50,
                 name: "Timor Sea", windSpeedKts: 18, waveHeightFt: 5),
        Waypoint(sequenceOrder: 6, latitude: -8.75, longitude: 115.17,
                 name: "Bali, Indonesia", windSpeedKts: 12, waveHeightFt: 2),
    ]
    passage.waypoints = waypoints

    // Add pre-departure checklist
    let checklistItems = [
        // Safety
        ChecklistItem(title: "EPIRB registered & tested", category: "Safety", sortOrder: 0),
        ChecklistItem(title: "Life raft serviced (< 12 months)", category: "Safety", sortOrder: 1),
        ChecklistItem(title: "Flares in date", category: "Safety", sortOrder: 2),
        ChecklistItem(title: "Fire extinguishers charged", category: "Safety", sortOrder: 3),
        ChecklistItem(title: "First aid kit stocked", category: "Safety", sortOrder: 4),
        // Navigation
        ChecklistItem(title: "Charts updated (Coral Sea, Arafura)", category: "Navigation", sortOrder: 0),
        ChecklistItem(title: "GPS waypoints loaded", category: "Navigation", sortOrder: 1),
        ChecklistItem(title: "AIS transponder tested", category: "Navigation", sortOrder: 2),
        ChecklistItem(title: "VHF radio check (Ch 16)", category: "Navigation", sortOrder: 3),
        // Engine
        ChecklistItem(title: "Engine oil level checked", category: "Engine", sortOrder: 0),
        ChecklistItem(title: "Coolant level topped up", category: "Engine", sortOrder: 1),
        ChecklistItem(title: "Fuel filters changed", category: "Engine", sortOrder: 2),
        ChecklistItem(title: "Impeller inspected", category: "Engine", sortOrder: 3),
        // Provisions
        ChecklistItem(title: "Fresh water tanks full", category: "Provisions", sortOrder: 0),
        ChecklistItem(title: "Fuel tanks full + jerry cans", category: "Provisions", sortOrder: 1),
        ChecklistItem(title: "7 days provisions loaded", category: "Provisions", sortOrder: 2),
        ChecklistItem(title: "Emergency rations sealed", category: "Provisions", sortOrder: 3),
        // Documents
        ChecklistItem(title: "Passports valid (6+ months)", category: "Documents", sortOrder: 0),
        ChecklistItem(title: "Australian customs clearance", category: "Documents", sortOrder: 1),
        ChecklistItem(title: "Indonesian CAIT visa obtained", category: "Documents", sortOrder: 2),
        ChecklistItem(title: "Vessel registration documents", category: "Documents", sortOrder: 3),
        ChecklistItem(title: "Insurance certificates", category: "Documents", sortOrder: 4),
    ]
    passage.checklist = checklistItems

    // Calculate provisioning (5.5 days, 2 crew, 4 L/hr burn, 400L tank, sail vessel)
    let provisioning = Provisioning.calculate(
        durationHours: 132,  // 5.5 days
        crewCount: 2,
        fuelBurnRate: 4.0,
        fuelCapacity: 400,
        isSailVessel: true
    )
    passage.provisioning = provisioning

    // Add hazards
    let hazards = [
        PassageHazard(
            name: "Great Barrier Reef",
            severity: "HIGH",
            hazardDescription: "Extensive reef system along QLD coast. Maintain safe distance offshore."
        ),
        PassageHazard(
            name: "Torres Strait Shipping",
            severity: "MEDIUM",
            hazardDescription: "Heavy commercial traffic. Monitor VHF 16 and use AIS. Tidal currents up to 5 kts."
        ),
        PassageHazard(
            name: "Tropical Cyclone Season",
            severity: "HIGH",
            hazardDescription: "Nov-Apr cyclone risk in the Coral Sea and Timor Sea. Monitor BOM warnings daily."
        ),
    ]
    passage.hazards = hazards

    // Insert into context — SwiftData persists automatically
    context.insert(passage)

    // That's it. SwiftData handles:
    // - Persisting to SQLite
    // - Setting inverse relationships (wp.passage = passage)
    // - Cascade deletes when the passage is removed
}


// MARK: - 3. Querying with @Query

/// Example: A SwiftUI view that lists all passages, sorted by departure date.
struct PassageListView: View {

    @Environment(\.modelContext) private var context

    @Query(sort: \Passage.departureDate, order: .reverse)
    private var passages: [Passage]

    var body: some View {
        NavigationStack {
            List {
                ForEach(passages) { passage in
                    NavigationLink {
                        PassageDetailView(passage: passage)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(passage.name)
                                .font(.headline)
                            HStack {
                                Text(passage.departureDate, style: .date)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                if let dist = passage.distanceNM {
                                    Text("\(Int(dist)) NM")
                                        .font(.caption)
                                        .foregroundStyle(.blue)
                                }
                                // Suitability badge
                                if let status = passage.suitabilityStatus {
                                    Text(status)
                                        .font(.caption2)
                                        .fontWeight(.bold)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(statusColor(status).opacity(0.2))
                                        .foregroundStyle(statusColor(status))
                                        .clipShape(Capsule())
                                }
                            }
                            // Checklist progress bar
                            if !passage.checklist.isEmpty {
                                ProgressView(value: passage.checklistProgress)
                                    .tint(passage.isChecklistComplete ? .green : .orange)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                .onDelete { indices in
                    for index in indices {
                        // Cascade delete removes all waypoints, checklist, provisions
                        context.delete(passages[index])
                    }
                }
            }
            .navigationTitle("Passages")
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "SAFE": return .green
        case "CAUTION": return .orange
        case "UNSAFE": return .red
        default: return .gray
        }
    }
}


// MARK: - 4. Passage Detail View (Drilldown)

struct PassageDetailView: View {
    let passage: Passage

    var body: some View {
        List {
            // Route info
            Section("Route") {
                LabeledContent("From", value: passage.originName)
                LabeledContent("To", value: passage.destinationName)
                if let dist = passage.distanceNM {
                    LabeledContent("Distance", value: "\(Int(dist)) NM")
                }
                if let dur = passage.durationApprox {
                    LabeledContent("Duration", value: dur)
                }
            }

            // Route reasoning
            if let reasoning = passage.routeReasoning {
                Section("Route Strategy") {
                    Text(reasoning)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }

            // Waypoints
            Section("Waypoints (\(passage.waypoints.count))") {
                ForEach(passage.sortedWaypoints) { wp in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(wp.name ?? "WP-\(wp.sequenceOrder)")
                            .font(.headline)
                        Text(wp.formattedPosition)
                            .font(.caption)
                            .monospaced()
                            .foregroundStyle(.secondary)
                        if let wind = wp.windSpeedKts, let wave = wp.waveHeightFt {
                            Text("\(Int(wind)) kts | \(String(format: "%.1f", wave)) ft seas")
                                .font(.caption2)
                                .foregroundStyle(.blue)
                        }
                    }
                }
            }

            // Checklist
            Section("Checklist (\(Int(passage.checklistProgress * 100))%)") {
                ForEach(passage.checklist.sorted(by: {
                    ($0.category ?? "") < ($1.category ?? "") ||
                    ($0.category == $1.category && $0.sortOrder < $1.sortOrder)
                })) { item in
                    HStack {
                        Image(systemName: item.isCompleted ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(item.isCompleted ? .green : .secondary)
                        Text(item.title)
                            .strikethrough(item.isCompleted)
                    }
                    .onTapGesture { item.toggle() }
                }
            }

            // Provisioning
            if let prov = passage.provisioning {
                Section("Provisioning") {
                    LabeledContent("Fuel (+ 30% reserve)", value: "\(Int(prov.fuelWithReserveL)) L")
                    LabeledContent("Fresh Water", value: "\(Int(prov.waterRequiredL)) L")
                    LabeledContent("Meals", value: "\(prov.mealsRequired)")
                    LabeledContent("Days at Sea", value: String(format: "%.1f", prov.daysAtSea))
                }
            }
        }
        .navigationTitle(passage.name)
    }
}


// MARK: - 5. Bridge: VoyagePlan API → SwiftData Passage

/// Convert a VoyagePlan JSON response into a persisted Passage.
/// Call this from the Capacitor bridge when the web app creates a new plan.
extension Passage {

    /// Create a Passage from the VoyagePlan JSON dictionary.
    /// This is the bridge between the TypeScript frontend and SwiftData persistence.
    convenience init(fromPlanJSON json: [String: Any], vesselName: String?, vesselDraft: Double?) {
        self.init(
            name: "\(json["origin"] as? String ?? "?") to \(json["destination"] as? String ?? "?")",
            originName: json["origin"] as? String ?? "",
            destinationName: json["destination"] as? String ?? "",
            departureDate: Self.parseDate(json["departureDate"] as? String) ?? .now,
            vesselName: vesselName,
            vesselDraftM: vesselDraft
        )

        // Parse all fields from VoyagePlan
        self.distanceNM = Self.parseDistance(json["distanceApprox"] as? String)
        self.durationApprox = json["durationApprox"] as? String
        self.overview = json["overview"] as? String
        self.routeReasoning = json["routeReasoning"] as? String

        // Coordinates
        if let coords = json["originCoordinates"] as? [String: Double] {
            self.originLat = coords["lat"]
            self.originLon = coords["lon"]
        }
        if let coords = json["destinationCoordinates"] as? [String: Double] {
            self.destinationLat = coords["lat"]
            self.destinationLon = coords["lon"]
        }

        // Suitability
        if let suit = json["suitability"] as? [String: Any] {
            self.suitabilityStatus = suit["status"] as? String
            self.suitabilityReasoning = suit["reasoning"] as? String
            self.maxWindKts = suit["maxWindEncountered"] as? Double
            self.maxWaveFt = suit["maxWaveEncountered"] as? Double
        }

        // Best departure window
        if let dep = json["bestDepartureWindow"] as? [String: String] {
            self.bestDepartureWindow = dep["timeRange"]
            self.bestDepartureReasoning = dep["reasoning"]
        }

        // Customs
        if let customs = json["customs"] as? [String: Any] {
            self.customsRequired = customs["required"] as? Bool ?? false
            self.customsDepartingCountry = customs["departingCountry"] as? String
            self.customsDepartureProcedures = customs["departureProcedures"] as? String
            self.customsDestinationCountry = customs["destinationCountry"] as? String
            self.customsProcedures = customs["procedures"] as? String
            self.customsContactPhone = customs["contactPhone"] as? String
        }

        // Waypoints
        if let wps = json["waypoints"] as? [[String: Any]] {
            self.waypoints = wps.enumerated().map { idx, wp in
                let coords = wp["coordinates"] as? [String: Double]
                return Waypoint(
                    sequenceOrder: idx,
                    latitude: coords?["lat"] ?? 0,
                    longitude: coords?["lon"] ?? 0,
                    name: wp["name"] as? String,
                    windSpeedKts: wp["windSpeed"] as? Double,
                    waveHeightFt: wp["waveHeight"] as? Double
                )
            }
        }

        // Hazards
        if let hazards = json["hazards"] as? [[String: Any]] {
            self.hazards = hazards.map { h in
                PassageHazard(
                    name: h["name"] as? String ?? "Unknown",
                    severity: h["severity"] as? String ?? "LOW",
                    hazardDescription: h["description"] as? String ?? ""
                )
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────

    private static func parseDate(_ str: String?) -> Date? {
        guard let str else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withFullDate]
        return fmt.date(from: str) ?? DateFormatter.yyyyMMdd.date(from: str)
    }

    private static func parseDistance(_ str: String?) -> Double? {
        guard let str else { return nil }
        let digits = str.components(separatedBy: CharacterSet.decimalDigits.inverted).joined()
        return Double(digits)
    }
}

private extension DateFormatter {
    static let yyyyMMdd: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}
