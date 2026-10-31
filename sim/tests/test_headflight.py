import csv
import ctypes
import math
import os
import random
import re
import shutil
import socket
import ssl
import struct
import sys
import tempfile
import threading
import time
import tomllib
import types
import unittest
import urllib.error
import urllib.request
from dataclasses import astuple, replace
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from headflight import app, config, monitor, phone, protocol, qr, record
from headflight.config import Config, Filter
from headflight.core import HeadView
from headflight.mapping import head_to_view, lookup
from headflight.protocol import Pose
from headflight.tracker import AdaptiveLowpass, AxisPredictor, HeadTracker, SensorClock

ROOT = Path(__file__).resolve().parents[1]


def pose(seq=1, sensor_s=0.0, yaw=0.0, pitch=0.0, yaw_rate=0.0, pitch_rate=0.0):
    return Pose(seq, int(sensor_s * 1e6), yaw, pitch, 0.0, yaw_rate, pitch_rate, 0.0)


class ProtocolTests(unittest.TestCase):
    def test_round_trip_is_64_bytes(self):
        p = Pose(7, 123456, 1.5, -2.5, 3.5, 10.0, -20.0, 30.0)
        data = protocol.pack(p)
        self.assertEqual(len(data), 64)
        self.assertEqual(protocol.parse(data), p)

    def test_matches_the_swift_sender_layout(self):
        # Same values and byte checks as testRelayPacketIsSixtyFourLittleEndianBytes.
        data = protocol.pack(Pose(0x01020304, 0x1122334455667788, 1.5, -2.5, 3.5, 10.0, -20.0, 30.0))
        self.assertEqual(data[:4], b"AHR1")
        self.assertEqual(data[4:8], bytes([0x04, 0x03, 0x02, 0x01]))
        self.assertEqual(data[8:16], bytes([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]))
        self.assertEqual(struct.unpack("<6d", data[16:]), (1.5, -2.5, 3.5, 10.0, -20.0, 30.0))

    def test_rejects_other_datagrams(self):
        good = protocol.pack(pose())
        self.assertIsNone(protocol.parse(b"XXXX" + good[4:]))
        self.assertIsNone(protocol.parse(good[:-1]))
        self.assertIsNone(protocol.parse(struct.pack("<6d", 0, 0, 0, 1, 2, 3)))


class SensorClockTests(unittest.TestCase):
    def test_cancels_delivery_bursts(self):
        clock = SensorClock()
        rng = random.Random(1)
        errors = []
        for i in range(500):
            sensor = 100 + i * 0.04
            local = clock.to_local(sensor, sensor + 5.0 + rng.choice([0, 0, 0.02, 0.09]))
            errors.append(abs(local - (sensor + 5.0)))
        self.assertLess(max(errors[20:]), 0.004)

    def test_follows_a_clock_running_slow(self):
        clock = SensorClock()
        for i in range(2000):
            sensor = i * 0.04
            local = clock.to_local(sensor, sensor * (1 + 100e-6))
        self.assertAlmostEqual(local, sensor * (1 + 100e-6), delta=0.002)

    def test_resets_when_the_sensor_clock_restarts(self):
        clock = SensorClock()
        clock.to_local(5000.0, 10.0)
        self.assertAlmostEqual(clock.to_local(1.0, 11.0), 11.0)


class PredictorTests(unittest.TestCase):
    def setUp(self):
        self.f = Filter(lookahead_ms=40, max_extrapolate_ms=120, blend_ms=35, rate_floor=0)

    def test_tracks_a_constant_rate_ahead_of_the_sample(self):
        p = AxisPredictor(self.f)
        p.update(0.0, 10.0, 100.0, 0.0)
        self.assertAlmostEqual(p.estimate(0.0), 14.0)
        self.assertAlmostEqual(p.estimate(0.02), 16.0)

    def test_is_continuous_across_a_correcting_sample(self):
        p = AxisPredictor(self.f)
        p.update(0.0, 10.0, 100.0, 0.0)
        before = p.estimate(0.04)
        p.update(0.04, 20.0, 0.0, 0.04)     # far from the prediction
        self.assertAlmostEqual(p.estimate(0.04), before)
        self.assertAlmostEqual(p.estimate(0.4), 20.0, places=2)

    def test_stops_extrapolating_after_a_gap(self):
        p = AxisPredictor(self.f)
        p.update(0.0, 0.0, 100.0, 0.0)
        self.assertAlmostEqual(p.estimate(10.0), p.estimate(20.0))
        self.assertAlmostEqual(p.estimate(10.0), 100.0 * 0.16)

    def test_small_rates_are_ignored(self):
        p = AxisPredictor(replace(self.f, rate_floor=1.5))
        p.update(0.0, 5.0, 1.0, 0.0)
        self.assertEqual(p.estimate(0.05), 5.0)
        p.update(0.04, 5.0, 3.5, 0.04)
        self.assertAlmostEqual(p.rate, 2.0)

    def test_late_sample_is_predicted_forward_from_when_it_was_taken(self):
        p = AxisPredictor(replace(self.f, lookahead_ms=0))
        p.update(0.0, 0.0, 100.0, 0.1)       # arrived 100 ms after the sensor took it
        self.assertAlmostEqual(p._dead_reckoned(0.1), 10.0)


class LowpassTests(unittest.TestCase):
    def test_quiets_noise_when_still_and_follows_when_fast(self):
        f = Filter(min_cutoff_hz=2, beta=0.1)
        rng = random.Random(2)
        still = AdaptiveLowpass(f)
        out = [still.step(rng.gauss(0, 0.2), 0, 1 / 120) for _ in range(600)]
        self.assertLess(max(abs(v) for v in out[100:]), 0.15)

        fast = AdaptiveLowpass(f)
        fast.step(0, 200, 1 / 120)
        for i in range(1, 60):
            y = fast.step(i * 200 / 120, 200, 1 / 120)
        self.assertLess(abs(59 * 200 / 120 - y), 2.0)


class TrackerTests(unittest.TestCase):
    def test_ignores_duplicates_and_reordering(self):
        t = HeadTracker(Filter(lookahead_ms=0, rate_floor=0))
        t.on_pose(pose(5, 1.00, yaw=10), 1.0)
        t.on_pose(pose(5, 1.00, yaw=99), 1.0)
        t.on_pose(pose(4, 0.96, yaw=99), 1.0)
        self.assertAlmostEqual(t.yaw.estimate(1.0), 10)

    def test_accepts_a_restarted_sender(self):
        t = HeadTracker(Filter(lookahead_ms=0, rate_floor=0, blend_ms=1))
        t.on_pose(pose(90000, 1.0, yaw=10), 1.0)
        t.on_pose(pose(1, 1.04, yaw=20), 1.04)
        self.assertAlmostEqual(t.yaw.estimate(2.0), 20)

    def test_sequence_wraparound_is_not_a_duplicate(self):
        t = HeadTracker(Filter(lookahead_ms=0, rate_floor=0, blend_ms=1))
        t.on_pose(pose(2**32 - 1, 1.0, yaw=10), 1.0)
        t.on_pose(pose(0, 1.04, yaw=20), 1.04)
        self.assertAlmostEqual(t.yaw.estimate(2.0), 20)

    def test_staleness(self):
        t = HeadTracker(Filter(stale_ms=400))
        self.assertFalse(t.tracking(0.0))
        t.on_pose(pose(1, 0.0), 1.0)
        self.assertTrue(t.tracking(1.3))
        self.assertFalse(t.tracking(1.5))


class MappingTests(unittest.TestCase):
    def test_lookup_is_odd_symmetric_and_clamps(self):
        table = [[0, 0], [10, 25], [40, 180]]
        self.assertEqual(lookup(table, 0), 0)
        self.assertAlmostEqual(lookup(table, 5), 12.5)
        self.assertAlmostEqual(lookup(table, -5), -12.5)
        self.assertEqual(lookup(table, 90), 180)
        self.assertEqual(lookup(table, -90), -180)

    def test_defaults_follow_the_head(self):
        cfg = Config()
        self.assertGreater(head_to_view(cfg.yaw, -25), 0)       # yaw- = head right = view right
        self.assertLess(head_to_view(cfg.yaw, 25), 0)
        self.assertGreater(head_to_view(cfg.pitch, -20), 0)     # pitch- = head up, as tested live
        self.assertLess(head_to_view(cfg.pitch, 20), 0)

    def test_sensitivity_scales_head_movement_per_axis(self):
        cfg = Config()
        cfg.pitch.sensitivity = 1.0
        cfg.pitch.deadzone = 0.0
        full = head_to_view(cfg.pitch, -10)
        yaw_before = head_to_view(cfg.yaw, -10)
        cfg.pitch.sensitivity = 0.5
        self.assertAlmostEqual(head_to_view(cfg.pitch, -20), full)
        self.assertLess(head_to_view(cfg.pitch, -10), full)
        self.assertEqual(head_to_view(cfg.yaw, -10), yaw_before)

    def test_deadzone_does_nothing_inside_and_never_jumps_at_its_edge(self):
        cfg = Config()
        self.assertEqual(head_to_view(cfg.yaw, 0.9), 0)
        self.assertEqual(head_to_view(cfg.yaw, -0.9), 0)
        just_past = abs(head_to_view(cfg.yaw, -1.01))
        self.assertGreater(just_past, 0)
        self.assertLess(just_past, 0.05)

    def test_view_stops_at_the_end_of_the_curve(self):
        cfg = Config()
        self.assertEqual(head_to_view(cfg.yaw, -500), 180)
        self.assertEqual(head_to_view(cfg.pitch, -500), 90)


class HeadViewTests(unittest.TestCase):
    def feed(self, view, duration, start=0.0, yaw=0.0, pitch=0.0, seq_start=1, hz=120):
        """Steady head pose for `duration`; returns the last output."""
        out = None
        ticks = int(duration * hz)
        for i in range(ticks):
            now = start + i / hz
            if i % (hz // 25) == 0:
                view.on_pose(pose(seq_start + i, now, yaw=yaw, pitch=pitch), now)
            out = view.tick(now)
        return out

    def test_first_pose_becomes_neutral(self):
        view = HeadView(Config())
        out = self.feed(view, 0.5, yaw=30, pitch=-10)
        self.assertAlmostEqual(out.head_yaw, 0, places=1)
        self.assertEqual((out.view_yaw, out.view_pitch), (0, 0))

    def test_recenter_moves_neutral_to_the_current_pose(self):
        view = HeadView(Config())
        self.feed(view, 0.3)
        out = self.feed(view, 1.0, start=0.3, yaw=-20, seq_start=1000)
        self.assertGreater(out.view_yaw, 0)
        view.recenter()
        out = self.feed(view, 0.2, start=1.3, yaw=-20, seq_start=2000)
        self.assertEqual(out.view_yaw, 0)

    def test_pause_eases_to_center(self):
        view = HeadView(Config())
        self.feed(view, 0.3)
        self.feed(view, 1.0, start=0.3, yaw=-20, seq_start=1000)
        view.toggle_pause()
        out = self.feed(view, 1.0, start=1.3, yaw=-20, seq_start=2000)
        self.assertEqual(out.view_yaw, 0)
        self.assertTrue(out.paused)

    def test_lost_tracking_eases_to_center_instead_of_sticking(self):
        view = HeadView(Config())
        self.feed(view, 0.3)
        self.assertGreater(self.feed(view, 1.0, start=0.3, yaw=-20, seq_start=1000).view_yaw, 0)
        now = 1.3
        for i in range(120):
            out = view.tick(now + i / 120)
        self.assertEqual(out.view_yaw, 0)
        self.assertFalse(out.tracking)

    def test_auto_center_absorbs_slow_drift_near_center(self):
        view = HeadView(Config())
        self.feed(view, 0.3)
        out = self.feed(view, 8.0, start=0.3, yaw=2.0, seq_start=1000)
        self.assertLess(abs(out.head_yaw), 0.3)
        self.assertAlmostEqual(view.neutral_yaw, 2.0, delta=0.3)

    def test_auto_center_leaves_a_deliberate_look_alone(self):
        view = HeadView(Config())
        self.feed(view, 0.3)
        out = self.feed(view, 8.0, start=0.3, yaw=25.0, seq_start=1000)
        self.assertAlmostEqual(view.neutral_yaw, 0.0, delta=0.01)
        self.assertAlmostEqual(out.head_yaw, 25.0, delta=0.5)

    def test_auto_center_can_be_disabled(self):
        cfg = Config()
        cfg.auto_center.enabled = False
        view = HeadView(cfg)
        self.feed(view, 0.3)
        self.feed(view, 8.0, start=0.3, yaw=2.0, seq_start=1000)
        self.assertAlmostEqual(view.neutral_yaw, 0.0, delta=0.01)

    def test_restarted_sender_gets_a_new_neutral(self):
        view = HeadView(Config())
        self.feed(view, 0.3, yaw=50, seq_start=100000)
        out = self.feed(view, 0.3, start=0.3, yaw=10, seq_start=1)     # new zero, seq reset
        self.assertAlmostEqual(out.head_yaw, 0, delta=0.5)

    def test_long_silence_gets_a_new_neutral(self):
        view = HeadView(Config())
        self.feed(view, 0.3, yaw=50)
        out = self.feed(view, 0.3, start=4.0, yaw=10, seq_start=5000)
        self.assertAlmostEqual(out.head_yaw, 0, delta=0.5)

    def test_short_dropout_while_looking_away_keeps_neutral(self):
        view = HeadView(Config())
        self.feed(view, 0.3)
        self.feed(view, 1.0, start=0.3, yaw=-20, seq_start=1000)
        out = self.feed(view, 0.5, start=2.3, yaw=-20, seq_start=2000)     # 1 s gap
        self.assertAlmostEqual(out.head_yaw, -20, delta=0.5)

    def test_live_reconfigure_keeps_tracking(self):
        view = HeadView(Config())
        self.feed(view, 0.3)
        cfg = Config()
        cfg.filter.lookahead_ms = 80
        view.configure(cfg)
        self.assertEqual(view.tracker.yaw._f.lookahead_ms, 80)
        self.assertEqual(view.tracker._yaw_lp._f.lookahead_ms, 80)


class ConfigTests(unittest.TestCase):
    def test_example_file_documents_the_defaults_exactly(self):
        with open(ROOT / "headflight.example.toml", "rb") as f:
            values = tomllib.load(f)
        self.assertEqual(config.from_dict(values), Config())

    def test_unknown_key_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "filter.lookahed_ms"):
            config.from_dict({"filter": {"lookahed_ms": 1}})

    def test_table_must_start_at_zero_and_increase(self):
        with self.assertRaisesRegex(ValueError, "yaw.curve"):
            config.from_dict({"yaw": {"curve": [[1, 0], [2, 3]]}})
        with self.assertRaisesRegex(ValueError, "pitch.curve"):
            config.from_dict({"pitch": {"curve": [[0, 0], [5, 1], [5, 2]]}})

    def test_bad_deadzone_values_are_rejected(self):
        with self.assertRaises(ValueError):
            config.from_dict({"yaw": {"deadzone": -1}})
        with self.assertRaises(ValueError):
            config.from_dict({"pitch": {"sensitivity": 0}})


class SaveValueTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "headflight.toml")

    def write(self, text):
        Path(self.path).write_text(text, encoding="utf-8")

    def read(self):
        return Path(self.path).read_text(encoding="utf-8")

    def test_updates_the_value_and_keeps_comments_and_other_sections(self):
        self.write('# café\n[yaw]\nsensitivity = 1.0  # left and right\n\n[pitch]\nsensitivity = 1.0  # up and down\n'
                   'curve = [[0, 0], [10, 20]]\n')
        config.save_value(self.path, "pitch", "sensitivity", 0.6)
        self.assertEqual(self.read(), '# café\n[yaw]\nsensitivity = 1.0  # left and right\n\n[pitch]\nsensitivity = 0.6  # up and down\n'
                                      'curve = [[0, 0], [10, 20]]\n')

    def test_adds_the_key_to_an_existing_section(self):
        self.write('[pitch]\ninvert = false\n\n[keys]\npause = "F9"\n')
        config.save_value(self.path, "pitch", "sensitivity", 0.5)
        values = tomllib.loads(self.read())
        self.assertEqual(values["pitch"], {"sensitivity": 0.5, "invert": False})
        self.assertEqual(values["keys"], {"pause": "F9"})

    def test_adds_a_missing_section(self):
        self.write('[yaw]\ninvert = true\n')
        config.save_value(self.path, "pitch", "sensitivity", 0.5)
        self.assertEqual(tomllib.loads(self.read()), {"yaw": {"invert": True}, "pitch": {"sensitivity": 0.5}})

    def test_creates_the_file(self):
        config.save_value(self.path, "yaw", "sensitivity", 1.25)
        self.assertEqual(config.load(self.path).yaw.sensitivity, 1.25)

    def test_multiline_tables_are_not_mistaken_for_sections(self):
        self.write('[yaw]\ncurve = [\n  [0, 0],\n  [10, 25]\n]\nsensitivity = 1.0\n')
        config.save_value(self.path, "yaw", "sensitivity", 0.8)
        self.assertEqual(tomllib.loads(self.read())["yaw"], {"curve": [[0, 0], [10, 25]], "sensitivity": 0.8})

    def test_the_example_file_stays_valid_after_tuning(self):
        self.write((ROOT / "headflight.example.toml").read_text(encoding="utf-8"))
        config.save_value(self.path, "pitch", "sensitivity", 0.55)
        cfg = config.load(self.path)
        self.assertEqual(cfg.pitch.sensitivity, 0.55)
        self.assertEqual(cfg.yaw.sensitivity, 0.7)
        self.assertIn("also on a slider", self.read())


class TuneTests(unittest.TestCase):
    def test_parse_accepts_sane_values_and_rejects_the_rest(self):
        self.assertEqual(monitor.parse_tune(b'{"axis": "pitch", "sensitivity": 0.6}'), monitor.Tune("pitch", 0.6))
        for body in (b'{"axis": "roll", "sensitivity": 1}', b'{"axis": "yaw", "sensitivity": 0}',
                     b'{"axis": "yaw", "sensitivity": 9}', b'{"axis": "yaw"}', b'{"axis": "yaw", "sensitivity": null}',
                     b'[1]', b'nonsense'):
            self.assertIsNone(monitor.parse_tune(body), body)

    def test_applies_at_once_and_saves_without_a_reload(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "headflight.toml")
            view = HeadView(Config())
            watcher = app.ConfigWatcher(path)
            app.apply_tune(view, watcher, monitor.Tune("pitch", 0.4))
            self.assertEqual(view.cfg.pitch.sensitivity, 0.4)
            self.assertEqual(config.load(path).pitch.sensitivity, 0.4)
            self.assertIsNone(watcher.changed())

    def test_failed_save_still_applies(self):
        view = HeadView(Config())
        watcher = mock.Mock(path="headflight.toml")
        watcher.save.side_effect = OSError("read-only")
        with mock.patch("builtins.print"):
            app.apply_tune(view, watcher, monitor.Tune("yaw", 0.7))
        self.assertEqual(view.cfg.yaw.sensitivity, 0.7)

    def test_viewer_endpoint_queues_valid_requests_only(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        m = monitor.Monitor(port)
        self.addCleanup(m.close)

        def post(body, content_type="application/json"):
            request = urllib.request.Request(f"http://127.0.0.1:{port}/tune", data=body,
                                             headers={"Content-Type": content_type})
            try:
                with urllib.request.urlopen(request, timeout=2) as response:
                    return response.status
            except urllib.error.HTTPError as e:
                e.close()
                return e.code

        self.assertEqual(post(b'{"axis": "pitch", "sensitivity": 0.6}'), 204)
        self.assertEqual(m.commands.get(timeout=1), monitor.Tune("pitch", 0.6))
        self.assertEqual(post(b'{"axis": "pitch", "sensitivity": 50}'), 400)
        self.assertEqual(post(b'{"axis": "pitch", "sensitivity": 0.6}', "text/plain"), 415)
        self.assertTrue(m.commands.empty())


class ViewerFileTests(unittest.TestCase):
    def test_every_viewer_file_is_served_with_a_usable_type(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        m = monitor.Monitor(port)
        self.addCleanup(m.close)
        expected = {"/": "text/html", "/?yaw=90": "text/html", "/cockpit.js": "text/javascript",
                    "/sound.js": "text/javascript", "/three.module.min.js": "text/javascript"}
        for path, content_type in expected.items():
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as response:
                self.assertTrue(response.headers["Content-Type"].startswith(content_type), path)
                self.assertGreater(len(response.read()), 1000, path)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/../config.py", timeout=2)
        caught.exception.close()
        self.assertEqual(caught.exception.code, 404)


class RadioFileTests(unittest.TestCase):
    def test_paths_outside_the_radio_files_are_refused(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        m = monitor.Monitor(port)
        self.addCleanup(m.close)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/radio/..%2fviewer.html", timeout=2)
        caught.exception.close()
        self.assertEqual(caught.exception.code, 404)

    def test_every_call_the_sound_engine_names_is_generated(self):
        source = (monitor.WEB_ROOT / "sound.js").read_text(encoding="utf-8").split("const CALL_GAP_S")[0]
        names = set(re.findall(r'"(\w+)"', source))
        script = (ROOT / "make_voices.sh").read_text(encoding="utf-8")
        self.assertEqual(names, set(re.findall(r'(?m)^line "\$\w+" (\w+) ', script)))


class PhoneTests(unittest.TestCase):
    def test_parse_clamps_values_and_rejects_junk(self):
        self.assertEqual(phone.parse_stick(b'{"roll": 2, "pitch": -3, "throttle": 9, "resets": 2}'), phone.Stick(1, -1, 1, 2))
        self.assertEqual(phone.parse_stick(b'{"roll": 0.5, "pitch": 0.1, "throttle": 0.2}').resets, 0)
        for body in (b'nonsense', b'[1]', b'{"roll": 1}', b'{"roll": "x", "pitch": 0, "throttle": 0}',
                     b'{"roll": NaN, "pitch": 0, "throttle": 0}', b'{"roll": Infinity, "pitch": 0, "throttle": 0}'):
            self.assertIsNone(phone.parse_stick(body), body)

    def test_yaw_is_clamped_and_optional(self):
        self.assertEqual(phone.parse_stick(b'{"roll": 0, "pitch": 0, "yaw": -4, "throttle": 0}').yaw, -1)
        self.assertEqual(phone.parse_stick(b'{"roll": 0, "pitch": 0, "throttle": 0}').yaw, 0)
        self.assertIsNone(phone.parse_stick(b'{"roll": 0, "pitch": 0, "yaw": NaN, "throttle": 0}'))

    def test_lan_address_is_an_ipv4_address(self):
        self.assertEqual(len(phone.lan_address().split(".")), 4)

    def test_no_openssl_means_no_phone_rather_than_a_crash(self):
        with tempfile.TemporaryDirectory() as d, mock.patch("shutil.which", return_value=None):
            self.assertIsNone(phone.ensure_certificate("192.168.1.2", Path(d)))

    @unittest.skipUnless(shutil.which("openssl"), "needs openssl")
    def test_serves_the_page_and_takes_stick_input_over_https(self):
        with tempfile.TemporaryDirectory() as d, socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
            probe.close()
            cert, key = phone.ensure_certificate("127.0.0.1", Path(d))
            self.assertEqual(os.stat(key).st_mode & 0o777, 0o600)
            self.assertEqual(phone.ensure_certificate("127.0.0.1", Path(d)), (cert, key))
            server = phone.PhoneServer(port, cert, key)
            self.addCleanup(server.close)

            client = ssl.create_default_context()
            client.check_hostname = False
            client.verify_mode = ssl.CERT_NONE
            base = f"https://127.0.0.1:{port}"

            def post(path, body):
                request = urllib.request.Request(base + path, data=body)
                try:
                    with urllib.request.urlopen(request, timeout=3, context=client) as response:
                        return response.status
                except urllib.error.HTTPError as e:
                    e.close()
                    return e.code

            with urllib.request.urlopen(base + "/", timeout=3, context=client) as response:
                self.assertIn("Phone stick", response.read().decode("utf-8"))

            self.assertFalse(server.snapshot(time.perf_counter())["connected"])
            self.assertEqual(post("/stick", b'{"roll": 0.5, "pitch": -0.25, "throttle": 0.8, "resets": 1}'), 204)
            state = server.snapshot(time.perf_counter())
            self.assertEqual(state, {"roll": 0.5, "pitch": -0.25, "yaw": 0.0, "throttle": 0.8, "resets": 1, "connected": True})
            self.assertFalse(server.snapshot(time.perf_counter() + 2)["connected"])
            self.assertEqual(post("/stick", b'junk'), 400)
            self.assertEqual(post("/elsewhere", b'{}'), 404)


class QrTests(unittest.TestCase):
    """Real decoding was checked once with Apple's CIDetector; these guard the structure."""

    def test_codewords_are_a_valid_reed_solomon_codeword(self):
        data = list(b"https://192.168.1.20:4252")
        ec = qr.error_correction(data, 10)
        root = 1
        for _ in range(10):
            value = 0
            for byte in data + ec:
                value = qr.gf_multiply(value, root) ^ byte
            self.assertEqual(value, 0)
            root = qr.gf_multiply(root, 2)

    def test_picks_the_smallest_version_that_fits(self):
        self.assertEqual(len(qr.encode("x" * 17)), 21)
        self.assertEqual(len(qr.encode("x" * 18)), 25)
        self.assertEqual(len(qr.encode("https://192.168.1.20:4252")), 25)
        self.assertEqual(len(qr.encode("x" * 106)), 37)
        with self.assertRaises(ValueError):
            qr.encode("x" * 107)

    def test_finders_timing_and_dark_module_are_in_place(self):
        m = qr.encode("https://192.168.1.20:4252")
        size = len(m)
        finder = [m[y][:7] for y in range(7)]
        self.assertEqual(finder, [[x in (0, 6) or y in (0, 6) or (2 <= x <= 4 and 2 <= y <= 4) for x in range(7)] for y in range(7)])
        for corner in ([m[y][size - 7:] for y in range(7)], [m[size - 7 + y][:7] for y in range(7)]):
            self.assertEqual(corner, finder)
        self.assertEqual([m[6][x] for x in range(8, size - 8)], [x % 2 == 0 for x in range(8, size - 8)])
        self.assertTrue(m[size - 8][8])

    def test_the_two_format_copies_agree(self):
        m = qr.encode("https://192.168.1.20:4252")
        size = len(m)
        first = [m[i][8] for i in range(6)] + [m[7][8], m[8][8], m[8][7]] + [m[8][14 - i] for i in range(9, 15)]
        second = [m[8][size - 1 - i] for i in range(8)] + [m[size - 15 + i][8] for i in range(8, 15)]
        self.assertEqual(first, second)

    def test_renderers_cover_every_module(self):
        url = "https://192.168.1.20:4252"
        dark = sum(map(sum, qr.encode(url)))
        self.assertEqual(qr.svg(url).count("h1v1h-1z"), dark)
        self.assertTrue(qr.svg(url).startswith("<svg"))
        lines = qr.terminal(url).split("\n")
        self.assertEqual(len(lines), 15)
        self.assertTrue(all(line.startswith("\x1b[30;47m") for line in lines))

    def test_viewer_serves_the_code_only_when_there_is_one(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        m = monitor.Monitor(port)
        self.addCleanup(m.close)
        url = f"http://127.0.0.1:{port}/phone-qr.svg"
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url, timeout=2)
        caught.exception.close()
        self.assertEqual(caught.exception.code, 404)
        m.phone_qr = qr.svg("https://192.168.1.20:4252")
        with urllib.request.urlopen(url, timeout=2) as response:
            self.assertEqual(response.headers["Content-Type"], "image/svg+xml")
            self.assertTrue(response.read().startswith(b"<svg"))


class ConfigWatcherTests(unittest.TestCase):
    def test_reloads_on_change_and_survives_a_bad_save(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "headflight.toml")
            Path(path).write_text("[filter]\nlookahead_ms = 50\n")
            watcher = app.ConfigWatcher(path)
            self.assertIsNone(watcher.changed())

            Path(path).write_text("[filter]\nlookahead_ms = 60\n")
            os.utime(path, (1, 1))
            self.assertEqual(watcher.changed().filter.lookahead_ms, 60)

            Path(path).write_text("[filter]\nnot_a_setting = 1\n")
            os.utime(path, (2, 2))
            with mock.patch("builtins.print"):
                self.assertIsNone(watcher.changed())

    def test_picks_up_a_file_created_after_startup(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "headflight.toml")
            self.assertEqual(config.load(path), Config())
            watcher = app.ConfigWatcher(path)
            self.assertIsNone(watcher.changed())

            Path(path).write_text("[pitch]\ninvert = false\n")
            with mock.patch("builtins.print"):
                self.assertFalse(watcher.changed().pitch.invert)

    def test_broken_toml_keeps_the_running_settings(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "headflight.toml")
            Path(path).write_text("")
            watcher = app.ConfigWatcher(path)
            Path(path).write_text("[filter\n")
            os.utime(path, (3, 3))
            with mock.patch("builtins.print"):
                self.assertIsNone(watcher.changed())


class RecordingTests(unittest.TestCase):
    def test_record_captures_a_real_udp_stream_and_loads_it_back(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        sent = [Pose(i, i * 40000, i * 1.0, -i * 1.0, 0.0, 2.0, -2.0, 0.0) for i in range(1, 6)]

        def send():
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                for p in sent:
                    s.sendto(protocol.pack(p), ("127.0.0.1", port))
                s.sendto(b"not a pose", ("127.0.0.1", port))

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "trace.csv")
            timer = threading.Timer(0.1, send)
            timer.start()
            count = record.record(path, port, 0.5)
            timer.join()
            self.assertEqual(count, 5)
            self.assertEqual([p for _, p in record.load(path)], sent)

    def test_replay_reproduces_a_recording_over_udp(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "trace.csv")
            with open(path, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(record.COLUMNS)
                for i in range(3):
                    w.writerow([f"{i * 0.01:.3f}", *astuple(Pose(i + 1, i * 40000, float(i), 0.0, 0.0, 0.0, 0.0, 0.0))])
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sink:
                sink.bind(("127.0.0.1", 0))
                sink.settimeout(1)
                record.replay(path, "127.0.0.1", sink.getsockname()[1], loop=False)
                got = [protocol.parse(sink.recv(65)) for _ in range(3)]
        self.assertEqual([p.yaw for p in got], [0.0, 1.0, 2.0])
        self.assertEqual([p.seq for p in got], [1, 2, 3])

if __name__ == "__main__":
    unittest.main()
