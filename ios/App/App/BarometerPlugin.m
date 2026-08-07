#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// BarometerPlugin — Objective-C bridge for Capacitor.
// CoreMotion CMAltimeter wrapper: the iPhone's own barometer, which no web
// API can reach. See BarometerPlugin.swift for why the absolute reading is
// not trustworthy but the three-hour delta is.

CAP_PLUGIN(BarometerPlugin, "Barometer",
    CAP_PLUGIN_METHOD(isAvailable, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stop, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getLatest, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addListener, CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(removeAllListeners, CAPPluginReturnPromise);
)
