import SwiftUI

/**
 * ThalassaWatchApp — watchOS App entry point.
 *
 * Wires the WCSession receiver (WatchSession) into the SwiftUI scene
 * so anchor + weather state from the phone flows into the views via
 * an @StateObject observable.
 */
@main
struct ThalassaWatchApp: App {

    /// Owns WCSession on the watch side. Lives for the whole app
    /// lifetime so we don't lose the activation state on tab switches.
    @StateObject private var session = WatchSession()

    /// Reads watch-local GPS for the standalone anchor alarm logic.
    /// (We don't trust the phone for the actual drag detection — if
    /// the phone dies overnight, the watch must still alarm.)
    @StateObject private var location = LocationManager()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(location)
                .onAppear {
                    session.activate()
                }
        }
    }
}
