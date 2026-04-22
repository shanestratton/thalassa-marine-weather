#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// DataScannerPlugin — Objective-C bridge for Capacitor.
// Registers the Swift plugin with the `DataScanner` namespace so
// TypeScript can call it via `Capacitor.plugins.DataScanner`.
//
// Replaces @capacitor-mlkit/barcode-scanning with Apple's VisionKit
// DataScannerViewController (iOS 16+) — drops ~30 MB of MLKit weights
// and silences the "No platform load command" linker warning.

CAP_PLUGIN(DataScannerPlugin, "DataScanner",
    CAP_PLUGIN_METHOD(checkPermissions, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(requestPermissions, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isSupported, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(scan, CAPPluginReturnPromise);
)
