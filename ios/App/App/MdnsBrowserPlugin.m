#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// MdnsBrowserPlugin — Objective-C bridge for Capacitor.
// Bonjour / mDNS service browser used by services/PiCacheService.ts to
// discover the Pi cache by service type instead of hostname guessing.
// See MdnsBrowserPlugin.swift header for full rationale.

CAP_PLUGIN(MdnsBrowserPlugin, "MdnsBrowser",
    CAP_PLUGIN_METHOD(browse, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(resolveHostname, CAPPluginReturnPromise);
)
