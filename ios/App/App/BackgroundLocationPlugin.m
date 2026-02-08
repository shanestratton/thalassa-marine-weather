#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// BackgroundLocationPlugin - Objective-C bridge for Capacitor
// This registers the Swift plugin with Capacitor's plugin system

CAP_PLUGIN(BackgroundLocationPlugin, "BackgroundLocation",
    CAP_PLUGIN_METHOD(startBackgroundLocation, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopBackgroundLocation, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getStatus, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(requestAlwaysPermission, CAPPluginReturnPromise);
)
