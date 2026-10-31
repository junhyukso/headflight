import Foundation

/// Streams the packet the HeadFlight simulator consumes. Compared to the opentrack format it adds a
/// sequence number, the sensor clock, and angular rates so the relay can predict between samples.
/// 64 bytes, little-endian: "AHR1", UInt32 seq, UInt64 sensor microseconds, then Float64 yaw,
/// pitch, roll (degrees) and yaw, pitch, roll rates (degrees/second).
///
/// The sensor clock matters: samples are taken every 40 ms but reach this process in bursts
/// (gaps up to 139 ms measured), so arrival time is too noisy to predict from.
public final class RelayUDPSender: UDPSender, @unchecked Sendable {
    public static let defaultPort: UInt16 = 4250

    private var seq: UInt32 = 0

    /// Called only from the pipeline's serial queue.
    public func send(frame: TrackingFrame) {
        seq &+= 1
        let micros = UInt64(max(frame.sensorTime, 0) * 1_000_000)
        send(RelayUDPSender.packet(seq: seq, micros: micros, euler: frame.euler, rates: frame.eulerRates))
    }

    /// Pure packet builder, exercised by unit tests.
    public static func packet(seq: UInt32, micros: UInt64, euler: Euler, rates: Euler) -> Data {
        var data = Data(capacity: 64)
        data.append(contentsOf: Array("AHR1".utf8))
        var leSeq = seq.littleEndian
        withUnsafeBytes(of: &leSeq) { data.append(contentsOf: $0) }
        var leMicros = micros.littleEndian
        withUnsafeBytes(of: &leMicros) { data.append(contentsOf: $0) }
        for v in [euler.yaw, euler.pitch, euler.roll, rates.yaw, rates.pitch, rates.roll] {
            var le = v.bitPattern.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        return data
    }
}
