"""Wire format of the sender's head packets (sender: Net/RelayUDPSender.swift)."""

import struct
from dataclasses import dataclass

MAGIC = b"AHR1"
DEFAULT_PORT = 4250

_PACKET = struct.Struct("<4sIQ6d")
SIZE = _PACKET.size


@dataclass(frozen=True)
class Pose:
    """One head sample. Angles in degrees, rates in degrees/second.

    Signs are the sender's: yaw+ = look left, roll+ = tilt right. It documents pitch+ as look
    up, but a live AirPods Pro test showed the opposite, so config.py inverts pitch.
    """

    seq: int
    sensor_us: int
    yaw: float
    pitch: float
    roll: float
    yaw_rate: float
    pitch_rate: float
    roll_rate: float


def parse(data: bytes) -> Pose | None:
    """Decode a datagram, or return None if it is not a head packet."""
    if len(data) != SIZE or not data.startswith(MAGIC):
        return None
    return Pose(*_PACKET.unpack(data)[1:])


def pack(pose: Pose) -> bytes:
    return _PACKET.pack(
        MAGIC, pose.seq, pose.sensor_us, pose.yaw, pose.pitch, pose.roll,
        pose.yaw_rate, pose.pitch_rate, pose.roll_rate,
    )
