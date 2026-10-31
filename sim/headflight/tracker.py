"""Turns bursty 25 Hz head samples into a smooth, low-latency pose at any instant."""

import math

from .config import Filter


class SensorClock:
    """Maps sensor timestamps onto the local clock, cancelling delivery jitter.

    Samples are taken every 40 ms but arrive in bursts, so the smallest delay seen is the
    best estimate of the true path delay. It creeps upward so clock skew cannot pin it.
    """

    CREEP = 0.001   # seconds per second, well above real clock skew
    RESET = 2.0     # a delay this far off means the sensor clock restarted

    def __init__(self) -> None:
        self._offset: float | None = None
        self._last_recv = 0.0

    def to_local(self, sensor_s: float, recv_s: float) -> float:
        delay = recv_s - sensor_s
        if self._offset is None or abs(delay - self._offset) > self.RESET:
            self._offset = delay
        elif delay < self._offset:
            self._offset = delay
        else:
            self._offset += self.CREEP * (recv_s - self._last_recv)
        self._last_recv = recv_s
        return sensor_s + self._offset


class AxisPredictor:
    """Dead-reckons one angle from its last sample and gyro rate.

    A new sample usually disagrees slightly with the prediction. Applying it directly would
    step the view 25 times a second, so the difference fades out over blend_ms instead.
    """

    def __init__(self, f: Filter) -> None:
        self._f = f
        self._t: float | None = None
        self._value = 0.0
        self._rate = 0.0
        self._error = 0.0
        self._error_t = 0.0

    def _dead_reckoned(self, now: float) -> float:
        lookahead = self._f.lookahead_ms / 1000
        horizon = (now - self._t) + lookahead
        horizon = max(0.0, min(horizon, lookahead + self._f.max_extrapolate_ms / 1000))
        return self._value + self._rate * horizon

    def estimate(self, now: float) -> float:
        if self._t is None:
            return 0.0
        fade = math.exp(-(now - self._error_t) / (self._f.blend_ms / 1000))
        return self._dead_reckoned(now) + self._error * fade

    def update(self, sample_t: float, value: float, rate: float, now: float) -> None:
        seeded = self._t is not None
        before = self.estimate(now) if seeded else 0.0
        floor = self._f.rate_floor
        self._t = sample_t
        self._value = value
        self._rate = math.copysign(max(0.0, abs(rate) - floor), rate)
        self._error = before - self._dead_reckoned(now) if seeded else 0.0
        self._error_t = now

    @property
    def rate(self) -> float:
        return self._rate


class AdaptiveLowpass:
    """One-pole low-pass that opens up with head speed: still when still, fast when fast."""

    def __init__(self, f: Filter) -> None:
        self._f = f
        self._y: float | None = None

    def step(self, x: float, speed: float, dt: float) -> float:
        if self._y is None:
            self._y = x
            return x
        cutoff = self._f.min_cutoff_hz + self._f.beta * abs(speed)
        self._y += (1 - math.exp(-2 * math.pi * cutoff * dt)) * (x - self._y)
        return self._y

    def reset(self, value: float) -> None:
        self._y = value


class HeadTracker:
    """Yaw and pitch estimate, with sequence and staleness handling."""

    SESSION_GAP_S = 3.0     # short dropouts must not move neutral while looking away

    def __init__(self, f: Filter) -> None:
        self._f = f
        self._last_recv: float | None = None
        self._last_tick: float | None = None
        self.age_ms = 0.0
        self.start_session()

    def start_session(self) -> None:
        """Forget the old estimate, so nothing blends from a pose that no longer applies."""
        self._clock = SensorClock()
        self.yaw = AxisPredictor(self._f)
        self.pitch = AxisPredictor(self._f)
        self._yaw_lp = AdaptiveLowpass(self._f)
        self._pitch_lp = AdaptiveLowpass(self._f)
        self._last_seq: int | None = None

    def configure(self, f: Filter) -> None:
        """Swap filter settings without losing the current estimate."""
        self._f = f
        for part in (self.yaw, self.pitch, self._yaw_lp, self._pitch_lp):
            part._f = f

    def is_new_session(self, pose, recv_s: float) -> bool:
        """The sender restarted or was gone long enough that its zero may have moved."""
        if self._last_seq is None:
            return True
        return pose.seq - self._last_seq <= -1000 or self.silence_s(recv_s) > self.SESSION_GAP_S

    def on_pose(self, pose, recv_s: float) -> None:
        if self._last_seq is not None and -1000 < pose.seq - self._last_seq <= 0:
            return  # duplicate or reordered; a large backward jump is a restarted sender
        self._last_seq = pose.seq
        self._last_recv = recv_s
        sample_t = self._clock.to_local(pose.sensor_us / 1e6, recv_s)
        self.age_ms = (recv_s - sample_t) * 1000
        self.yaw.update(sample_t, pose.yaw, pose.yaw_rate, recv_s)
        self.pitch.update(sample_t, pose.pitch, pose.pitch_rate, recv_s)

    def silence_s(self, now: float) -> float:
        """Seconds since the last packet; infinite before the first one."""
        return math.inf if self._last_recv is None else now - self._last_recv

    def tracking(self, now: float) -> bool:
        return self.silence_s(now) * 1000 < self._f.stale_ms

    def sample(self, now: float) -> tuple[float, float, float]:
        """Filtered (yaw, pitch, speed) in degrees and degrees/second."""
        dt = 0.0 if self._last_tick is None else max(0.0, now - self._last_tick)
        self._last_tick = now
        speed = math.hypot(self.yaw.rate, self.pitch.rate)
        yaw = self._yaw_lp.step(self.yaw.estimate(now), speed, dt)
        pitch = self._pitch_lp.step(self.pitch.estimate(now), speed, dt)
        return yaw, pitch, speed
