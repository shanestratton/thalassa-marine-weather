import Foundation
import Capacitor
import CoreLocation
import WeatherKit

/**
 * WeatherKitPlugin — Native Apple WeatherKit bridge.
 *
 * Replaces the Supabase edge-function path for iOS. The REST API route
 * (edge fn signs a JWT, proxies to WeatherKit) adds 500ms-1s of cold
 * start + an extra hop; the native WeatherKit framework authenticates
 * via the device's App Store identity, so we go device → Apple direct.
 *
 * Returns a JSON payload that MATCHES the shape of the WeatherKit REST
 * API response — specifically the { currentWeather, forecastHourly,
 * forecastDaily, forecastNextHour } keys — so the existing mapping
 * functions in services/weather/api/weatherkit.ts (`mapCurrentWeather`,
 * `mapHourlyForecast`, etc.) can be reused unchanged. The web platform
 * continues to use the Supabase path; client code picks the right one
 * via Capacitor.isNativePlatform().
 *
 * Requires:
 *   - iOS 16+ (the framework's minimum; we target iOS 17+)
 *   - WeatherKit capability in the Xcode target (com.apple.developer.weatherkit)
 *   - An Apple Developer account with WeatherKit enabled (free for
 *     native; the 500k-call/mo quota is shared with REST usage)
 */
@available(iOS 16.0, *)
@objc(WeatherKitPlugin)
public class WeatherKitPlugin: CAPPlugin {

    private let service = WeatherService.shared

    @objc func fetch(_ call: CAPPluginCall) {
        guard let lat = call.getDouble("lat"),
              let lon = call.getDouble("lon") else {
            call.reject("Missing lat/lon")
            return
        }

        let location = CLLocation(latitude: lat, longitude: lon)

        Task {
            do {
                // Single call pulls current + hourly + daily + minute in
                // parallel on Apple's side. ~100-300ms typical from a
                // warm iOS client on good wifi.
                let weather = try await service.weather(for: location)
                let payload = Self.serialize(weather)
                call.resolve(payload)
            } catch {
                call.reject("WeatherKit fetch failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Serialization
    //
    // Maps Apple's Swift `Weather` object into a JSON shape that matches
    // the WeatherKit REST API so the TypeScript mappers can stay shared
    // between the native and web paths.

    private static func serialize(_ w: Weather) -> [String: Any] {
        var out: [String: Any] = [:]
        out["currentWeather"] = serializeCurrent(w.currentWeather)
        out["forecastHourly"] = ["hours": w.hourlyForecast.forecast.prefix(48).map(serializeHour)]
        out["forecastDaily"] = ["days": w.dailyForecast.forecast.prefix(10).map(serializeDay)]
        if let minute = w.minuteForecast {
            out["forecastNextHour"] = [
                "summary": [["condition": "clear"]], // placeholder — Apple doesn't expose a unified summary text; TS side derives
                "minutes": minute.forecast.prefix(60).map(serializeMinute)
            ] as [String: Any]
        }
        return out
    }

    private static func serializeCurrent(_ c: CurrentWeather) -> [String: Any] {
        return [
            "asOf": ISO8601DateFormatter().string(from: c.date),
            "temperature": c.temperature.converted(to: .celsius).value,
            "temperatureApparent": c.apparentTemperature.converted(to: .celsius).value,
            "dewPoint": c.dewPoint.converted(to: .celsius).value,
            "humidity": c.humidity,
            "pressure": c.pressure.converted(to: .millibars).value,
            "pressureTrend": c.pressureTrend.rawValue,
            "visibility": c.visibility.converted(to: .meters).value,
            "uvIndex": c.uvIndex.value,
            "cloudCover": c.cloudCover,
            "conditionCode": String(describing: c.condition),
            "windSpeed": c.wind.speed.converted(to: .kilometersPerHour).value,
            "windGust": c.wind.gust?.converted(to: .kilometersPerHour).value as Any,
            "windDirection": c.wind.direction.converted(to: .degrees).value,
        ]
    }

    private static func serializeHour(_ h: HourWeather) -> [String: Any] {
        return [
            "forecastStart": ISO8601DateFormatter().string(from: h.date),
            "temperature": h.temperature.converted(to: .celsius).value,
            "temperatureApparent": h.apparentTemperature.converted(to: .celsius).value,
            "humidity": h.humidity,
            "pressure": h.pressure.converted(to: .millibars).value,
            "conditionCode": String(describing: h.condition),
            "cloudCover": h.cloudCover,
            "precipitationChance": h.precipitationChance,
            "precipitationAmount": h.precipitationAmount.converted(to: .millimeters).value,
            "windSpeed": h.wind.speed.converted(to: .kilometersPerHour).value,
            "windGust": h.wind.gust?.converted(to: .kilometersPerHour).value as Any,
            "windDirection": h.wind.direction.converted(to: .degrees).value,
            "uvIndex": h.uvIndex.value,
            "visibility": h.visibility.converted(to: .meters).value,
        ]
    }

    private static func serializeDay(_ d: DayWeather) -> [String: Any] {
        let fmt = ISO8601DateFormatter()
        // DayWeather exposes a single `date` (start of day in local
        // timezone) — not startDate/endDate. Compute the end by adding
        // a calendar day so the downstream mapper has both edges.
        let startDate = d.date
        let endDate = Calendar.current.date(byAdding: .day, value: 1, to: startDate) ?? startDate
        return [
            "forecastStart": fmt.string(from: startDate),
            "forecastEnd": fmt.string(from: endDate),
            "conditionCode": String(describing: d.condition),
            "temperatureMax": d.highTemperature.converted(to: .celsius).value,
            "temperatureMin": d.lowTemperature.converted(to: .celsius).value,
            "precipitationChance": d.precipitationChance,
            // `rainfallAmount` was deprecated in iOS 16.4 in favour of
            // `precipitationAmountByType`, which separates rain vs snow
            // vs mixed. We target iOS 17+ so use the new API. `.rain` is
            // the modern direct replacement for the old rainfallAmount.
            "precipitationAmount": d.precipitationAmountByType.rain.converted(to: .millimeters).value,
            "snowfallAmount": d.precipitationAmountByType.snow.converted(to: .millimeters).value,
            "sunrise": d.sun.sunrise.map { fmt.string(from: $0) } as Any,
            "sunset": d.sun.sunset.map { fmt.string(from: $0) } as Any,
            "moonPhase": d.moon.phase.rawValue,
            "moonrise": d.moon.moonrise.map { fmt.string(from: $0) } as Any,
            "moonset": d.moon.moonset.map { fmt.string(from: $0) } as Any,
            "uvIndexMax": d.uvIndex.value,
            "windSpeedMax": d.wind.speed.converted(to: .kilometersPerHour).value,
            "windDirection": d.wind.direction.converted(to: .degrees).value,
        ]
    }

    private static func serializeMinute(_ m: MinuteWeather) -> [String: Any] {
        // `precipitationIntensity` is a Measurement<UnitSpeed> in Apple's
        // model, and Foundation's built-in UnitSpeed doesn't define a
        // "millimetres per hour" unit — the base SI value is m/s. Pass
        // the raw value through; the TS mapper already handles it as
        // a number and re-interprets the scale.
        return [
            "startTime": ISO8601DateFormatter().string(from: m.date),
            "precipitationChance": m.precipitationChance,
            "precipitationIntensity": m.precipitationIntensity.value,
        ]
    }
}
