import Foundation

/// User-facing configuration, persisted as one JSON blob so the app, the CLI, and
/// import/export all share the same representation.
public struct TrackerSettings: Codable, Equatable, Sendable {
    public var openTrackHost: String = "127.0.0.1"
    public var openTrackPort: Int = 4242
    public var relayPort: Int = Int(RelayUDPSender.defaultPort)
    public var smoothing: Double = 0            // filtering happens in the relay, not twice
    public var axis: AxisConfig = AxisConfig()
    public var driftCompensation: Double = 0    // deg/s pull of yaw back to center; 0 = off
    public var recenterOnConnect: Bool = true   // recenter when AirPods (re)connect
    public var silentKeepAlive: Bool = true     // play silence to steady the motion stream
    public init() {}

    public init(from decoder: Decoder) throws {
        // decodeIfPresent so settings and exported configs from older versions keep loading.
        let c = try decoder.container(keyedBy: CodingKeys.self)
        openTrackHost = try c.decodeIfPresent(String.self, forKey: .openTrackHost) ?? "127.0.0.1"
        openTrackPort = try c.decodeIfPresent(Int.self, forKey: .openTrackPort) ?? 4242
        relayPort = try c.decodeIfPresent(Int.self, forKey: .relayPort) ?? Int(RelayUDPSender.defaultPort)
        smoothing = try c.decodeIfPresent(Double.self, forKey: .smoothing) ?? 0
        axis = try c.decodeIfPresent(AxisConfig.self, forKey: .axis) ?? AxisConfig()
        driftCompensation = try c.decodeIfPresent(Double.self, forKey: .driftCompensation) ?? 0
        recenterOnConnect = try c.decodeIfPresent(Bool.self, forKey: .recenterOnConnect) ?? true
        silentKeepAlive = try c.decodeIfPresent(Bool.self, forKey: .silentKeepAlive) ?? true
    }
}

public enum SettingsStore {
    public static let suiteName = "com.szilard.airtracker"
    private static let key = "settings"

    public static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    public static func load() -> TrackerSettings {
        guard let data = defaults.data(forKey: key),
              let s = try? JSONDecoder().decode(TrackerSettings.self, from: data) else {
            return TrackerSettings()
        }
        return s
    }

    public static func save(_ settings: TrackerSettings) {
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: key)
        }
    }

    public static func encode(_ settings: TrackerSettings) -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? enc.encode(settings)) ?? Data()
    }

    public static func decode(_ data: Data) -> TrackerSettings? {
        try? JSONDecoder().decode(TrackerSettings.self, from: data)
    }
}
