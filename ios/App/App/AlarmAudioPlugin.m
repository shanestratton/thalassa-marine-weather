#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// AlarmAudioPlugin - Objective-C bridge for Capacitor
// Registers the Swift alarm audio plugin with Capacitor's plugin system

// DIAGNOSTIC: bare-metal +load hook. See WeatherKitPlugin.m for why.
@interface AlarmAudioPluginLoadMarker : NSObject
@end
@implementation AlarmAudioPluginLoadMarker
+ (void)load {
    NSLog(@"[AlarmAudioPlugin.m] +load — .m file linked into binary");
}
@end

CAP_PLUGIN(AlarmAudioPlugin, "AlarmAudio",
    CAP_PLUGIN_METHOD(startAlarm, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopAlarm, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isAlarmPlaying, CAPPluginReturnPromise);
)
