import XCTest
import simd
@testable import AirTrackerCore

final class AirTrackerCoreTests: XCTestCase {

    // MARK: opentrack Euler conversion

    func testIdentityQuaternionIsZeroEuler() {
        let e = QuaternionMath.opentrackEuler(simd_quatd(ix: 0, iy: 0, iz: 0, r: 1))
        XCTAssertEqual(e.yaw, 0, accuracy: 1e-9)
        XCTAssertEqual(e.pitch, 0, accuracy: 1e-9)
        XCTAssertEqual(e.roll, 0, accuracy: 1e-9)
    }

    func testYawRotationAboutZ() {
        // +30° about the vertical (z) axis → yaw ≈ +30°.
        let angle = 30.0 * .pi / 180
        let q = simd_quatd(angle: angle, axis: SIMD3(0, 0, 1))
        let e = QuaternionMath.opentrackEuler(q)
        XCTAssertEqual(e.yaw, 30, accuracy: 1e-6)
        XCTAssertEqual(e.pitch, 0, accuracy: 1e-6)
        XCTAssertEqual(e.roll, 0, accuracy: 1e-6)
    }

    func testPitchRotationAboutX() {
        let angle = 20.0 * .pi / 180
        let q = simd_quatd(angle: angle, axis: SIMD3(1, 0, 0))
        let e = QuaternionMath.opentrackEuler(q)
        XCTAssertEqual(e.pitch, 20, accuracy: 1e-6)
        XCTAssertEqual(e.yaw, 0, accuracy: 1e-6)
        XCTAssertEqual(e.roll, 0, accuracy: 1e-6)
    }

    func testRollRotationAboutY() {
        let angle = 15.0 * .pi / 180
        let q = simd_quatd(angle: angle, axis: SIMD3(0, 1, 0))
        let e = QuaternionMath.opentrackEuler(q)
        XCTAssertEqual(e.roll, 15, accuracy: 1e-6)
        XCTAssertEqual(e.yaw, 0, accuracy: 1e-6)
        XCTAssertEqual(e.pitch, 0, accuracy: 1e-6)
    }

    // MARK: AxisConfig

    func testAxisConfigDefaultInvertsPitch() {
        let c = AxisConfig()
        let out = c.apply(to: Euler(yaw: 10, pitch: 20, roll: 30))
        XCTAssertEqual(out.yaw, 10)
        XCTAssertEqual(out.pitch, -20)   // invertPitch default on
        XCTAssertEqual(out.roll, 30)
    }

    func testAxisConfigRemapAndScale() {
        var c = AxisConfig()
        c.invertPitch = false
        c.yawSource = .roll          // yaw output reads the roll channel
        c.scaleYaw = 2.0
        let out = c.apply(to: Euler(yaw: 10, pitch: 20, roll: 30))
        XCTAssertEqual(out.yaw, 60)   // roll(30) * 2.0
        XCTAssertEqual(out.pitch, 20)
        XCTAssertEqual(out.roll, 30)
    }

    // MARK: Response shaping

    func testDeadzoneRemovesSmallMotionContinuously() {
        var c = AxisConfig()
        c.deadzone = 2
        XCTAssertEqual(c.shape(1.5), 0)
        XCTAssertEqual(c.shape(-1.5), 0)
        XCTAssertEqual(c.shape(2), 0)          // no jump at the edge
        XCTAssertEqual(c.shape(5), 3)          // subtractive, not a cliff
        XCTAssertEqual(c.shape(-5), -3)
    }

    func testExpoSoftensSmallAndPreserves90() {
        var c = AxisConfig()
        c.expo = 1.0
        XCTAssertEqual(c.shape(90), 90, accuracy: 1e-9)     // 90° invariant
        XCTAssertEqual(c.shape(-90), -90, accuracy: 1e-9)
        XCTAssertEqual(c.shape(9), 0.9, accuracy: 1e-9)     // quadratic near center
        c.expo = 0.5
        XCTAssertEqual(c.shape(9), 4.5 + 0.45, accuracy: 1e-9)  // linear/quadratic blend
        XCTAssertEqual(c.shape(0), 0)
    }

    func testShapingAppliesBeforeInvertAndScale() {
        var c = AxisConfig()
        c.invertPitch = false
        c.deadzone = 1
        c.scaleYaw = 2
        c.invertYaw = true
        let out = c.apply(to: Euler(yaw: 3, pitch: 0.5, roll: 0))
        XCTAssertEqual(out.yaw, -4)     // (3-1) * 2, inverted
        XCTAssertEqual(out.pitch, 0)    // inside deadzone
    }

    // MARK: Drift compensation

    func testDriftStepIsCappedByRate() {
        // Far from center: the accumulator moves at most rate·dt per step.
        let d = OrientationPipeline.stepDrift(0, towards: 30, rate: 1.0, dt: 0.04)
        XCTAssertEqual(d, 0.04, accuracy: 1e-12)
    }

    func testDriftConvergesToHeldYaw() {
        // Holding 5° for long enough pulls the output (yaw - drift) back to 0.
        var drift = 0.0
        for _ in 0..<200 {
            drift = OrientationPipeline.stepDrift(drift, towards: 5, rate: 1.0, dt: 0.04)
        }
        XCTAssertEqual(drift, 5, accuracy: 1e-9)
    }

    func testDriftFollowsSignChanges() {
        var drift = OrientationPipeline.stepDrift(0, towards: -10, rate: 2.0, dt: 0.1)
        XCTAssertEqual(drift, -0.2, accuracy: 1e-12)
        drift = OrientationPipeline.stepDrift(drift, towards: drift, rate: 2.0, dt: 0.1)
        XCTAssertEqual(drift, -0.2, accuracy: 1e-12)   // at target → no movement
    }

    // MARK: opentrack packet

    func testOpenTrackPacketIsFortyEightLittleEndianBytes() {
        let data = OpenTrackUDPSender.packet(yaw: 1.5, pitch: -2.5, roll: 3.5)
        XCTAssertEqual(data.count, 48)
        let values = data.withUnsafeBytes { raw -> [Double] in
            (0..<6).map { i in
                let bits = raw.loadUnaligned(fromByteOffset: i * 8, as: UInt64.self)
                return Double(bitPattern: UInt64(littleEndian: bits))
            }
        }
        XCTAssertEqual(values, [0, 0, 0, 1.5, -2.5, 3.5])
    }

    // MARK: relay packet

    func testRelayPacketIsSixtyFourLittleEndianBytes() {
        let data = RelayUDPSender.packet(
            seq: 0x0102_0304, micros: 0x1122_3344_5566_7788,
            euler: Euler(yaw: 1.5, pitch: -2.5, roll: 3.5),
            rates: Euler(yaw: 10, pitch: -20, roll: 30)
        )
        XCTAssertEqual(data.count, 64)
        XCTAssertEqual(Array(data.prefix(4)), Array("AHR1".utf8))
        XCTAssertEqual(Array(data[4..<8]), [0x04, 0x03, 0x02, 0x01])
        XCTAssertEqual(Array(data[8..<16]), [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11])
        let values = data.withUnsafeBytes { raw -> [Double] in
            (0..<6).map { i in
                let bits = raw.loadUnaligned(fromByteOffset: 16 + i * 8, as: UInt64.self)
                return Double(bitPattern: UInt64(littleEndian: bits))
            }
        }
        XCTAssertEqual(values, [1.5, -2.5, 3.5, 10, -20, 30])
    }

    func testPipelineCarriesSensorTimeAndRates() {
        let pipeline = OrientationPipeline()
        let done = expectation(description: "frame")
        nonisolated(unsafe) var received: TrackingFrame?
        pipeline.onFrame = { received = $0; done.fulfill() }
        pipeline.ingest(MotionSample(quaternion: simd_quatd(ix: 0, iy: 0, iz: 0, r: 1),
                                     rotationRate: SIMD3(0, 0, 1), userAcceleration: .zero,
                                     timestamp: 1234.5))
        wait(for: [done], timeout: 1)
        XCTAssertEqual(received?.sensorTime, 1234.5)
        XCTAssertEqual(received?.eulerRates.yaw ?? 0, 180 / .pi, accuracy: 0.1)
    }

    // MARK: Euler rates

    private let degrees = Double.pi / 180

    /// The rate must predict where the output transform lands a moment later.
    private func assertRatesMatchFiniteDifference(q: simd_quatd, gyro: SIMD3<Double>, config: AxisConfig,
                                                  file: StaticString = #filePath, line: UInt = #line) {
        let h = 0.001
        let rotation = gyro * h
        let step = simd_quatd(angle: simd_length(rotation), axis: simd_normalize(rotation))
        let a = OrientationPipeline.euler(from: q, config: config)
        let b = OrientationPipeline.euler(from: simd_normalize(q * step), config: config)
        let rates = OrientationPipeline.eulerRates(from: q, gyro: gyro, config: config)
        XCTAssertEqual(rates.yaw, (b.yaw - a.yaw) / h, accuracy: 0.5, file: file, line: line)
        XCTAssertEqual(rates.pitch, (b.pitch - a.pitch) / h, accuracy: 0.5, file: file, line: line)
        XCTAssertEqual(rates.roll, (b.roll - a.roll) / h, accuracy: 0.5, file: file, line: line)
    }

    func testPureYawGyroGivesYawRateOnly() {
        let rates = OrientationPipeline.eulerRates(
            from: simd_quatd(ix: 0, iy: 0, iz: 0, r: 1), gyro: SIMD3(0, 0, 100 * degrees), config: AxisConfig())
        XCTAssertEqual(rates.yaw, 100, accuracy: 0.1)
        XCTAssertEqual(rates.pitch, 0, accuracy: 0.1)
        XCTAssertEqual(rates.roll, 0, accuracy: 0.1)
    }

    func testRatesFollowAxisConfigAndTiltedHead() {
        var config = AxisConfig()
        config.invertYaw = true
        config.scalePitch = 2
        let tilted = simd_quatd(angle: 30 * degrees, axis: SIMD3(0, 0, 1))
            * simd_quatd(angle: 20 * degrees, axis: SIMD3(1, 0, 0))
        assertRatesMatchFiniteDifference(q: tilted, gyro: SIMD3(0.5, -0.3, 1.2), config: config)
    }

    func testZeroGyroGivesZeroRates() {
        let rates = OrientationPipeline.eulerRates(
            from: simd_quatd(ix: 0, iy: 0, iz: 0, r: 1), gyro: .zero, config: AxisConfig())
        XCTAssertEqual(rates, Euler(yaw: 0, pitch: 0, roll: 0))
    }

    func testRateAcrossYawSeamStaysSmall() {
        let nearSeam = simd_quatd(angle: 179.9 * degrees, axis: SIMD3(0, 0, 1))
        let rates = OrientationPipeline.eulerRates(from: nearSeam, gyro: SIMD3(0, 0, 100 * degrees), config: AxisConfig())
        XCTAssertEqual(rates.yaw, 100, accuracy: 0.5)
    }

    // MARK: JSON schema parity

    func testJSONHasSonyParityFields() throws {
        let frame = TrackingFrame(
            quaternion: simd_quatd(ix: 0, iy: 0, iz: 0, r: 1),
            euler: Euler(yaw: 1, pitch: 2, roll: 3),
            rotationRate: SIMD3(0.1, 0.2, 0.3),
            userAcceleration: SIMD3(0.4, 0.5, 0.6),
            packetsPerSecond: 25,
            resetCounter: 4,
            axisConfig: AxisConfig(),
            smoothing: 0.18,
            driftCompensation: 0
        )
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: frame.jsonData()) as? [String: Any])
        for key in ["version", "device", "rotationVector", "quaternion", "yprDegrees",
                    "gyroscope", "accelerometer", "angularVelocity", "resetCounter",
                    "packetsPerSecond", "receiveLatencyMs"] {
            XCTAssertNotNil(obj[key], "missing \(key)")
        }
        XCTAssertEqual(obj["resetCounter"] as? Int, 4)
        XCTAssertEqual(obj["version"] as? Int, 2)
    }

    func testWebViewerDataHasSettings() throws {
        let frame = TrackingFrame(
            quaternion: simd_quatd(ix: 0, iy: 0, iz: 0, r: 1),
            euler: Euler(yaw: 0, pitch: 0, roll: 0),
            rotationRate: .zero, userAcceleration: .zero,
            packetsPerSecond: 0, resetCounter: 0, axisConfig: AxisConfig(), smoothing: 0.18,
            driftCompensation: 0
        )
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: frame.webViewerData()) as? [String: Any])
        let settings = try XCTUnwrap(obj["settings"] as? [String: Any])
        XCTAssertEqual(settings["invertPitch"] as? Bool, true)
        XCTAssertNotNil(settings["yawSource"])
        XCTAssertNotNil(settings["deadzone"])
        XCTAssertNotNil(settings["expo"])
        XCTAssertNotNil(settings["driftCompensation"])
    }

    // MARK: TrackerSettings round-trip

    func testSettingsCodableRoundTrip() throws {
        var s = TrackerSettings()
        s.openTrackHost = "192.168.1.42"
        s.openTrackPort = 5005
        s.axis.rollSource = .yaw
        s.axis.scalePitch = 1.7
        s.axis.deadzone = 2.5
        s.axis.expo = 0.4
        s.driftCompensation = 1.5
        s.recenterOnConnect = false
        let data = SettingsStore.encode(s)
        let back = try XCTUnwrap(SettingsStore.decode(data))
        XCTAssertEqual(s, back)
    }

    func testSettingsFromOlderVersionStillDecode() throws {
        // A 1.1.0 config has none of the 1.2.0 keys; it must load with defaults.
        let old = """
        {"openTrackHost":"10.0.0.7","openTrackPort":4242,"smoothing":0.3,
         "axis":{"yawSource":"yaw","pitchSource":"pitch","rollSource":"roll",
                 "invertYaw":false,"invertPitch":true,"invertRoll":false,
                 "scaleYaw":1,"scalePitch":1,"scaleRoll":1}}
        """
        let s = try XCTUnwrap(SettingsStore.decode(Data(old.utf8)))
        XCTAssertEqual(s.openTrackHost, "10.0.0.7")
        XCTAssertEqual(s.smoothing, 0.3)
        XCTAssertEqual(s.axis.deadzone, 0)
        XCTAssertEqual(s.axis.expo, 0)
        XCTAssertEqual(s.driftCompensation, 0)
        XCTAssertTrue(s.recenterOnConnect)
        XCTAssertEqual(s.relayPort, 4250)
        XCTAssertTrue(s.silentKeepAlive)
    }

    // MARK: slerp

    func testSlerpMidpoint() {
        let a = simd_quatd(angle: 0, axis: SIMD3(0, 0, 1))
        let b = simd_quatd(angle: .pi / 2, axis: SIMD3(0, 0, 1))
        let mid = QuaternionMath.slerp(a, b, 0.5)
        let e = QuaternionMath.opentrackEuler(mid)
        XCTAssertEqual(e.yaw, 45, accuracy: 1e-6)
    }
}
