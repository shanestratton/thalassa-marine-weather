#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// SshClientPlugin — Objective-C bridge for Capacitor
// Registers the Swift SSH plugin with Capacitor's plugin system

CAP_PLUGIN(SshClientPlugin, "SshClient",
    CAP_PLUGIN_METHOD(execute, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(testConnection, CAPPluginReturnPromise);
)
