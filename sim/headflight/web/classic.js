// The Old Bucket: the first cockpit, kept as it was but for a real stick and throttle, and a few
// basic switches for Realistic.
import * as THREE from "three";
import { FLAP_MODES } from "/avionics.js";
import { addFlightControls, createSwitches } from "/switches.js";

const DEG = Math.PI / 180;
const RADAR_RANGE = 10000;      // meters
const RADAR_ARC = 58;           // degrees either side of the nose

const steel = (color, roughness = 0.55, metalness = 0.3) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

// ------------------------------------------------------------------------------ instruments

const GREEN = "#7dffae";

function canvasPanel(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { canvas, ctx: canvas.getContext("2d"), texture };
}

function createHud() {
  const { canvas, ctx, texture } = canvasPanel(768, 768);
  const size = canvas.width, mid = size / 2;
  // The plate spans about 26 degrees, which sets how far apart the ladder rungs sit.
  const perDegree = size / 26;

  function rung(pitch, y) {
    if (pitch === 0) {
      ctx.beginPath();
      ctx.moveTo(-250, y); ctx.lineTo(-52, y);
      ctx.moveTo(52, y); ctx.lineTo(250, y);
      ctx.stroke();
      return;
    }
    ctx.setLineDash(pitch < 0 ? [14, 9] : []);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 52, y); ctx.lineTo(side * 128, y);
      ctx.lineTo(side * 128, y + (pitch < 0 ? -11 : 11));
      ctx.stroke();
      ctx.fillText(String(Math.abs(pitch)), side * 156, y);
    }
    ctx.setLineDash([]);
  }

  return {
    texture,
    draw({ pitch, roll, heading, knots, feet, throttle, target, missiles, warning }) {
      ctx.clearRect(0, 0, size, size);
      ctx.strokeStyle = ctx.fillStyle = GREEN;
      ctx.lineWidth = 2.5;
      ctx.font = "20px Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.save();
      ctx.beginPath();
      ctx.rect(mid - 270, mid - 235, 540, 500);
      ctx.clip();
      ctx.translate(mid, mid);
      ctx.rotate(-roll * DEG);
      const nearest = Math.round(pitch / 5) * 5;
      for (let at = nearest - 20; at <= nearest + 20; at += 5) {
        if (Math.abs(at) <= 90) rung(at, (pitch - at) * perDegree);
      }
      ctx.restore();

      ctx.beginPath();
      ctx.arc(mid, mid, 11, 0, Math.PI * 2);
      for (const [x0, x1] of [[-34, -11], [11, 34]]) { ctx.moveTo(mid + x0, mid); ctx.lineTo(mid + x1, mid); }
      ctx.moveTo(mid, mid - 11); ctx.lineTo(mid, mid - 25);
      ctx.stroke();

      ctx.clearRect(mid - 302, mid - 22, 92, 44);
      ctx.clearRect(mid + 210, mid - 22, 92, 44);
      ctx.strokeRect(mid - 302, mid - 22, 92, 44);
      ctx.strokeRect(mid + 210, mid - 22, 92, 44);
      ctx.fillText(String(Math.round(knots)), mid - 256, mid);
      ctx.fillText(String(Math.round(feet / 10) * 10), mid + 256, mid);
      ctx.fillText("KTS", mid - 256, mid + 38);
      ctx.fillText("ALT", mid + 256, mid + 38);

      const offset = heading % 5;
      for (let mark = -6; mark <= 6; mark++) {
        const value = (Math.round(heading - offset) + mark * 5 + 360) % 360;
        const x = mid + (mark * 5 - offset) * 7.2;
        ctx.beginPath(); ctx.moveTo(x, 88); ctx.lineTo(x, value % 10 ? 98 : 108); ctx.stroke();
        if (value % 10 === 0) ctx.fillText(String(value).padStart(3, "0"), x, 70);
      }
      ctx.beginPath(); ctx.moveTo(mid, 118); ctx.lineTo(mid - 9, 134); ctx.lineTo(mid + 9, 134); ctx.closePath(); ctx.stroke();

      ctx.textAlign = "left";
      ctx.fillText(`THR ${Math.round(throttle * 100)}`, mid - 302, mid + 150);
      ctx.fillText(`MSL ${missiles}`, mid + 210, mid + 150);
      if (target.range !== null) ctx.fillText(`RNG ${(target.range / 1000).toFixed(1)}`, mid - 302, mid + 182);
      if (warning) {
        ctx.textAlign = "center";
        ctx.fillText(warning, mid, 164);
      }
      ctx.textAlign = "center";
      if (target.status) ctx.fillText(target.status, mid, mid + 150);
      texture.needsUpdate = true;
    },
  };
}

function consoleTexture() {
  const { canvas, ctx, texture } = canvasPanel(256, 512);
  ctx.fillStyle = "#23282e";
  ctx.fillRect(0, 0, 256, 512);
  const rows = [[3, 44], [5, 26], [2, 60], [6, 22], [4, 36], [3, 44]];
  let y = 14;
  for (const [count, height] of rows) {
    const width = 236 / count;
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = "#14181c";
      ctx.fillRect(10 + i * width, y, width - 6, height);
      ctx.fillStyle = "#b9c1c9";
      ctx.fillRect(14 + i * width, y + 5, Math.min(width - 22, 26), 3);
      ctx.fillStyle = "#3c444c";
      ctx.beginPath();
      ctx.arc(10 + i * width + (width - 6) / 2, y + height / 2 + 4, Math.min(height, width) / 5, 0, 7);
      ctx.fill();
    }
    y += height + 12;
  }
  texture.needsUpdate = true;
  return texture;
}

function drawRadar(ctx, size, sweep, contact) {
  ctx.fillStyle = "#031008";
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size * 0.9);
  ctx.strokeStyle = "#2c8a57";
  ctx.lineWidth = 1.5;
  for (const r of [0.28, 0.56, 0.84]) {
    ctx.beginPath(); ctx.arc(0, 0, r * size, -Math.PI * 0.82, -Math.PI * 0.18); ctx.stroke();
  }
  for (const a of [-0.32, 0, 0.32]) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(a * Math.PI) * size * 0.84, -Math.cos(a * Math.PI) * size * 0.84); ctx.stroke();
  }
  const angle = Math.sin(sweep) * 0.32 * Math.PI;
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(angle) * size * 0.84, -Math.cos(angle) * size * 0.84); ctx.stroke();
  ctx.fillStyle = GREEN;
  if (contact && Math.abs(contact.azimuth) < RADAR_ARC && contact.range < RADAR_RANGE) {
    const a = contact.azimuth * DEG, r = contact.range / RADAR_RANGE * 0.84 * size;
    ctx.fillRect(Math.sin(a) * r - 5, -Math.cos(a) * r - 5, 10, 10);
  }
  ctx.restore();
  ctx.fillStyle = GREEN;
  ctx.font = `${size / 13}px Menlo, Consolas, monospace`;
  ctx.fillText(`RWS  ${RADAR_RANGE / 1000}`, size * 0.06, size * 0.1);
}

function drawAttitude(ctx, size, pitch, roll) {
  const perDegree = size * 0.018;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-roll * DEG);
  ctx.translate(0, pitch * perDegree);
  ctx.fillStyle = "#1c5a9a";
  ctx.fillRect(-size * 2, -size * 3, size * 4, size * 3);
  ctx.fillStyle = "#6b4526";
  ctx.fillRect(-size * 2, 0, size * 4, size * 3);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-size * 2, 0); ctx.lineTo(size * 2, 0); ctx.stroke();
  for (let at = -40; at <= 40; at += 10) {
    if (at === 0) continue;
    const half = size * (at % 20 ? 0.09 : 0.16);
    ctx.beginPath(); ctx.moveTo(-half, -at * perDegree); ctx.lineTo(half, -at * perDegree); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = "#ffcf5c";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(size * 0.28, size / 2); ctx.lineTo(size * 0.42, size / 2); ctx.lineTo(size * 0.42, size * 0.55);
  ctx.moveTo(size * 0.72, size / 2); ctx.lineTo(size * 0.58, size / 2); ctx.lineTo(size * 0.58, size * 0.55);
  ctx.stroke();
}

function drawStores(ctx, size, missiles) {
  ctx.fillStyle = "#031008";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = ctx.fillStyle = GREEN;
  ctx.lineWidth = 3;
  ctx.font = `${size / 13}px Menlo, Consolas, monospace`;
  ctx.fillText("STORES", size * 0.06, size * 0.1);
  const m = size / 2;
  ctx.beginPath();
  ctx.moveTo(m, size * 0.2); ctx.lineTo(m + size * 0.06, size * 0.5); ctx.lineTo(m + size * 0.36, size * 0.68);
  ctx.lineTo(m + size * 0.06, size * 0.68); ctx.lineTo(m + size * 0.05, size * 0.84); ctx.lineTo(m - size * 0.05, size * 0.84);
  ctx.lineTo(m - size * 0.06, size * 0.68); ctx.lineTo(m - size * 0.36, size * 0.68); ctx.lineTo(m - size * 0.06, size * 0.5);
  ctx.closePath(); ctx.stroke();
  for (const x of [-0.26, -0.14, 0.14, 0.26]) ctx.fillRect(m + x * size - 4, size * 0.56, 8, 26);
  ctx.fillText(`MSL ${missiles}`, size * 0.06, size * 0.95);
}

// ---------------------------------------------------------------------------------- cockpit

function buildCockpit(radar, hud, attitude, stores) {
  const cockpit = new THREE.Group();
  const shell = steel("#343b43", 0.75, 0.15);
  const dark = steel("#191d21", 0.8, 0.1);
  const trim = steel("#59626c", 0.5, 0.45);
  const box = (w, h, d, x, y, z, material = shell) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    cockpit.add(mesh);
    return mesh;
  };
  const screen = (texture, size, x, y) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    mesh.position.set(x, y, -0.697);
    cockpit.add(mesh);
    box(size + 0.03, size + 0.03, 0.012, x, y, -0.706, dark);
  };

  const panel = new THREE.Shape();
  panel.moveTo(-0.42, -0.66);
  panel.lineTo(0.42, -0.66);
  panel.lineTo(0.42, -0.215);
  panel.quadraticCurveTo(0, -0.1, -0.42, -0.215);
  const face = new THREE.Mesh(new THREE.ExtrudeGeometry(panel, { depth: 0.06, bevelEnabled: false }), shell);
  face.position.z = -0.76;
  cockpit.add(face);

  const hood = new THREE.Shape();
  hood.moveTo(-0.42, -0.215);
  hood.quadraticCurveTo(0, -0.1, 0.42, -0.215);
  hood.lineTo(0.42, -0.275);
  hood.quadraticCurveTo(0, -0.16, -0.42, -0.275);
  const shield = new THREE.Mesh(new THREE.ExtrudeGeometry(hood, { depth: 0.27, bevelEnabled: false }), dark);
  shield.position.z = -0.76;
  cockpit.add(shield);

  screen(radar.texture, 0.2, -0.205, -0.42);
  screen(attitude.texture, 0.13, 0, -0.36);
  screen(stores.texture, 0.2, 0.205, -0.42);

  // HUD: housing, posts, combiner glass, and the symbols that sit on it.
  box(0.17, 0.035, 0.1, 0, -0.142, -0.565, shell);
  for (const side of [-1, 1]) box(0.006, 0.2, 0.008, side * 0.137, -0.03, -0.615, trim);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.22),
    new THREE.MeshBasicMaterial({ color: "#a8ffd8", transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
  glass.position.set(0, -0.02, -0.615);
  cockpit.add(glass);
  const symbols = new THREE.Mesh(new THREE.PlaneGeometry(0.284, 0.284),
    new THREE.MeshBasicMaterial({
      map: hud.texture, transparent: true, depthWrite: false, toneMapped: false,
      blending: THREE.AdditiveBlending, alphaTest: 0.01,
    }));
  symbols.position.set(0, 0, -0.612);
  cockpit.add(symbols);

  // The tub around the pilot.
  const consoleTop = consoleTexture();
  for (const side of [-1, 1]) {
    box(0.17, 0.08, 1.08, side * 0.335, -0.46, 0.02);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 1.08), new THREE.MeshStandardMaterial({ map: consoleTop, roughness: 0.7 }));
    top.rotation.x = -Math.PI / 2;
    top.position.set(side * 0.335, -0.419, 0.02);
    cockpit.add(top);
    box(0.02, 0.48, 1.34, side * 0.43, -0.42, -0.1);
    box(0.05, 0.03, 1.5, side * 0.44, -0.175, -0.07, trim);
  }
  box(0.9, 0.02, 1.34, 0, -0.68, -0.1, dark);

  // Ejection seat and the bulkhead behind it.
  box(0.22, 0.2, 0.08, 0, -0.1, 0.46, dark);
  box(0.4, 0.5, 0.1, 0, -0.43, 0.47, shell);
  box(0.87, 0.4, 0.02, 0, -0.42, 0.56, shell);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 8, 20), steel("#e0b020", 0.5, 0.1));
  handle.position.set(0, 0.03, 0.42);
  cockpit.add(handle);


  // Canopy frame: the arch ahead of the pilot and the one behind.
  const arch = points => new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), 48, 0.011, 8), trim);
  cockpit.add(arch([[-0.45, -0.17, -0.5], [-0.37, 0.1, -0.47], [0, 0.34, -0.42], [0.37, 0.1, -0.47], [0.45, -0.17, -0.5]]));
  cockpit.add(arch([[-0.45, -0.17, 0.62], [-0.34, 0.16, 0.62], [0, 0.32, 0.62], [0.34, 0.16, 0.62], [0.45, -0.17, 0.62]]));

  // Faint canopy glass, enough to feel enclosed.
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.56),
    new THREE.MeshBasicMaterial({ color: "#cfe4ff", transparent: true, opacity: 0.025, side: THREE.BackSide, depthWrite: false }));
  canopy.scale.set(0.82, 0.68, 1.25);
  canopy.position.y = -0.1;
  cockpit.add(canopy);
  return cockpit;
}

const EASY_MISSILE_COUNT = 96;

function addSwitches(group, avionics, actions) {
  const switches = createSwitches(group);
  const { button, toggle, light } = switches;
  const label = (text, x, y) => light(x, y, 0.06, 0.018, [text], "#e9edf0", () => true);

  label("ARM", -0.055, -0.455);
  toggle(-0.055, -0.495, "MASTER ARM", ["SAFE", "ARM"], () => (avionics.masterArm ? 1 : 0), v => { avionics.masterArm = v === 1; });
  label("GEAR", 0.055, -0.455);
  toggle(0.055, -0.495, "LANDING GEAR", ["DOWN", "UP"], () => (avionics.gearDown ? 0 : 1), v => { avionics.gearDown = v === 0; });
  label("FLAPS", -0.055, -0.545);
  toggle(-0.055, -0.585, "FLAPS", FLAP_MODES, () => avionics.flaps, v => { avionics.flaps = v; }, { inverted: true });
  label("SPD BRK", 0.055, -0.545);
  toggle(0.055, -0.585, "SPEED BRAKE", ["IN", "OUT"], () => (avionics.speedBrake ? 1 : 0), v => { avionics.speedBrake = v === 1; });
  light(0, -0.455, 0.04, 0.018, ["READY"], "#7dffae", () => avionics.realistic && avionics.canFire);
  button(0, -0.635, 0.05, 0.026, "DISPENSE FLARES", () => actions.dispense(), { text: "FLR", tip: () => `DISPENSE FLARES: ${avionics.flareCount} left` });
  return switches;
}

export function createClassicCockpit(avionics, actions) {
  const radar = canvasPanel(256, 256);
  const attitude = canvasPanel(256, 256);
  const stores = canvasPanel(256, 256);
  const hud = createHud();
  const group = buildCockpit(radar, hud, attitude, stores);
  const flightControls = addFlightControls(group);
  const switches = addSwitches(group, avionics, actions);
  let hudDue = 0, screensDue = 0;
  let shownMissiles = null;

  return {
    group,
    pick: switches.pick,
    pickNearest: switches.pickNearest,
    mark: switches.mark,
    use: switches.use,

    update({ dt, seconds, flight, fight, target, stick, warning }) {
      switches.update(dt);
      flightControls.update(stick, flight.throttle);

      const missiles = avionics.realistic ? avionics.missiles : EASY_MISSILE_COUNT;
      if (missiles !== shownMissiles) {
        shownMissiles = missiles;
        drawStores(stores.ctx, 256, missiles);
        stores.texture.needsUpdate = true;
      }
      if (seconds >= hudDue) {
        hudDue = seconds + 1 / 30;
        hud.draw({ ...flight, target: fight, missiles, warning });
      }
      if (seconds < screensDue) return;
      screensDue = seconds + 1 / 15;
      drawRadar(radar.ctx, radar.canvas.width, seconds * 1.4, target);
      radar.texture.needsUpdate = true;
      drawAttitude(attitude.ctx, attitude.canvas.width, flight.pitch, flight.roll);
      attitude.texture.needsUpdate = true;
    },
  };
}
