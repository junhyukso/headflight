"""Serves the simulator page and streams head and stick state to it as server-sent events."""

import json
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple

WEB_ROOT = Path(__file__).with_name("web")
WEB_FILES = {
    "/": ("viewer.html", "text/html; charset=utf-8"),
    "/cockpit.js": ("cockpit.js", "text/javascript; charset=utf-8"),
    "/fight.js": ("fight.js", "text/javascript; charset=utf-8"),
    "/avionics.js": ("avionics.js", "text/javascript; charset=utf-8"),
    "/classic.js": ("classic.js", "text/javascript; charset=utf-8"),
    "/hud.js": ("hud.js", "text/javascript; charset=utf-8"),
    "/switches.js": ("switches.js", "text/javascript; charset=utf-8"),
    "/panel.js": ("panel.js", "text/javascript; charset=utf-8"),
    "/sound.js": ("sound.js", "text/javascript; charset=utf-8"),
    "/three.module.min.js": ("three.module.min.js", "text/javascript; charset=utf-8"),
}
SENSITIVITY_RANGE = (0.1, 3.0)


class Tune(NamedTuple):
    axis: str
    sensitivity: float


def parse_tune(body: bytes) -> Tune | None:
    try:
        values = json.loads(body)
        tune = Tune(values["axis"], float(values["sensitivity"]))
    except (ValueError, KeyError, TypeError):
        return None
    low, high = SENSITIVITY_RANGE
    return tune if tune.axis in ("yaw", "pitch") and low <= tune.sensitivity <= high else None


class Monitor:
    """Latest-value mailbox between the main loop and any open page."""

    def __init__(self, port: int) -> None:
        self.port = port
        self.commands: queue.SimpleQueue[str | Tune] = queue.SimpleQueue()
        self.phone_qr: str | None = None    # SVG, set when the phone stick is running
        radio_files = {path.name for path in (WEB_ROOT / "radio").glob("*.m4a")}
        self._state = "{}"
        self._version = 0
        self._changed = threading.Condition()
        monitor = self

        class Handler(BaseHTTPRequestHandler):
            disable_nagle_algorithm = True  # state updates are tiny and must not wait for each other

            def log_message(self, *args) -> None:
                pass

            def do_GET(self) -> None:
                route = self.path.split("?")[0]
                if route == "/events":
                    self._events()
                elif route in WEB_FILES:
                    name, content_type = WEB_FILES[route]
                    self._send((WEB_ROOT / name).read_bytes(), content_type)
                elif route.startswith("/radio/") and route.removeprefix("/radio/") in radio_files:
                    self._send((WEB_ROOT / route.lstrip("/")).read_bytes(), "audio/mp4")
                elif route == "/phone-qr.svg" and monitor.phone_qr:
                    self._send(monitor.phone_qr.encode(), "image/svg+xml")
                else:
                    self.send_error(404)

            def _send(self, body: bytes, content_type: str) -> None:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:
                if self.path in ("/recenter", "/pause"):
                    monitor.commands.put(self.path[1:])
                    self.send_response(204)
                    self.end_headers()
                elif self.path == "/tune":
                    self._tune()
                else:
                    self.send_error(404)

            def _tune(self) -> None:
                # Requiring JSON makes browsers preflight, so other sites cannot post here.
                if self.headers.get("Content-Type") != "application/json":
                    self.send_error(415)
                    return
                tune = parse_tune(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if tune is None:
                    self.send_error(400)
                    return
                monitor.commands.put(tune)
                self.send_response(204)
                self.end_headers()

            def _events(self) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                seen = -1
                try:
                    while True:
                        state, seen = monitor._next_state(seen)
                        self.wfile.write(f"data: {state}\n\n".encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionError):
                    pass

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def publish(self, state: dict) -> None:
        text = json.dumps(state)
        with self._changed:
            self._state = text
            self._version += 1
            self._changed.notify_all()

    def _next_state(self, seen: int) -> tuple[str, int]:
        """Blocks until there is a state newer than `seen`, so each update leaves as it is made."""
        with self._changed:
            self._changed.wait_for(lambda: self._version != seen, timeout=1)
            return self._state, self._version

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
