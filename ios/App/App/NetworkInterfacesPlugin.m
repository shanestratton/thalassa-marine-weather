#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// NetworkInterfacesPlugin — Objective-C bridge for Capacitor.
// getifaddrs() walk: our LAN address, and whether a VPN tunnel is carrying
// traffic. See NetworkInterfacesPlugin.swift for why the web layer can't
// answer either question on iOS.

CAP_PLUGIN(NetworkInterfacesPlugin, "NetworkInterfaces",
    CAP_PLUGIN_METHOD(list, CAPPluginReturnPromise);
)
