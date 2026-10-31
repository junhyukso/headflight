"""Head poses in, view angles out. No I/O, so it runs and tests anywhere."""

from dataclasses import dataclass

from .config import Config
from .mapping import head_to_view
from .protocol import Pose
from .tracker import HeadTracker


@dataclass
class Output:
    head_yaw: float = 0.0       # relative to neutral, degrees, in the sender's signs
    head_pitch: float = 0.0
    view_yaw: float = 0.0       # degrees right of the nose
    view_pitch: float = 0.0     # degrees above the nose
    tracking: bool = False
    paused: bool = False
    age_ms: float = 0.0         # newest sample's delivery delay above the fastest seen


class HeadView:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.tracker = HeadTracker(cfg.filter)
        self.paused = False
        self.neutral_yaw = 0.0
        self.neutral_pitch = 0.0
        self._settled_s = 0.0
        self._recenter_pending = True
        self._last_tick: float | None = None
        self._fade = 0.0            # 1 = following the head, 0 = eased back to center

    def configure(self, cfg: Config) -> None:
        """Apply new settings live, keeping filter state."""
        self.cfg = cfg
        self.tracker.configure(cfg.filter)

    def recenter(self) -> None:
        self._recenter_pending = True

    def toggle_pause(self) -> None:
        self.paused = not self.paused

    def on_pose(self, pose: Pose, recv_s: float) -> None:
        if self.tracker.is_new_session(pose, recv_s):
            self.tracker.start_session()
            self._recenter_pending = True
        self.tracker.on_pose(pose, recv_s)

    def _track_neutral(self, head_yaw: float, head_pitch: float, speed: float, dt: float) -> tuple[float, float]:
        """Slowly absorb sensor drift while the player is looking at the screen."""
        ac = self.cfg.auto_center
        near = abs(head_yaw) < ac.window_deg and abs(head_pitch) < ac.window_deg
        if not ac.enabled or not near or speed > ac.max_speed:
            self._settled_s = 0.0
            return head_yaw, head_pitch
        self._settled_s += dt
        if self._settled_s < ac.settle_s:
            return head_yaw, head_pitch
        step = ac.rate * dt
        d_yaw = max(-step, min(step, head_yaw))
        d_pitch = max(-step, min(step, head_pitch))
        self.neutral_yaw += d_yaw
        self.neutral_pitch += d_pitch
        return head_yaw - d_yaw, head_pitch - d_pitch

    def tick(self, now: float) -> Output:
        dt = 0.0 if self._last_tick is None else now - self._last_tick
        self._last_tick = now

        yaw, pitch, speed = self.tracker.sample(now)
        tracking = self.tracker.tracking(now)
        if tracking and self._recenter_pending:
            self.neutral_yaw, self.neutral_pitch = yaw, pitch
            self._recenter_pending = False

        head_yaw = yaw - self.neutral_yaw
        head_pitch = pitch - self.neutral_pitch
        if tracking and not self.paused:
            head_yaw, head_pitch = self._track_neutral(head_yaw, head_pitch, speed, dt)

        # Losing the head mid-look must not leave the view stuck off to one side.
        fade_s = self.cfg.filter.fade_ms / 1000
        target = 1.0 if tracking and not self.paused else 0.0
        step = dt / fade_s if fade_s > 0 else 1.0
        self._fade += max(-step, min(step, target - self._fade))

        view_yaw = head_to_view(self.cfg.yaw, head_yaw * self._fade)
        view_pitch = head_to_view(self.cfg.pitch, head_pitch * self._fade)
        return Output(head_yaw, head_pitch, view_yaw, view_pitch, tracking, self.paused, self.tracker.age_ms)
