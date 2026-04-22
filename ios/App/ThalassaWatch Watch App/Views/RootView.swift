import SwiftUI

/**
 * RootView — TabView shell for the watch app.
 *
 * Three tabs, ordered by safety value:
 *   1. Anchor Watch — drag detection + alarm
 *   2. Cockpit — wind / heading / SOG glance
 *   3. MOB — long-press for mayday
 *
 * The watch's tab indicator dots are at the bottom by default; on
 * Series 4+ a side button can also page between tabs.
 */
struct RootView: View {

    @EnvironmentObject var session: WatchSession
    @EnvironmentObject var location: LocationManager

    var body: some View {
        TabView {
            AnchorWatchView()
                .tag(0)

            CockpitGlanceView()
                .tag(1)

            MobButton()
                .tag(2)
        }
        .tabViewStyle(.page)
    }
}
