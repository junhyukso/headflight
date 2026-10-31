"""A phone as a test stick: serves a tilt-control page and collects its input over LAN.

iOS only gives motion sensors to HTTPS pages, so this runs TLS with a self-signed certificate.
It takes nothing but clamped stick values, and only the viewer's flight model reads them.
"""

import json
import math
import shutil
import socket
import ssl
import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .monitor import WEB_ROOT

CERT_DIR = Path(__file__).resolve().parents[1] / ".phone-cert"
CONNECTED_S = 1.0


@dataclass
class Stick:
    roll: float = 0.0       # -1 left .. 1 right
    pitch: float = 0.0      # -1 push .. 1 pull
    throttle: float = 0.6   # 0 .. 1
    resets: int = 0         # bumps each time the phone asks to reset the aircraft
    yaw: float = 0.0        # -1 left .. 1 right
    shots: int = 0          # bumps on each press of the fire button, so a quick tap isn't missed
    uses: int = 0           # bumps on each tap of USE
    backs: int = 0          # and on each hold of it


def parse_stick(body: bytes) -> Stick | None:
    try:
        values = json.loads(body)
        roll, pitch, throttle = (float(values[key]) for key in ("roll", "pitch", "throttle"))
        yaw = float(values.get("yaw", 0))
        resets = int(values.get("resets", 0))
        shots = int(values.get("shots", 0))
        uses = int(values.get("uses", 0))
        backs = int(values.get("backs", 0))
    except (ValueError, KeyError, TypeError, AttributeError):
        return None
    if not all(math.isfinite(v) for v in (roll, pitch, yaw, throttle)):
        return None
    axis = lambda value: max(-1.0, min(1.0, value))
    return Stick(axis(roll), axis(pitch), max(0.0, min(1.0, throttle)), resets, axis(yaw), shots, uses, backs)


def lan_address() -> str:
    """This machine's address on the network. Connecting a UDP socket sends nothing."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("10.255.255.255", 1))
            return probe.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def ensure_certificate(address: str, directory: Path = CERT_DIR) -> tuple[Path, Path] | None:
    """Make a self-signed certificate once. Returns None without openssl to make it with."""
    cert, key = directory / "cert.pem", directory / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    if shutil.which("openssl") is None:
        return None
    directory.mkdir(exist_ok=True)
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
         "-days", "825", "-subj", "/CN=HeadFlight", "-addext", f"subjectAltName=IP:{address}"],
        check=True, capture_output=True,
    )
    key.chmod(0o600)
    return cert, key


class PhoneServer:
    def __init__(self, port: int, cert: Path, key: str | Path) -> None:
        self.address = lan_address()
        self.url = f"https://{self.address}:{port}"
        self._stick = Stick()
        self._seen = -math.inf
        phone = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"   # keep-alive: a new TLS handshake per sample would lag

            def log_message(self, *args) -> None:
                pass

            def handle(self) -> None:
                try:
                    super().handle()
                except (ssl.SSLError, ConnectionError, TimeoutError):
                    pass    # phones hang up, and refuse the certificate until it is accepted

            def do_GET(self) -> None:
                if self.path.split("?")[0] != "/":
                    self.send_error(404)
                    return
                body = (WEB_ROOT / "phone.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path != "/stick":
                    self.send_error(404)
                    return
                stick = parse_stick(body)
                if stick is None:
                    self.send_error(400)
                    return
                phone._stick = stick
                phone._seen = time.perf_counter()
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()

        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        self._server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        self._server.daemon_threads = True
        # Handshake in the connection's own thread, so one stalled phone cannot block the rest.
        self._server.socket = context.wrap_socket(self._server.socket, server_side=True, do_handshake_on_connect=False)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def snapshot(self, now: float) -> dict:
        return {**asdict(self._stick), "connected": now - self._seen < CONNECTED_S}

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def start_phone(port: int) -> PhoneServer | None:
    address = lan_address()
    paths = ensure_certificate(address)
    if paths is None:
        print("phone stick unavailable: openssl is needed to make its HTTPS certificate")
        return None
    return PhoneServer(port, *paths)
