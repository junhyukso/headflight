// The Hor'not': a twin-display front panel, consoles and center stick, every switch of which is a
// real object the mouse can pick. No asset files; the panel faces are painted on canvases.
import * as THREE from "three";
import {
  AUTOPILOT_MODES, FLAP_MODES, HUD_REJECT, LIGHT_MODES, RADAR_MODES, RADAR_RANGES_KM,
} from "/avionics.js";
import { addFlightControls, canvasOf, createSwitches, FACE_Z, metal, textTile } from "/switches.js";

const DEG = Math.PI / 180;
const FONT = 'Menlo, Consolas, "DejaVu Sans Mono", monospace';
const GREEN = "#7dffae";
const AMBER = "#ffb347";
const WHITE = "#e9edf0";
const ART_SCALE = 2400;         // canvas pixels per meter of panel
const SCREEN_PIXELS = 320;

// For anything redrawn while flying: uploading mipmaps every time would cost a visible stutter.
function liveCanvas(width, height) {
  const panel = canvasOf(width, height);
  panel.texture.generateMipmaps = false;
  panel.texture.minFilter = THREE.LinearFilter;
  return panel;
}

// ------------------------------------------------------------------------------- panel faces

// Paints a surface: gray paint with wear, and dark labeled modules set into it.
class Art {
  constructor(left, top, width, height, base = "#667078") {
    Object.assign(this, { left, top });
    const { canvas, ctx, texture } = canvasOf(Math.round(width * ART_SCALE), Math.round(height * ART_SCALE));
    Object.assign(this, { canvas, ctx, texture });
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? "255,255,255" : "0,0,0"},${Math.random() * 0.03})`;
      ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1 + Math.random() * 26, 1 + Math.random() * 3);
    }
  }

  x(meters) { return (meters - this.left) * ART_SCALE; }
  y(meters) { return (this.top - meters) * ART_SCALE; }

  module(x0, y0, x1, y1, title) {
    const { ctx } = this;
    const [px, py, width, height] = [this.x(x0), this.y(y0), (x1 - x0) * ART_SCALE, (y0 - y1) * ART_SCALE];
    ctx.fillStyle = "rgba(0, 0, 0, .45)";
    ctx.fillRect(px - 3, py - 3, width + 8, height + 8);
    ctx.fillStyle = "#23282c";
    ctx.fillRect(px, py, width, height);
    ctx.strokeStyle = "#7c858c";
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, width, height);
    ctx.fillStyle = "#6f777e";
    for (const [sx, sy] of [[10, 10], [width - 10, 10], [10, height - 10], [width - 10, height - 10]]) {
      ctx.beginPath(); ctx.arc(px + sx, py + sy, 4, 0, 7); ctx.fill();
    }
    if (title) this.label(title, (x0 + x1) / 2, y0 - 0.011, 15, "#c8ced3");
  }

  label(text, x, y, size = 14, color = WHITE) {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.font = `600 ${size}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, this.x(x), this.y(y));
  }

  bezel(x, y, size) {
    const { ctx } = this;
    const half = size / 2 * ART_SCALE;
    ctx.fillStyle = "#101214";
    ctx.fillRect(this.x(x) - half, this.y(y) - half, half * 2, half * 2);
    ctx.strokeStyle = "#62696f";
    ctx.lineWidth = 3;
    ctx.strokeRect(this.x(x) - half, this.y(y) - half, half * 2, half * 2);
  }
}

// ---------------------------------------------------------------------------------- displays

function title(ctx, size, text) {
  ctx.fillStyle = GREEN;
  ctx.font = `${size * 0.05}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size * 0.17);
}

const line = (ctx, x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };

function drawRadarPage(ctx, size, d) {
  const { avionics: a, target } = d;
  const [left, right, top, bottom] = [size * 0.14, size * 0.86, size * 0.16, size * 0.82];
  ctx.strokeStyle = "#2c8a57";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left, top, right - left, bottom - top);
  for (let i = 1; i < 4; i++) {
    const y = top + (bottom - top) * i / 4, x = left + (right - left) * i / 4;
    ctx.setLineDash([4, 8]);
    line(ctx, left, y, right, y);
    line(ctx, x, top, x, bottom);
    ctx.setLineDash([]);
  }
  ctx.fillStyle = GREEN;
  ctx.font = `${size * 0.045}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText(`${RADAR_RANGES_KM[a.radarRange]} KM`, left + 6, top + 18);
  if (!a.radarOn) {
    ctx.textAlign = "center";
    ctx.fillText(RADAR_MODES[a.radarMode] === "OFF" ? "RADAR OFF" : "STANDBY", size / 2, size / 2);
    return;
  }
  const sweep = left + (right - left) * (0.5 + Math.sin(d.seconds * 1.4) / 2);
  ctx.strokeStyle = GREEN;
  line(ctx, sweep, top, sweep, bottom);
  const limit = RADAR_RANGES_KM[a.radarRange] * 1000;
  if (target && Math.abs(target.azimuth) < 60 && target.range < limit) {
    const x = size / 2 + target.azimuth / 60 * (right - left) / 2;
    const y = bottom - target.range / limit * (bottom - top);
    ctx.fillRect(x - 7, y - 7, 14, 14);
    ctx.textAlign = "left";
    ctx.fillText(`${(target.range / 1000).toFixed(1)}`, x + 12, y);
  }
}

function drawStoresPage(ctx, size, d) {
  const { avionics: a } = d;
  const m = size / 2;
  ctx.strokeStyle = ctx.fillStyle = GREEN;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(m, size * 0.22); ctx.lineTo(m + size * 0.05, size * 0.46); ctx.lineTo(m + size * 0.3, size * 0.6);
  ctx.lineTo(m + size * 0.05, size * 0.6); ctx.lineTo(m + size * 0.04, size * 0.72); ctx.lineTo(m + size * 0.14, size * 0.76);
  ctx.lineTo(m - size * 0.14, size * 0.76); ctx.lineTo(m - size * 0.04, size * 0.72); ctx.lineTo(m - size * 0.05, size * 0.6);
  ctx.lineTo(m - size * 0.3, size * 0.6); ctx.lineTo(m - size * 0.05, size * 0.46); ctx.closePath();
  ctx.stroke();
  const stations = [-0.27, -0.19, -0.11, 0.11, 0.19, 0.27];
  stations.forEach((x, i) => {
    const full = i < a.missiles;
    if (full) ctx.fillRect(m + x * size - 4, size * 0.47, 8, 42);
    else ctx.strokeRect(m + x * size - 4, size * 0.47, 8, 42);
  });
  ctx.font = `${size * 0.05}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(`SRM ${a.missiles}`, m, size * 0.28);
  ctx.fillText(a.masterArm ? "ARM" : "SAFE", m, size * 0.84);
}

function drawWarningPage(ctx, size, d) {
  const { avionics: a, target } = d;
  const m = size / 2, r = size * 0.28;
  ctx.strokeStyle = ctx.fillStyle = GREEN;
  ctx.lineWidth = 2;
  for (const scale of [1, 0.5]) { ctx.beginPath(); ctx.arc(m, m, r * scale, 0, 7); ctx.stroke(); }
  for (let angle = 0; angle < 360; angle += 30) {
    const [x, y] = [Math.sin(angle * DEG), -Math.cos(angle * DEG)];
    line(ctx, m + x * r, m + y * r, m + x * (r + 10), m + y * (r + 10));
  }
  ctx.font = `${size * 0.05}px ${FONT}`;
  ctx.textAlign = "center";
  if (!a.rwrOn) ctx.fillText("RWR OFF", m, m);
  else if (target) {
    const angle = target.azimuth * DEG, reach = r * (target.threat > 0 ? 0.5 : 0.85);
    ctx.fillText(target.threat > 0 ? "T" : "U", m + Math.sin(angle) * reach, m - Math.cos(angle) * reach);
  }
  ctx.fillText(`FLR ${a.flareCount}`, m, size * 0.84);
}

function drawEnginePage(ctx, size, d) {
  const { avionics: a, flight } = d;
  ctx.strokeStyle = ctx.fillStyle = GREEN;
  ctx.lineWidth = 2;
  ctx.font = `${size * 0.045}px ${FONT}`;
  const rpm = a.flamedOut ? 12 : 68 + flight.throttle * 32;
  const rows = [["RPM", rpm, 100], ["EGT", a.flamedOut ? 180 : 420 + flight.throttle * 420, 900], ["FF", a.flamedOut ? 0 : 8 + flight.throttle * 92, 100]];
  rows.forEach(([name, value, full], i) => {
    const y = size * (0.3 + i * 0.13);
    ctx.textAlign = "left";
    ctx.fillText(name, size * 0.16, y);
    ctx.strokeRect(size * 0.3, y - 12, size * 0.42, 24);
    ctx.fillRect(size * 0.3, y - 12, size * 0.42 * Math.min(1, value / full), 24);
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(value)), size * 0.86, y);
  });
  ctx.textAlign = "left";
  ctx.fillText(`FUEL ${Math.round(a.fuel)} KG`, size * 0.16, size * 0.72);
  ctx.fillText(`BINGO ${Math.round(a.bingo)}`, size * 0.16, size * 0.79);
}

function drawFlightControlsPage(ctx, size, d) {
  const { avionics: a } = d;
  ctx.fillStyle = GREEN;
  ctx.font = `${size * 0.05}px ${FONT}`;
  ctx.textAlign = "left";
  const rows = [["FLAPS", FLAP_MODES[a.flaps]], ["GEAR", a.gearDown ? "DOWN" : "UP"], ["SPD BRK", a.speedBrake ? "OUT" : "IN"],
    ["HOOK", a.hook ? "DOWN" : "UP"], ["A/P", a.autopilot ?? "OFF"]];
  rows.forEach(([name, value], i) => {
    const y = size * (0.28 + i * 0.1);
    ctx.fillText(name, size * 0.18, y);
    ctx.fillText(value, size * 0.55, y);
  });
}

function drawAttitudePage(ctx, size, d) {
  const { pitch, roll } = d.flight;
  const perDegree = size * 0.018;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-roll * DEG);
  ctx.translate(0, pitch * perDegree);
  ctx.fillStyle = "#1c5a9a";
  ctx.fillRect(-size * 2, -size * 3, size * 4, size * 3);
  ctx.fillStyle = "#6b4526";
  ctx.fillRect(-size * 2, 0, size * 4, size * 3);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  line(ctx, -size * 2, 0, size * 2, 0);
  for (let at = -40; at <= 40; at += 10) {
    if (at) { const half = size * (at % 20 ? 0.09 : 0.16); line(ctx, -half, -at * perDegree, half, -at * perDegree); }
  }
  ctx.restore();
  ctx.strokeStyle = "#ffcf5c";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(size * 0.28, size / 2); ctx.lineTo(size * 0.42, size / 2); ctx.lineTo(size * 0.42, size * 0.55);
  ctx.moveTo(size * 0.72, size / 2); ctx.lineTo(size * 0.58, size / 2); ctx.lineTo(size * 0.58, size * 0.55);
  ctx.stroke();
}

function drawMapPage(ctx, size, d) {
  const { avionics: a, flight, target } = d;
  const m = size / 2, r = size * 0.36;
  const rangeKm = RADAR_RANGES_KM[d.mapRange];
  ctx.strokeStyle = ctx.fillStyle = GREEN;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(m, m, r, 0, 7); ctx.stroke();
  ctx.setLineDash([5, 9]);
  ctx.beginPath(); ctx.arc(m, m, r / 2, 0, 7); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `${size * 0.04}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let mark = 0; mark < 360; mark += 30) {
    const angle = (mark - flight.heading) * DEG;
    const [x, y] = [Math.sin(angle), -Math.cos(angle)];
    line(ctx, m + x * r, m + y * r, m + x * (r - (mark % 90 ? 7 : 14)), m + y * (r - (mark % 90 ? 7 : 14)));
    if (mark % 90 === 0) ctx.fillText("NESW"[mark / 90], m + x * (r - 28), m + y * (r - 28));
  }
  if (a.autopilot === "HDG") {
    const angle = (a.selectedHeading - flight.heading) * DEG;
    ctx.save();
    ctx.translate(m + Math.sin(angle) * r, m - Math.cos(angle) * r);
    ctx.rotate(angle);
    ctx.strokeRect(-7, -4, 14, 8);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.moveTo(m, m - 16); ctx.lineTo(m, m + 16);
  ctx.moveTo(m - 14, m + 2); ctx.lineTo(m + 14, m + 2);
  ctx.moveTo(m - 6, m + 14); ctx.lineTo(m + 6, m + 14);
  ctx.stroke();
  if (target && a.radarOn) {
    const distance = Math.min(1.1, target.range / (rangeKm * 1000)) * r;
    ctx.fillStyle = "#ff8a5c";
    const [x, y] = [m + Math.sin(target.azimuth * DEG) * distance, m - Math.cos(target.azimuth * DEG) * distance];
    ctx.fillRect(x - 7, y - 7, 14, 14);
  }
  ctx.fillStyle = GREEN;
  ctx.textAlign = "left";
  ctx.fillText(`${rangeKm} KM`, size * 0.14, size * 0.13);
  ctx.textAlign = "right";
  ctx.fillText(String(Math.round(flight.heading)).padStart(3, "0"), size * 0.86, size * 0.13);
}

// Each display has 20 buttons, clockwise from the top left. On every page 12 returns to the menu.
function ddiPages(avionics) {
  const go = (ddi, page) => () => { ddi.page = page; };
  return ddi => ({
    MENU: {
      draw(ctx, size) { title(ctx, size, "SUPT"); },
      buttons: [
        [5, "RDR", go(ddi, "RDR")], [6, "SMS", go(ddi, "SMS")], [7, "EW", go(ddi, "EW")],
        [19, "ENG", go(ddi, "ENG")], [18, "FCS", go(ddi, "FCS")], [17, "ADI", go(ddi, "ADI")],
      ],
    },
    RDR: {
      draw: drawRadarPage,
      buttons: [
        [19, "RNG+", () => { avionics.radarRange = Math.min(RADAR_RANGES_KM.length - 1, avionics.radarRange + 1); }],
        [18, "RNG-", () => { avionics.radarRange = Math.max(0, avionics.radarRange - 1); }],
        [0, () => RADAR_MODES[avionics.radarMode], () => { avionics.radarMode = (avionics.radarMode + 1) % 3; }],
      ],
    },
    SMS: {
      draw: drawStoresPage,
      buttons: [[0, "SRM", () => { avionics.masterMode = "AA"; }], [4, () => (avionics.masterArm ? "ARM" : "SAFE"), null]],
    },
    EW: {
      draw: drawWarningPage,
      buttons: [
        [0, () => (avionics.rwrOn ? "RWR ON" : "RWR OFF"), () => { avionics.rwrOn = !avionics.rwrOn; }],
        [4, () => (avionics.dispenserOn ? "CMDS ON" : "CMDS OFF"), () => { avionics.dispenserOn = !avionics.dispenserOn; }],
      ],
    },
    ENG: { draw: drawEnginePage, buttons: [] },
    FCS: { draw: drawFlightControlsPage, buttons: [] },
    ADI: { draw: drawAttitudePage, buttons: [] },
  });
}

function osbPosition(index, half) {
  const step = half * 0.44;
  const along = (index % 5 - 2) * step, edge = half + 0.011;
  if (index < 5) return [along, edge];
  if (index < 10) return [edge, -along];
  if (index < 15) return [-along, -edge];
  return [-edge, along];
}

function osbLabelPosition(index, size) {
  const step = size * 0.2;
  const along = size / 2 + (index % 5 - 2) * step, near = size * 0.06, far = size * 0.94;
  if (index < 5) return [along, near, "center"];
  if (index < 10) return [far, size - along, "right"];
  if (index < 15) return [size - along, far, "center"];
  return [near, along, "left"];
}

// ------------------------------------------------------------------------------------- build

export function createPanel(avionics, actions) {
  const group = new THREE.Group();
  const shell = metal("#3a4046", 0.8, 0.15);
  const dark = metal("#16191c", 0.85, 0.1);
  const trim = metal("#5a636b", 0.5, 0.45);
  const black = metal("#0c0e10", 0.7, 0.1);

  const switches = createSwitches(group);
  const { button, toggle, knob, light, register, moving } = switches;
  const screens = [];       // displays redrawn a few times a second

  const addBox = (w, h, d, x, y, z, material = shell, parent = group) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  // ------------------------------------------------------------------------------ front panel

  const art = new Art(-0.47, -0.13, 0.94, 0.6);
  const zone = {
    masterArm: [-0.3, -0.195, -0.16, -0.335],
    leftLights: [-0.44, -0.195, -0.31, -0.335],
    rightLights: [0.31, -0.195, 0.44, -0.335],
    hudControl: [0.16, -0.195, 0.3, -0.335],
    ufc: [-0.145, -0.17, 0.145, -0.345],
    gear: [-0.45, -0.345, -0.365, -0.69],
    ifei: [-0.355, -0.555, -0.135, -0.69],
    standby: [0.135, -0.555, 0.355, -0.69],
    rwr: [0.365, -0.345, 0.45, -0.69],
  };
  art.module(...zone.masterArm, "MASTER ARM");
  art.module(...zone.leftLights, "WARNING");
  art.module(...zone.rightLights, "CAUTION");
  art.module(...zone.hudControl, "HUD");
  art.module(...zone.ufc);
  art.module(...zone.gear, "GEAR");
  art.module(...zone.ifei, "ENGINE / FUEL");
  art.module(...zone.standby, "STANDBY");
  art.module(...zone.rwr, "EW");
  const ddiCenters = [[-0.25, -0.447], [0.25, -0.447]];
  const ampcdCenter = [0, -0.46];
  for (const [x, y] of [...ddiCenters, ampcdCenter]) art.bezel(x, y, 0.2);

  // Master arm panel.
  art.label("ARM", -0.262, -0.222, 13);
  art.label("SAFE", -0.262, -0.296, 13);
  toggle(-0.262, -0.259, "MASTER ARM", ["SAFE", "ARM"], () => (avionics.masterArm ? 1 : 0), v => { avionics.masterArm = v === 1; });
  button(-0.208, -0.23, 0.034, 0.028, "A/A MASTER MODE", () => { avionics.masterMode = avionics.masterMode === "AA" ? "NAV" : "AA"; },
    { text: "A/A", tip: () => `MASTER MODE: ${avionics.masterMode}` });
  button(-0.208, -0.268, 0.034, 0.028, "A/G MASTER MODE", () => { avionics.masterMode = avionics.masterMode === "AG" ? "NAV" : "AG"; },
    { text: "A/G", tip: () => `MASTER MODE: ${avionics.masterMode}` });
  light(-0.208, -0.305, 0.034, 0.018, ["READY"], GREEN, () => avionics.realistic && avionics.canFire);
  button(-0.175, -0.305, 0.022, 0.022, "EMERGENCY JETTISON", () => avionics.jettison(), { color: "#7d6a1e" });

  // Warning lights and the master caution.
  light(-0.415, -0.225, 0.04, 0.022, ["FIRE", "LEFT"], "#ff4b3e", () => false);
  light(-0.36, -0.225, 0.05, 0.022, ["GO"], GREEN, () => avionics.realistic && avionics.radarOn && avionics.seekerOn);
  light(-0.36, -0.252, 0.05, 0.022, ["NO GO"], AMBER, () => avionics.realistic && !(avionics.radarOn && avionics.seekerOn));
  button(-0.385, -0.29, 0.06, 0.03, "MASTER CAUTION", () => actions.acknowledge(), { text: "CAUTION", tip: () => "MASTER CAUTION: press to reset" });
  light(-0.335, -0.29, 0.03, 0.022, ["SPD", "BRK"], GREEN, () => avionics.speedBrake);
  const masterLight = { on: false };
  light(-0.385, -0.318, 0.06, 0.012, ["MASTER"], AMBER, () => masterLight.on);

  // Up-front controller: the keypad, its displays and the option buttons.
  const ufc = liveCanvas(512, 96);
  const ufcOptions = liveCanvas(160, 320);
  const screenPlane = (texture, w, h, x, y, parent = group) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    mesh.position.set(x, y, FACE_Z + 0.003);
    parent.add(mesh);
    return mesh;
  };
  screenPlane(ufc.texture, 0.18, 0.034, -0.03, -0.192);
  screenPlane(ufcOptions.texture, 0.058, 0.116, 0.092, -0.272);
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "ENT"];
  keys.forEach((key, i) => {
    button(-0.112 + (i % 3) * 0.04, -0.229 - Math.floor(i / 3) * 0.0245, 0.034, 0.021, `KEY ${key}`, () => avionics.ufcKey(key), { text: key });
  });
  ["ATT", "HDG", "BALT", "OFF", ""].forEach((option, i) => {
    button(0.056, -0.222 - i * 0.0245, 0.018, 0.02, `OPTION ${i + 1}`, () => avionics.ufcOption(i, actions.flight()),
      { tip: () => (avionics.ufc.function === "A/P" && option ? `A/P ${option}` : `OPTION ${i + 1}`) });
  });
  ["A/P", "BINGO", "TCN", "ILS", "D/L", "BCN"].forEach((name, i) => {
    button(-0.112 + (i % 6) * 0.0425, -0.333, 0.038, 0.016, `${name} FUNCTION`, () => avionics.ufcFunction(name, actions.flight()), { text: name });
  });
  art.label("COMM 1", -0.136, -0.178, 11);
  art.label("COMM 2", 0.136, -0.178, 11);
  knob(-0.128, -0.204, 0.012, "VOICE VOLUME", () => avionics.commVolume[0], v => { avionics.commVolume[0] = v; }, v => `${Math.round(v * 100)}%`);
  knob(0.128, -0.204, 0.012, "TONE VOLUME", () => avionics.commVolume[1], v => { avionics.commVolume[1] = v; }, v => `${Math.round(v * 100)}%`);

  // HUD control panel.
  art.label("SYM", 0.198, -0.22, 13);
  art.label("BRT", 0.262, -0.22, 13);
  art.label("NORM", 0.198, -0.262, 11);
  art.label("REJ 2", 0.198, -0.32, 11);
  toggle(0.198, -0.29, "HUD SYMBOLS", HUD_REJECT, () => avionics.hudReject, v => { avionics.hudReject = v; });
  knob(0.262, -0.275, 0.016, "HUD BRIGHTNESS", () => avionics.hudBrightness, v => { avionics.hudBrightness = v; }, v => `${Math.round(v * 100)}%`, { low: 0.1 });

  // Caution lights, driven by the systems.
  const cautionNames = [["BINGO"], ["FUEL LO"], ["L GEN"], ["GEAR SPD"], ["NO MSL"], ["CMDS"], ["RADAR"], ["SPD BRK"]];
  const cautionState = { on: new Set() };
  cautionNames.forEach((words, i) => {
    light(0.345 + (i % 2) * 0.056, -0.225 - Math.floor(i / 2) * 0.026, 0.05, 0.021, words, AMBER, () => cautionState.on.has(words[0]));
  });
  light(0.372, -0.325, 0.05, 0.018, ["FIRE", "RIGHT"], "#ff4b3e", () => false);

  // The two digital displays and the map between them, each ringed with its buttons.
  const pagesFor = ddiPages(avionics);
  const mapState = { range: 1 };

  function display(center, startPage, name, powerIndex) {
    const { canvas, ctx, texture } = liveCanvas(SCREEN_PIXELS, SCREEN_PIXELS);
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    const half = 0.081;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), material);
    mesh.position.set(center[0], center[1], FACE_Z + 0.002);
    group.add(mesh);
    const screen = { page: startPage, ctx, canvas, texture, material, powerIndex };
    screen.pages = pagesFor(screen);
    for (let index = 0; index < 20; index++) {
      const [dx, dy] = osbPosition(index, half);
      button(center[0] + dx, center[1] + dy, 0.016, 0.016, `${name} BUTTON ${index + 1}`, () => {
        if (index === 12) { screen.page = "MENU"; return; }
        const entry = screen.pages[screen.page].buttons.find(([at]) => at === index);
        entry?.[2]?.();
      }, {
        tip: () => {
          if (index === 12) return "MENU";
          const entry = screen.pages[screen.page].buttons.find(([at]) => at === index);
          if (!entry) return `${name} BUTTON ${index + 1}`;
          return typeof entry[1] === "function" ? entry[1]() : entry[1];
        },
      });
    }
    screens.push(screen);
    return screen;
  }

  const ddis = [display(ddiCenters[0], "RDR", "LEFT DDI", 0), display(ddiCenters[1], "SMS", "RIGHT DDI", 1)];
  ddis.forEach((ddi, i) => {
    const [x, y] = ddiCenters[i];
    knob(x - 0.088, y + 0.088, 0.009, `${i ? "RIGHT" : "LEFT"} DDI POWER`, () => avionics.ddiPower[i],
      v => { avionics.ddiPower[i] = v; }, v => ["OFF", "NIGHT", "DAY"][v], { low: 0, high: 2, step: 1 });
  });

  const ampcd = (() => {
    const { canvas, ctx, texture } = liveCanvas(SCREEN_PIXELS, SCREEN_PIXELS);
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    const half = 0.081;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), material);
    mesh.position.set(ampcdCenter[0], ampcdCenter[1], FACE_Z + 0.002);
    group.add(mesh);
    const screen = { ctx, canvas, texture, material };
    [[7, "RNG+", () => { mapState.range = Math.min(RADAR_RANGES_KM.length - 1, mapState.range + 1); }],
      [6, "RNG-", () => { mapState.range = Math.max(0, mapState.range - 1); }]].forEach(([index, name, act]) => {
      const [dx, dy] = osbPosition(index, half);
      button(ampcdCenter[0] + dx, ampcdCenter[1] + dy, 0.016, 0.016, `MAP ${name}`, act);
    });
    return screen;
  })();
  knob(ampcdCenter[0] + 0.088, ampcdCenter[1] + 0.088, 0.009, "MAP BRIGHTNESS", () => avionics.ampcdBrightness,
    v => { avionics.ampcdBrightness = v; }, v => `${Math.round(v * 100)}%`, { low: 0.2 });

  // Gear handle, flaps, hook.
  const handle = new THREE.Group();
  handle.position.set(-0.408, -0.455, FACE_Z + 0.01);
  group.add(handle);
  const handleArm = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.09, 0.02), trim);
  handleArm.position.y = -0.04;
  handle.add(handleArm);
  const handleWheel = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.009, 10, 22).rotateX(Math.PI / 2), metal("#d8d4c6", 0.5, 0.2));
  handleWheel.position.set(0, -0.09, 0.016);
  handle.add(handleWheel);
  moving.push(() => { handle.position.y = avionics.gearDown ? -0.482 : -0.42; });
  const handleHit = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.05), new THREE.MeshBasicMaterial({ visible: false }));
  handleHit.position.y = -0.065;
  handle.add(handleHit);
  register(handleHit, {
    name: "LANDING GEAR",
    tip: () => `LANDING GEAR: ${avionics.gearDown ? "DOWN" : "UP"}`,
    act: () => { avionics.gearDown = !avionics.gearDown; },
    mesh: null,
  });
  ["NOSE", "LEFT", "RIGHT"].forEach((word, i) => {
    light(-0.408 + (i - 1) * 0.024, -0.37, 0.022, 0.016, [word], GREEN, () => avionics.gearDown);
  });
  art.label("FLAPS", -0.408, -0.585, 12);
  art.label("AUTO", -0.38, -0.606, 10);
  art.label("FULL", -0.38, -0.646, 10);
  toggle(-0.42, -0.625, "FLAPS", FLAP_MODES, () => avionics.flaps, v => { avionics.flaps = v; }, { inverted: true });
  art.label("HOOK", -0.408, -0.668, 11);

  // Engine and fuel readout, with the bingo setting beside it.
  const ifei = liveCanvas(512, 160);
  screenPlane(ifei.texture, 0.19, 0.06, -0.245, -0.615);
  button(-0.145, -0.598, 0.014, 0.014, "BINGO UP", () => { avionics.bingo = Math.min(4900, avionics.bingo + 100); }, { tip: () => `BINGO ${Math.round(avionics.bingo)} KG` });
  button(-0.145, -0.626, 0.014, 0.014, "BINGO DOWN", () => { avionics.bingo = Math.max(0, avionics.bingo - 100); }, { tip: () => `BINGO ${Math.round(avionics.bingo)} KG` });

  // Standby instruments.
  const standbyGauges = [["KTS", 450, x => x], ["FT", 50000, x => x]].map(([unit, full], i) => {
    const gauge = liveCanvas(192, 192);
    screenPlane(gauge.texture, 0.075, 0.075, 0.19 + i * 0.088, -0.622);
    return { ...gauge, unit, full };
  });
  const rwrScope = liveCanvas(192, 192);
  screenPlane(rwrScope.texture, 0.07, 0.07, 0.408, -0.42);

  // Countermeasures, in the EW panel.
  art.label("CMDS", 0.408, -0.475, 12);
  toggle(0.385, -0.515, "DISPENSER", ["OFF", "ON"], () => (avionics.dispenserOn ? 1 : 0), v => { avionics.dispenserOn = v === 1; });
  art.label("OFF", 0.385, -0.548, 10);
  button(0.425, -0.515, 0.028, 0.026, "DISPENSE FLARES", () => actions.dispense(), { text: "FLR", tip: () => `DISPENSE FLARES: ${avionics.flareCount} left` });
  art.label("RWR", 0.408, -0.58, 12);
  toggle(0.385, -0.615, "RWR POWER", ["OFF", "ON"], () => (avionics.rwrOn ? 1 : 0), v => { avionics.rwrOn = v === 1; });
  art.label("OFF", 0.385, -0.648, 10);

  art.texture.needsUpdate = true;
  const faceMaterial = new THREE.MeshStandardMaterial({
    map: art.texture, roughness: 0.9, metalness: 0, emissive: "#ffffff", emissiveMap: art.texture, emissiveIntensity: 0,
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.6), faceMaterial);
  face.position.set(0, -0.43, FACE_Z);
  group.add(face);
  addBox(0.96, 0.62, 0.02, 0, -0.43, FACE_Z - 0.015, dark);

  // Glareshield over the panel.
  const hood = new THREE.Shape();
  hood.moveTo(-0.47, -0.16);
  hood.quadraticCurveTo(0, -0.06, 0.47, -0.16);
  hood.lineTo(0.47, -0.195);
  hood.quadraticCurveTo(0, -0.125, -0.47, -0.195);
  const shield = new THREE.Mesh(new THREE.ExtrudeGeometry(hood, { depth: 0.1, bevelEnabled: false }), black);
  shield.position.z = FACE_Z - 0.04;
  group.add(shield);

  // HUD: housing, side frames, combiner, and symbols placed far out, so they stay on the world.
  addBox(0.17, 0.028, 0.08, 0, -0.1, -0.57, dark);
  for (const side of [-1, 1]) addBox(0.008, 0.25, 0.012, side * 0.125, 0.03, -0.615, trim);
  addBox(0.258, 0.008, 0.012, 0, 0.157, -0.615, trim);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.25), new THREE.MeshBasicMaterial({
    color: "#a8ffd8", transparent: true, opacity: 0.04, depthWrite: false, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  }));
  glass.position.set(0, 0.03, -0.615);
  glass.renderOrder = 1;
  group.add(glass);
  const hudCanvas = liveCanvas(768, 768);
  const HUD_DISTANCE = 30;
  const hudSize = 2 * HUD_DISTANCE * Math.tan(13 * DEG);
  const symbols = new THREE.Mesh(new THREE.PlaneGeometry(hudSize, hudSize), new THREE.MeshBasicMaterial({
    map: hudCanvas.texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
    blending: THREE.AdditiveBlending, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc,
  }));
  symbols.position.z = -HUD_DISTANCE;
  symbols.renderOrder = 2;
  group.add(symbols);

  // ---------------------------------------------------------------------------- consoles

  // Switches sit at the forward end of each console, where a turn of the head reaches them.
  const OFF_ON = ["OFF", "ON"];
  const ROW_STEP = 0.095;
  const ROW_HEIGHT = 0.088;
  const COLUMNS = { 1: [0], 2: [-0.042, 0.042], 3: [-0.056, 0, 0.056] };

  function consoleRows(left, parent) {
    const opts = { parent, z: 0 };
    const flip = (label, name, positions, get, set) => [label, (x, y) => toggle(x, y, name, positions, get, set, opts)];
    const flag = (label, name, positions, key) => flip(label, name, positions, () => avionics[key], v => { avionics[key] = v; });
    const generator = (label, name, index) => flip(label, name, ["OFF", "NORM"], () => (avionics.genOn[index] ? 1 : 0), v => { avionics.genOn[index] = v === 1; });
    const rotary = (label, name, key, names) => [label, (x, y) => knob(x, y, 0.017, name, () => avionics[key], v => { avionics[key] = v; },
      v => names[v], { ...opts, low: 0, high: names.length - 1, step: 1 })];
    if (left) {
      return [
        ["EXT LTS", [flag("POSITION", "POSITION LIGHTS", OFF_ON, "positionLights"), flag("STROBE", "STROBE", OFF_ON, "strobe"),
          flag("FORMATION", "FORMATION LIGHTS", OFF_ON, "formationLights")]],
        ["FUEL / OXY", [flag("PROBE", "REFUEL PROBE", ["RETRACT", "EXTEND"], "probe"), flag("DUMP", "FUEL DUMP", OFF_ON, "fuelDump"),
          flag("OBOGS", "OBOGS", OFF_ON, "obogs")]],
        ["ELECTRICAL", [generator("L GEN", "LEFT GENERATOR", 0), generator("R GEN", "RIGHT GENERATOR", 1), flag("APU", "APU", OFF_ON, "apu")]],
        ["ENGINE", [flag("CRANK", "ENGINE CRANK", ["L", "OFF", "R"], "crank")]],
      ];
    }
    return [
      ["SENSORS", [rotary("RADAR", "RADAR", "radarMode", RADAR_MODES), rotary("INS", "INS", "ins", ["OFF", "GYRO", "NAV"])]],
      ["INTR LT", [rotary("CONSOLES", "CONSOLE LIGHTS", "consoleLights", LIGHT_MODES), rotary("INST PNL", "PANEL LIGHTS", "panelLights", LIGHT_MODES)]],
      ["ECS", [["TEMP", (x, y) => knob(x, y, 0.015, "CABIN TEMP", () => avionics.cabinTemp, v => { avionics.cabinTemp = v; }, v => `${Math.round(v * 100)}%`, opts)],
        flag("BLEED", "BLEED AIR", ["OFF", "NORM"], "bleed"), flag("ANTI ICE", "ANTI ICE", OFF_ON, "antiIce")]],
      ["FLIGHT", [flip("SPD BRK", "SPEED BRAKE", ["IN", "OUT"], () => (avionics.speedBrake ? 1 : 0), v => { avionics.speedBrake = v === 1; })]],
    ];
  }

  const consoleMaterials = [];
  for (const side of [-1, 1]) {
    addBox(0.19, 0.07, 1.12, side * 0.35, -0.47, 0.02);
    addBox(0.02, 0.5, 1.34, side * 0.45, -0.42, -0.1, dark);
    addBox(0.05, 0.03, 1.5, side * 0.46, -0.17, -0.07, trim);

    const paint = new Art(-0.09, 0.56, 0.18, 1.12, "#1a1d20");
    const parent = new THREE.Group();
    parent.position.set(side * 0.35, -0.43, 0.02);
    parent.rotation.x = -Math.PI / 2;
    group.add(parent);

    const rows = consoleRows(side < 0, parent);
    rows.forEach(([name, items], row) => {
      const top = 0.525 - row * ROW_STEP;
      paint.module(-0.085, top, 0.085, top - ROW_HEIGHT, name);
      items.forEach(([label, build], column) => {
        const x = COLUMNS[items.length][column];
        paint.label(label, x, top - 0.03, 11);
        build(x, top - 0.062);
      });
    });
    paint.module(-0.085, 0.525 - rows.length * ROW_STEP, 0.085, -0.52, "STOWAGE");

    paint.texture.needsUpdate = true;
    const consoleMaterial = new THREE.MeshStandardMaterial({
      map: paint.texture, roughness: 0.8, emissive: "#ffffff", emissiveMap: paint.texture, emissiveIntensity: 0,
    });
    consoleMaterials.push(consoleMaterial);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 1.12), consoleMaterial);
    top.rotation.x = -Math.PI / 2;
    top.position.set(side * 0.35, -0.434, 0.02);
    group.add(top);
  }
  addBox(0.98, 0.02, 1.4, 0, -0.74, -0.1, dark);

  // Seat, bulkhead, and the loop of the ejection handle.
  addBox(0.26, 0.26, 0.09, 0, -0.1, 0.47, dark);
  addBox(0.42, 0.5, 0.1, 0, -0.45, 0.48, shell);
  addBox(0.91, 0.42, 0.02, 0, -0.42, 0.58, shell);
  const ejectHandle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.009, 8, 22), metal("#e0b020", 0.5, 0.1));
  ejectHandle.position.set(0, -0.24, 0.43);
  group.add(ejectHandle);

  const flightControls = addFlightControls(group);

  // Canopy bow and the arch behind, heavier than the frame they replace.
  const arch = (points, radius) => new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), 48, radius, 8), trim);
  group.add(arch([[-0.47, -0.18, -0.52], [-0.38, 0.11, -0.48], [0, 0.35, -0.43], [0.38, 0.11, -0.48], [0.47, -0.18, -0.52]], 0.014));
  group.add(arch([[-0.47, -0.18, 0.62], [-0.35, 0.16, 0.62], [0, 0.33, 0.62], [0.35, 0.16, 0.62], [0.47, -0.18, 0.62]], 0.012));
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.56),
    new THREE.MeshBasicMaterial({ color: "#cfe4ff", transparent: true, opacity: 0.025, side: THREE.BackSide, depthWrite: false }));
  canopy.scale.set(0.82, 0.68, 1.25);
  canopy.position.y = -0.1;
  group.add(canopy);

  // -------------------------------------------------------------------------------- drawing

  function drawScreen(screen, data, draw) {
    const { ctx } = screen;
    const size = screen.canvas.width;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#031008";
    ctx.fillRect(0, 0, size, size);
    draw(ctx, size, data);
    screen.texture.needsUpdate = true;
  }

  function drawDdi(ddi, data) {
    const page = ddi.pages[ddi.page];
    drawScreen(ddi, data, (ctx, size) => {
      ctx.textBaseline = "alphabetic";
      page.draw(ctx, size, data);
      ctx.textBaseline = "middle";
      ctx.fillStyle = GREEN;
      ctx.font = `${size * 0.042}px ${FONT}`;
      for (const [index, label] of [...page.buttons, [12, "MENU"]]) {
        const [x, y, align] = osbLabelPosition(index, size);
        ctx.textAlign = align;
        ctx.fillText(typeof label === "function" ? label() : label, x, y);
      }
    });
    const power = avionics.realistic ? avionics.ddiPower[ddi.powerIndex] : 2;
    ddi.material.color.setScalar([0.02, 0.4, 1][power]);
  }

  function drawUfc(flight) {
    const { ctx, canvas, texture } = ufc;
    const a = avionics.ufc;
    ctx.fillStyle = "#06120b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = GREEN;
    ctx.font = `44px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const prompt = a.entry || a.message || (a.function ?? "");
    ctx.fillText(prompt, 16, 50);
    ctx.textAlign = "right";
    const setting = avionics.autopilot === "HDG" ? `HDG ${String(avionics.selectedHeading).padStart(3, "0")}`
      : avionics.autopilot === "BALT" ? `ALT ${avionics.selectedAltitude}` : `${String(Math.round(flight.heading)).padStart(3, "0")}`;
    ctx.fillText(setting, canvas.width - 16, 50);
    texture.needsUpdate = true;

    const options = ufcOptions;
    options.ctx.fillStyle = "#06120b";
    options.ctx.fillRect(0, 0, 160, 320);
    options.ctx.fillStyle = GREEN;
    options.ctx.font = `30px ${FONT}`;
    options.ctx.textAlign = "left";
    options.ctx.textBaseline = "middle";
    const names = a.function === "A/P" ? [...AUTOPILOT_MODES, "OFF", ""] : ["", "", "", "", ""];
    names.forEach((name, i) => {
      const mark = name && avionics.autopilot === name ? ":" : " ";
      options.ctx.fillText(`${mark}${name}`, 8, 34 + i * 62);
    });
    options.texture.needsUpdate = true;
  }

  function drawIfei(flight) {
    const { ctx, canvas, texture } = ifei;
    ctx.fillStyle = "#07090a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffcb73";
    ctx.font = `38px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const out = avionics.flamedOut;
    const rpm = out ? 12 : Math.round(68 + flight.throttle * 32);
    const temp = out ? 180 : Math.round(420 + flight.throttle * 420);
    ctx.fillText(`RPM ${rpm}  ${rpm}`, 16, 42);
    ctx.fillText(`TMP ${temp} ${temp}`, 16, 112);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(avionics.fuel)}`, canvas.width - 14, 42);
    ctx.fillText(`B ${Math.round(avionics.bingo)}`, canvas.width - 14, 112);
    texture.needsUpdate = true;
  }

  function drawGauge(gauge, value) {
    const { ctx, canvas, texture, unit, full } = gauge;
    const size = canvas.width, m = size / 2;
    ctx.fillStyle = "#080a0b";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = ctx.fillStyle = WHITE;
    ctx.lineWidth = 2;
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      line(ctx, m + Math.sin(a) * 80, m - Math.cos(a) * 80, m + Math.sin(a) * 90, m - Math.cos(a) * 90);
    }
    ctx.font = `20px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(unit, m, m + 36);
    const angle = value / full * Math.PI * 2;
    ctx.lineWidth = 4;
    line(ctx, m, m, m + Math.sin(angle) * 72, m - Math.cos(angle) * 72);
    texture.needsUpdate = true;
  }

  function drawRwrScope(target) {
    const { ctx, canvas, texture } = rwrScope;
    const size = canvas.width, m = size / 2;
    ctx.fillStyle = "#020805";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = ctx.fillStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(m, m, 80, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(m, m, 40, 0, 7); ctx.stroke();
    if (avionics.rwrOn && target) {
      const angle = target.azimuth * DEG, reach = target.threat > 0 ? 40 : 66;
      ctx.font = `28px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(target.threat > 0 ? "T" : "U", m + Math.sin(angle) * reach, m - Math.cos(angle) * reach);
    }
    texture.needsUpdate = true;
  }

  // One display per frame, so a redraw of all of them never lands on a single frame.
  const screenJobs = [
    data => drawDdi(ddis[0], data),
    data => drawDdi(ddis[1], data),
    data => {
      drawScreen(ampcd, data, drawMapPage);
      ampcd.material.color.setScalar(avionics.realistic ? avionics.ampcdBrightness : 1);
    },
    data => drawUfc(data.flight),
    data => drawIfei(data.flight),
    data => drawGauge(standbyGauges[0], data.flight.knots),
    data => drawGauge(standbyGauges[1], data.flight.feet),
    data => drawRwrScope(data.target),
  ];
  let nextJob = 0;

  return {
    group,
    hud: hudCanvas,

    // Everything that moves with a switch or with the flight, once a frame.
    update(dt, data) {
      const { flight, stickInput } = data;
      masterLight.on = avionics.masterCaution(flight.knots);
      cautionState.on = avionics.cautions(flight.knots);
      switches.update(dt);
      const glow = level => 0.28 + (avionics.realistic ? level * 0.3 : 0);
      faceMaterial.emissiveIntensity = glow(avionics.panelLights);
      for (const material of consoleMaterials) material.emissiveIntensity = glow(avionics.consoleLights);

      flightControls.update(stickInput, flight.throttle);

      screenJobs[nextJob]({ ...data, mapRange: mapState.range });
      nextJob = (nextJob + 1) % screenJobs.length;
      if (avionics.realistic && !avionics.powered) for (const ddi of ddis) ddi.material.color.setScalar(0.02);
    },

    pick: switches.pick,
    pickNearest: switches.pickNearest,
    mark: switches.mark,
    use: switches.use,
  };
}
