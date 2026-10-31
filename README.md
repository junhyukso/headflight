# HeadFlight

Fly a fighter in your browser with the hardware you already own. Your AirPods track your head, your iPhone is the flight stick, and your Mac runs the sim.

No camera, no IR clip, no phone app, and no game to install.

![The HeadFlight cockpit](docs/screenshot.jpg)

- **Look around by turning your head.** The motion sensors in your AirPods steer the view, with prediction to hide their 25 Hz update rate.
- **Fly with your iPhone.** Hold it upright like a stick. It connects by scanning a QR code, right from Safari.
- **Dogfight by sight.** Bandits fly in the same world as you, so you chase them down and lock them with your head.
- **Hear where things are.** Aircraft and warnings are placed in 3D and move as your head turns. The radio tells you where the bandit is, then you turn to find it.

Everything you see and hear is generated: terrain, clouds, aircraft, instruments, and engine sound.

## What you need

- A Mac on macOS 14 or later, with Swift (Xcode or its command line tools) and Python 3.11 or later
- AirPods that support head tracking, connected to the Mac
- An iPhone on the same Wi-Fi as the Mac

Tested on a MacBook Air (M2) with macOS 15.5, AirPods Pro, and an iPhone.

## Run it

```bash
./run.sh
```

The first run builds the AirPods sender and generates the radio voices. Then:

1. Allow **Motion & Fitness** access when macOS asks. The simulator opens in your browser.
2. Scan the QR code with your iPhone camera and open the link.
3. Safari warns about the certificate because your Mac made it. Tap **Show Details**, then **visit this website**.
4. Press **Start** and allow motion access. Hold the phone the way you will fly it first, since that position becomes center.
5. Click anywhere in the simulator to turn on sound, and turn off Spatial Audio for your AirPods so head tracking isn't applied twice.

Press Ctrl+C in the terminal to stop.

## Flying

Hold the phone upright in your right hand, with the side button toward you and the volume buttons away.

| Move | Result |
|---|---|
| Tilt back toward you | Nose up |
| Tilt away from you | Nose down |
| Tilt left or right | Roll |
| Swipe up or down on the right half of the screen | Throttle |
| Tap **FIRE** on the phone, or press Space | Shoot |
| Turn your head | Look around |

Pick a target in the menu, or with the 1, 2, and 3 keys. Your wingman holds formation off the right wing. Press `M` to hide the menu and `R` to recenter.

| Target | What it does |
|---|---|
| Easy | Flies slowly with gentle turns. Good for learning the chase. |
| Fast | Runs near your top speed, turns hard, and breaks when you get on its tail. Takes full throttle. |
| Dogfight | Starts head-on, then turns to get behind you and shoot. When your wingman calls a break, turn hard until the warning stops. |

**To shoot, look at the bandit.** Your head aims the lock. Hold the bandit in the ring in the middle of your view for about a second, from behind its wing line, within 1.5 km and within 65 degrees of your nose. The ring fills, the tone rises, the word `SHOOT` appears, and a red box appears around the bandit. The lock holds until the bandit leaves your view or gets more than 2 km away. Tap **FIRE** while it holds. In Realistic mode the jet has to be set up first, as described below. If something is stopping a lock, the view says so: `TURN TOWARD`, `GET BEHIND`, `TOO FAR`, or `TOO CLOSE`.

### Cockpits

Pick one in the menu. The **Hor'not'** is a working twin-display fighter cockpit. The **Old Bucket** is the simple cockpit HeadFlight started with. Both have a stick and throttle that follow the phone.

### Easy and Realistic

In **Easy** the cockpit runs itself: a lock is all you need to fire. In **Realistic**, set in the menu, every switch is yours. The Old Bucket keeps it simple, with just **ARM**, gear, flaps, speed brake, and flares. Hover over a control to see what it is, click to use it, and right-click or scroll to go back. Drag a knob up or right to turn it up. With your hands on the phone, look at a control so the ring is on it, then tap **USE**. Hold **USE** to go back.

To fight in the Hor'not' in Realistic, press **A/A**, set **MASTER ARM** to ARM, and keep the radar on. You carry six missiles, 30 flares, and 8 to 13 minutes of fuel depending on throttle. The HUD warns you at `BINGO`, then `FUEL LOW`, and the engine stops at `FLAMEOUT`. **Reset aircraft** on the phone refills everything.

The flight controls limit you to 7.5 G, or -3 G pushing, and the HUD shows `G LIM` when you reach it. Hard turns cost speed, and below about 330 knots the wing can't reach the limit, so the tightest turn comes from staying near that speed. Bandits are limited too, a little more than you. Easy has none of this: it's arcade flying, well past what a real jet or pilot could take.

The Hor'not' controls:

| Control | What it does |
|---|---|
| **MASTER ARM**, **A/A**, **A/G** | Weapons need ARM and A/A. |
| **EMER JETT** button, under READY | Drops every missile. |
| Digital displays and their buttons | Radar, stores, warning, engine, flight control, and attitude pages. |
| Map display | Your position and the bandit, with its own range buttons. |
| Keypad, **A/P** | Attitude, heading, or altitude hold. Type a heading or altitude and press ENT. Moving the stick turns it off. |
| Keypad, **BINGO** | Type a fuel warning level and press ENT. |
| **COMM 1**, **COMM 2** knobs | Radio voice and warning tone volume. |
| HUD **SYM** and **BRT** | Hide HUD symbols and set brightness. |
| Landing gear, flaps | Limit your speed. Flaps also tighten your turn. |
| **SPD BRK** on the right console | Limits your speed. |
| **CMDS**, **FLR** | Flares break the bandit's lock. |
| **RWR** | Turns the threat display on or off. |
| **RADAR** on the right console | OFF, STBY, or OPR. Without it the HUD and map lose the bandit. |
| Generators on the left console | With both off, the displays, HUD, and radar go dark. |
| **FUEL DUMP** on the left console | Dumps fuel. |
| Panel and console light knobs, display brightness and power | Do what they say. |
| Master caution | Lights for a new caution. Press it to reset. |

The other console switches, the TCN, ILS, D/L, and BCN keys, and any display button without a label complete the cockpit and have no effect yet.

Listen for the radar warning: it comes from the bandit's direction, and it speeds up when the bandit is locking you. A tone sounds when the bandit is in the middle of your view, low until it can lock.

The sliders in the simulator set yaw and pitch sensitivity. They apply at once and are saved to `sim/headflight.toml`. Everything else is documented in `sim/headflight.example.toml`, and saving your copy applies at once too.

## How it works

```
AirPods ──CoreMotion──> sender (Swift) ──UDP──> server (Python) ──> browser (Three.js, Web Audio)
                                                     ^
iPhone ──motion sensors──> Safari ──HTTPS────────────┘
```

**Head tracking.** AirPods report orientation 25 times a second, and those samples reach the Mac in bursts. A plain passthrough would look late and steppy. So the sender stamps each packet with the sensor's own clock and a gyro rate, and the server uses them to work out where your head is right now, 120 times a second. Corrections fade in rather than snapping the view.

**Phone stick.** iOS only gives motion sensors to HTTPS pages, so the server makes a self-signed certificate and serves the stick page over your LAN. Tilt is measured relative to the position you started in, as a rotation rather than Euler angles, so the axes stay independent even with the phone upright, where Euler angles break down.

**Bandits.** A bandit steers the way an aircraft does: it rolls its lift toward the turn it wants, then pulls. It has the same world coordinates as you, so range and closure are real.

**Sound.** The listener follows the view and your real head together, using HRTF panning in Web Audio. A sound stays on the screen when you glance away from it, which keeps what you see and hear in agreement.

## Measurements

Taken on the tested hardware from recordings of real head movement.

| | |
|---|---|
| Sensor rate | 25 Hz, 40 ms apart, no lost packets |
| Age of a sample when it reaches the server | median 20 to 30 ms depending on the run, 90% within 38 ms, worst 47 ms |
| Noise with the head still | 0.08 degrees |
| Gyro rate against actual movement | correlation 1.000, gain 1.01 |
| Error predicting 40 ms ahead while moving | down 89%, from 3.3 to 0.4 degrees |
| Compared with plain passthrough | 68 ms ahead, 18 times smoother |
| Age of the head data when a frame is drawn | median 7 ms, 95% within 9 ms |
| Motion gaps of about 160 ms | 1 per 2,000 samples with silent audio playing, 6 per 1,000 without |

Sample ages add the latency logged by macOS's `relatived` daemon, which uses a clock synced over Bluetooth, to the time from that daemon to our server, about 1 ms. The timestamps CoreMotion gives apps can't measure this: they are evenly spaced rather than true sensor times, about 25 ms earlier than the synced ones. Time from a frame being drawn to light leaving the screen isn't measured.

## Project layout

| Path | What it is |
|---|---|
| `sender/` | Reads AirPods motion on the Mac and streams it. A fork of [AirTracker](https://github.com/crippler95/airtracker). |
| `sim/headflight/` | The server: prediction, head-to-view mapping, phone stick, QR codes. |
| `sim/headflight/web/` | The simulator page, the world, both cockpits, the aircraft systems, the HUD, the bandits and fight rules, the sound engine, and the phone page. |
| `sim/tests/` | Tests. Run with `cd sim && python3 -m unittest discover -s tests`. |

No AirPods handy? `python3 -m headflight record trace.csv` saves a head trace, and `python3 -m headflight replay trace.csv --loop` plays it back. Run them from `sim/`.

## Limitations

- This is a demo. The flight model is simple and arcade-like, a locked missile always hits, and there are no guns, landings, or low-level flight: the world is only drawn from above 3,900 m.
- The phone stick assumes the right-hand grip described above.
- Sound lags the picture a little because of Bluetooth, so sound direction trails a fast head turn.
- Generic HRTF varies from person to person. Front and back are the easiest to confuse, and a small head turn settles it.
- Head tracking drifts slowly. It corrects itself while you look at the screen, and **Recenter** fixes it at once.

## Credits

- [AirTracker](https://github.com/crippler95/airtracker) by crippler95 (MIT) is the base of the sender.
- [Three.js](https://threejs.org) (MIT) renders the cockpit.

## License

MIT. See [LICENSE](LICENSE). `sender/` keeps its original MIT license in [sender/LICENSE](sender/LICENSE).

Not affiliated with or endorsed by Apple. AirPods and iPhone are trademarks of Apple Inc.
