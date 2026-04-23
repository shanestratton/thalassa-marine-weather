#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// LightningPlugin — Objective-C bridge for Capacitor.
// Native URLSessionWebSocketTask wrapper used by the Blitzortung lightning
// feed. See LightningPlugin.swift header for why this can't live in JS.

CAP_PLUGIN(LightningPlugin, "Lightning",
    CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stop, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addListener, CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(removeAllListeners, CAPPluginReturnPromise);
)
