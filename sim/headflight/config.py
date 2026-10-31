"""Settings. headflight.toml overrides these defaults; headflight.example.toml documents them."""

import os
import re
import tomllib
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path


@dataclass
class Network:
    port: int = 4250            # head packets from the sender
    web_port: int = 4251        # the simulator page, this machine only
    phone_port: int = 4252      # the stick page, for a phone on the LAN


@dataclass
class Filter:
    rate_hz: float = 120        # how often the view is updated
    lookahead_ms: float = 60    # how far ahead of the newest sensor sample to aim
    max_extrapolate_ms: float = 120  # stop dead-reckoning after this long without data
    blend_ms: float = 35        # time to hide the correction when a new sample arrives
    rate_floor: float = 1.5     # deg/s of gyro treated as noise
    min_cutoff_hz: float = 2.0  # low-pass cutoff while the head is still
    beta: float = 0.1           # cutoff added per deg/s of head speed
    stale_ms: float = 400       # no packets for this long counts as lost tracking
    fade_ms: float = 300        # then ease the view back to center over this time


@dataclass
class Axis:
    invert: bool = False
    sensitivity: float = 1.0    # scales head movement before the curve
    deadzone: float = 1.0       # head degrees around center that do nothing
    curve: list = field(default_factory=lambda: [[0, 0], [90, 90]])  # head deg -> view deg


def _yaw() -> Axis:
    # Yaw arrives as left-positive; the view wants right-positive.
    return Axis(invert=True, sensitivity=0.7, curve=[[0, 0], [10, 25], [25, 85], [45, 150], [70, 175]])


def _pitch() -> Axis:
    # Reversed in a live AirPods Pro test: pitch arrives down-positive, the view wants up-positive.
    return Axis(invert=True, sensitivity=0.55, curve=[[0, 0], [10, 20], [25, 60], [35, 90]])


@dataclass
class AutoCenter:
    enabled: bool = True
    window_deg: float = 3.0     # only right at center: following something slowly is not looking ahead
    max_speed: float = 5.0      # deg/s; the head must be settled
    settle_s: float = 2.0       # for this long before correcting
    rate: float = 0.15          # deg/s pull of neutral toward the current pose


@dataclass
class Config:
    network: Network = field(default_factory=Network)
    filter: Filter = field(default_factory=Filter)
    yaw: Axis = field(default_factory=_yaw)
    pitch: Axis = field(default_factory=_pitch)
    auto_center: AutoCenter = field(default_factory=AutoCenter)


def _merge(target, values: dict, where: str) -> None:
    known = {f.name for f in fields(target)}
    for key, value in values.items():
        if key not in known:
            raise ValueError(f"unknown setting: {where}{key}")
        current = getattr(target, key)
        if is_dataclass(current):
            _merge(current, value, f"{where}{key}.")
        else:
            setattr(target, key, value)


def _validate_table(table: list, name: str) -> None:
    xs = [p[0] for p in table]
    if len(table) < 2 or xs[0] != 0 or any(b <= a for a, b in zip(xs, xs[1:])):
        raise ValueError(f"{name}: needs 2+ points, starting at 0, with increasing inputs")


def from_dict(values: dict) -> Config:
    cfg = Config()
    _merge(cfg, values, "")
    for name in ("yaw", "pitch"):
        axis = getattr(cfg, name)
        _validate_table(axis.curve, f"{name}.curve")
        if axis.sensitivity <= 0:
            raise ValueError(f"{name}.sensitivity must be above 0")
        if axis.deadzone < 0:
            raise ValueError(f"{name}.deadzone must not be negative")
    return cfg


def load(path: str) -> Config:
    """Settings from `path`, or the defaults if it does not exist."""
    if not os.path.exists(path):
        return Config()
    with open(path, "rb") as f:
        return from_dict(tomllib.load(f))


def save_value(path: str, section: str, key: str, value: float) -> None:
    """Set one number in a TOML file, leaving every other line and its comments alone."""
    file = Path(path)
    lines = file.read_text(encoding="utf-8").splitlines() if file.exists() else []
    setting = f"{key} = {value}"
    is_header = re.compile(r"\s*\[[\w.-]+\]\s*(#.*)?$").match
    is_key = re.compile(rf"\s*{re.escape(key)}\s*=").match

    start = next((i for i, line in enumerate(lines)
                  if is_header(line) and line.split("#")[0].strip() == f"[{section}]"), None)
    if start is None:
        lines += ["", f"[{section}]", setting] if lines else [f"[{section}]", setting]
    else:
        end = next((i for i in range(start + 1, len(lines)) if is_header(lines[i])), len(lines))
        existing = next((i for i in range(start + 1, end) if is_key(lines[i])), None)
        if existing is None:
            lines.insert(start + 1, setting)
        else:
            lines[existing] = re.sub(r"(=\s*)[^#\s]+", rf"\g<1>{value}", lines[existing], count=1)
    file.write_text("\n".join(lines) + "\n", encoding="utf-8")
