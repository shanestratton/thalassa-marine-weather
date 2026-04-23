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

// DIAGNOSTIC: bare-metal Obj-C class with +load. Fires at image load
// time (earliest possible hook), independent of Swift class loading
// or Capacitor bridge init. If we DON'T see this NSLog at app launch,
// the .m file isn't being compiled/linked into the final binary at
// all — the Xcode build is silently dropping our local plugin sources.
@interface WeatherKitPluginLoadMarker : NSObject
@end
@implementation WeatherKitPluginLoadMarker
+ (void)load {
    NSLog(@"[WeatherKitPlugin.m] +load — .m file linked into binary");
}
@end

CAP_PLUGIN(WeatherKitPlugin, "WeatherKit",
    CAP_PLUGIN_METHOD(fetch, CAPPluginReturnPromise);
)
