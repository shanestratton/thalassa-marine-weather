#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// WeatherKitPlugin — Objective-C bridge for Capacitor.
// Registers the Swift WeatherKit-native plugin with the `WeatherKit`
// namespace so TypeScript can call it via
// `Capacitor.plugins.WeatherKit.fetch({ lat, lon })`.
//
// Replaces the Supabase edge-function path on iOS: ~500ms-1s faster
// cold start because we skip the JWT-sign + HTTP round-trip and go
// device → Apple direct via the native WeatherKit framework.

CAP_PLUGIN(WeatherKitPlugin, "WeatherKit",
    CAP_PLUGIN_METHOD(fetch, CAPPluginReturnPromise);
)
