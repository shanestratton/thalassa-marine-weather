#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// WatchConnectivityPlugin — Objective-C bridge for Capacitor.
// Registers the Swift plugin with Capacitor's plugin system so the
// `WatchConnectivity` namespace is available from TypeScript via
// `Capacitor.plugins.WatchConnectivity`.

CAP_PLUGIN(WatchConnectivityPlugin, "WatchConnectivity",
    CAP_PLUGIN_METHOD(isAvailable, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(pushAnchorState, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(pushWeatherSnapshot, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addListener, CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(removeAllListeners, CAPPluginReturnPromise);
)
