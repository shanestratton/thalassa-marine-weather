#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// NfcTagPlugin — Objective-C bridge for Capacitor (126-11b).
// Registers the Swift plugin as `NfcTag`: the NFC tags on Ship's Stores boxes.
// Every call returns a promise answered from a Core NFC callback (never by
// waiting on the bridge queue).

CAP_PLUGIN(NfcTagPlugin, "NfcTag",
    CAP_PLUGIN_METHOD(isAvailable, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(write, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(scan, CAPPluginReturnPromise);
)
