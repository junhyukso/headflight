"""The running server: head packets in, simulator page and phone stick out."""

import os
import socket
import time

from . import config, qr
from .core import HeadView, Output
from .monitor import Monitor, Tune
from .phone import start_phone
from .protocol import SIZE, parse


class ConfigWatcher:
    """Reloads the settings file when it changes or first appears, so tuning needs no restart."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._mtime = self._stamp()

    def _stamp(self) -> float | None:
        try:
            return os.path.getmtime(self.path)
        except OSError:
            return None

    def changed(self) -> config.Config | None:
        stamp = self._stamp()
        if stamp == self._mtime:
            return None
        self._mtime = stamp
        try:
            cfg = config.load(self.path)
        except (OSError, ValueError) as e:
            print(f"\nignored {self.path}: {e}")
            return None
        print(f"\nreloaded {self.path}")
        return cfg

    def save(self, section: str, key: str, value: float) -> None:
        """Write one setting without mistaking our own write for an outside edit."""
        config.save_value(self.path, section, key, value)
        self._mtime = self._stamp()


def apply_tune(view: HeadView, watcher: ConfigWatcher, tune: Tune) -> None:
    """Change sensitivity at once, then keep it for the next run."""
    getattr(view.cfg, tune.axis).sensitivity = tune.sensitivity
    try:
        watcher.save(tune.axis, "sensitivity", tune.sensitivity)
    except OSError as e:
        print(f"\ncould not save {watcher.path}: {e}")


class Rate:
    """Packets per second over the last second."""

    def __init__(self) -> None:
        self._times: list[float] = []

    def add(self, now: float) -> None:
        self._times.append(now)

    def value(self, now: float) -> int:
        self._times = [t for t in self._times if now - t < 1.0]
        return len(self._times)


def open_socket(port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))
    sock.setblocking(False)
    return sock


def status_line(out: Output, pps: int) -> str:
    state = "PAUSED" if out.paused else "tracking" if out.tracking else "NO DATA"
    return f"\r{state:8s} {pps:3d} pkt/s  head {out.head_yaw:+6.1f} {out.head_pitch:+6.1f}  view {out.view_yaw:+7.1f} {out.view_pitch:+6.1f}  "


def run(cfg_path: str, phone_on: bool) -> None:
    cfg = config.load(cfg_path)
    view = HeadView(cfg)
    watcher = ConfigWatcher(cfg_path)
    sock = open_socket(cfg.network.port)
    monitor = Monitor(cfg.network.web_port)
    phone = start_phone(cfg.network.phone_port) if phone_on else None
    rate = Rate()

    print(f"head packets: UDP {cfg.network.port}")
    print(f"simulator: http://127.0.0.1:{cfg.network.web_port}")
    if phone:
        print(f"phone stick: scan this, or open {phone.url}")
        print(qr.terminal(phone.url))
        monitor.phone_qr = qr.svg(phone.url)

    period = 1 / cfg.filter.rate_hz
    next_tick = time.perf_counter()
    next_slow = next_tick
    try:
        while True:
            now = time.perf_counter()
            while True:
                try:
                    pose = parse(sock.recv(SIZE + 1))
                except (BlockingIOError, ConnectionError):
                    break
                if pose is not None:
                    view.on_pose(pose, now)
                    rate.add(now)

            while not monitor.commands.empty():
                command = monitor.commands.get()
                if command == "recenter":
                    view.recenter()
                elif command == "pause":
                    view.toggle_pause()
                else:
                    apply_tune(view, watcher, command)

            out = view.tick(now)
            monitor.publish({
                "headYaw": out.head_yaw, "headPitch": out.head_pitch,
                "viewYaw": out.view_yaw, "viewPitch": out.view_pitch,
                "tracking": out.tracking, "paused": out.paused,
                "pps": rate.value(now), "ageMs": out.age_ms,
                "yawSensitivity": view.cfg.yaw.sensitivity, "pitchSensitivity": view.cfg.pitch.sensitivity,
                "phone": phone.snapshot(now) if phone else None, "phoneUrl": phone.url if phone else None,
                "sentMs": time.time() * 1000,
            })

            if now >= next_slow:
                next_slow = now + 0.5
                print(status_line(out, rate.value(now)), end="", flush=True)
                reloaded = watcher.changed()
                if reloaded:
                    view.configure(reloaded)
                    period = 1 / reloaded.filter.rate_hz

            next_tick = max(next_tick + period, time.perf_counter())
            time.sleep(max(0.0, next_tick - time.perf_counter()))
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        sock.close()
        monitor.close()
        if phone:
            phone.close()
