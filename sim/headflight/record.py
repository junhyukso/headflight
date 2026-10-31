"""Record the incoming pose stream to CSV, for replay and for checking a link."""

import csv
import socket
import time
from dataclasses import astuple, fields, replace

from .protocol import SIZE, Pose, pack, parse

COLUMNS = ["recv_s", *(f.name for f in fields(Pose))]


def record(path: str, port: int, seconds: float) -> int:
    """Write every valid packet received for `seconds`. Returns the packet count."""
    start = time.perf_counter()
    count = 0
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock, open(path, "w", newline="") as f:
        sock.bind(("0.0.0.0", port))
        sock.settimeout(0.25)
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        while time.perf_counter() - start < seconds:
            try:
                data = sock.recv(SIZE + 1)
            except TimeoutError:
                continue
            pose = parse(data)
            if pose is None:
                continue
            writer.writerow([f"{time.perf_counter() - start:.6f}", *astuple(pose)])
            count += 1
    return count


def load(path: str) -> list[tuple[float, Pose]]:
    """Read a recording back as (receive time, pose) pairs."""
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        out.append((float(r["recv_s"]), Pose(
            int(r["seq"]), int(r["sensor_us"]),
            float(r["yaw"]), float(r["pitch"]), float(r["roll"]),
            float(r["yaw_rate"]), float(r["pitch_rate"]), float(r["roll_rate"]),
        )))
    return out


def replay(path: str, host: str, port: int, loop: bool) -> None:
    """Send a recording at its original pacing, standing in for the AirPods."""
    rows = load(path)
    print(f"replaying {len(rows)} packets to {host}:{port}")
    span_us = rows[-1][1].sensor_us - rows[0][1].sensor_us + 40000
    seq = 0
    laps = 0
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        while True:
            start = time.perf_counter()
            for recv_s, pose in rows:
                time.sleep(max(0.0, start + recv_s - rows[0][0] - time.perf_counter()))
                seq += 1
                sensor_us = pose.sensor_us + laps * span_us     # stays monotonic across laps
                sock.sendto(pack(replace(pose, seq=seq, sensor_us=sensor_us)), (host, port))
            if not loop:
                return
            laps += 1
