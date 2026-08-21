#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// MemoryGaugePlugin — Objective-C bridge for Capacitor.
// os_proc_available_memory + memory-warning events: the process-level truth
// the JS heap gauge cannot see on WKWebView. See MemoryGaugePlugin.swift.

CAP_PLUGIN(MemoryGaugePlugin, "MemoryGauge",
    CAP_PLUGIN_METHOD(read, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addListener, CAPPluginReturnCallback);
    CAP_PLUGIN_METHOD(removeAllListeners, CAPPluginReturnPromise);
)
