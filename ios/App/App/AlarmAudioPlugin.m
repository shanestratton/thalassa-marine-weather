#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// AlarmAudioPlugin - Objective-C bridge for Capacitor
// Registers the Swift alarm audio plugin with Capacitor's plugin system

CAP_PLUGIN(AlarmAudioPlugin, "AlarmAudio",
    CAP_PLUGIN_METHOD(startAlarm, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopAlarm, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isAlarmPlaying, CAPPluginReturnPromise);
)
