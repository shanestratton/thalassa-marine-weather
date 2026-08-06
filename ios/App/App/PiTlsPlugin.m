#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// PiTlsPlugin — Objective-C bridge for Capacitor.
// Pinned HTTPS to the boat's Pi: the certificate is self-signed from the Pi's
// pairing identity key, so the app validates it by comparing the leaf's SPKI
// to the key it pinned at pairing instead of consulting the system trust
// store. Consumed by services/piTls.ts.
// See PiTlsPlugin.swift for the full rationale.

CAP_PLUGIN(PiTlsPlugin, "PiTls",
    CAP_PLUGIN_METHOD(request, CAPPluginReturnPromise);
)
