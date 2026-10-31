// The aircraft systems behind the cockpit's switches. In Easy mode they all stay out of the way, so
// a lock is all it takes to fire. In Realistic the jet does what its switches say.

const MISSILES = 6;
const FLARES = 30;
const FUEL_KG = 4900;
const BINGO_KG = 1200;
const BURN_KG_PER_S = [0.8, 10];    // at idle and at full throttle, so a tank lasts 8 to 13 minutes of flying
const DUMP_KG_PER_S = 50;
const GEAR_LIMIT_KTS = 250;
const GRAVITY = 9.8;
const G_LIMIT = 7.5;            // what the flight controls will let you pull
const CORNER_SPEED = 170;       // meters per second; below this the wing gives out before the limiter
const FLAP_CORNER_SHARE = 0.06; // how much of that each flap stage takes off
export const PUSH_SHARE = 0.4;  // pushing is limited to this share of pulling

export const RADAR_RANGES_KM = [5, 10, 20, 40];
export const RADAR_MODES = ["OFF", "STBY", "OPR"];
export const FLAP_MODES = ["AUTO", "HALF", "FULL"];
export const HUD_REJECT = ["NORM", "REJ 1", "REJ 2"];
export const LIGHT_MODES = ["OFF", "DIM", "BRT"];
export const AUTOPILOT_MODES = ["ATT", "HDG", "BALT"];

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export class Avionics {
  realistic = false;
  simple = false;           // the Old Bucket: only arming, gear, flaps, speed brake and flares

  masterMode = "NAV";       // NAV, AA or AG
  masterArm = false;
  missiles = MISSILES;
  selectedStation = 0;
  flares = FLARES;
  dispenserOn = true;

  radarMode = 2;
  radarRange = 1;           // index into RADAR_RANGES_KM
  rwrOn = true;

  hudBrightness = 0.85;
  hudReject = 0;
  ddiPower = [2, 2];        // left and right: OFF, NIGHT, DAY
  ampcdBrightness = 0.9;
  panelLights = 0;
  consoleLights = 0;
  commVolume = [0.8, 0.5];  // radio voices, and the warning tones

  genOn = [true, true];
  apu = 0;
  crank = 1;
  ins = 2;
  obogs = 1;
  bleed = 1;
  antiIce = 0;
  cabinTemp = 0.5;
  positionLights = 0;
  strobe = 0;
  formationLights = 0;
  probe = 0;
  fuelDump = 0;

  gearDown = false;
  flaps = 0;
  speedBrake = false;
  hook = false;
  antiSkid = true;
  fcsReset = 0;

  autopilot = null;         // one of AUTOPILOT_MODES while engaged
  selectedHeading = 0;
  selectedAltitude = 0;

  fuel = FUEL_KG;
  bingo = BINGO_KG;
  ufc = { function: null, entry: "", message: "" };

  cautionAcknowledged = new Set();

  // Flying out of fuel costs thrust, not the instruments: the HUD is how you find out.
  get powered() {
    return !this.realistic || this.simple || this.genOn.some(Boolean);
  }

  get fuelWarning() {
    if (!this.realistic) return null;
    if (this.flamedOut) return "FLAMEOUT";
    if (this.fuel < 800) return "FUEL LOW";
    return this.fuel < this.bingo ? "BINGO" : null;
  }

  get armed() {
    return !this.realistic || (this.masterArm && (this.simple || this.masterMode === "AA"));
  }

  get seekerOn() {
    return !this.realistic || this.simple || this.masterMode === "AA";
  }

  get radarOn() {
    return !this.realistic || this.simple || (this.powered && RADAR_MODES[this.radarMode] === "OPR");
  }

  get canFire() {
    return this.armed && (!this.realistic || this.missiles > 0);
  }

  get flamedOut() {
    return this.realistic && this.fuel <= 0;
  }

  get flareCount() {
    return this.realistic ? this.flares : FLARES;
  }

  // Speed the jet can reach, and how much the flaps add to its pull rate.
  get speedLimit() {
    if (!this.realistic) return Infinity;
    let limit = Infinity;
    if (this.gearDown) limit = Math.min(limit, 150);
    if (this.flaps === 1) limit = Math.min(limit, 240);
    if (this.flaps === 2) limit = Math.min(limit, 170);
    if (this.speedBrake) limit = Math.min(limit, 200);
    return limit;
  }

  get pullBonus() {
    return this.realistic ? 1 + this.flaps * 0.12 : 1;
  }

  // How many G the jet can pull at this speed. Turn rate is best right at corner speed.
  availableG(speed) {
    if (!this.realistic) return Infinity;
    const corner = CORNER_SPEED * (1 - this.flaps * FLAP_CORNER_SHARE);
    return G_LIMIT * Math.min(1, (speed / corner) ** 2);
  }

  // The fastest the flight path can turn, radians per second. One G just holds the jet up.
  turnLimit(speed) {
    const g = this.availableG(speed);
    return g === Infinity ? Infinity : Math.sqrt(Math.max(0, g * g - 1)) * GRAVITY / speed;
  }

  launched() {
    if (this.realistic) this.missiles--;
  }

  // Returns true when flares actually left the aircraft.
  dispense() {
    if (!this.realistic) return true;
    if ((!this.simple && !this.dispenserOn) || this.flares <= 0) return false;
    this.flares--;
    return true;
  }

  jettison() {
    this.missiles = 0;
  }

  // The reset on the phone puts the jet back in the air, full of fuel and missiles.
  replenish() {
    this.missiles = MISSILES;
    this.flares = FLARES;
    this.fuel = FUEL_KG;
    this.cautionAcknowledged.clear();
  }

  // Which caution lights are on, by name.
  cautions(knots) {
    if (!this.realistic) return new Set();
    const on = new Set();
    if (this.fuel < this.bingo) on.add("BINGO");
    if (this.fuel < 800) on.add("FUEL LO");
    if (!this.genOn[0]) on.add("L GEN");
    if (this.gearDown && knots > GEAR_LIMIT_KTS) on.add("GEAR SPD");
    if (this.missiles <= 0) on.add("NO MSL");
    if (!this.dispenserOn || this.flares <= 0) on.add("CMDS");
    if (RADAR_MODES[this.radarMode] === "OFF") on.add("RADAR");
    if (this.speedBrake) on.add("SPD BRK");
    return on;
  }

  // The master caution lights for a new caution and stays on until pressed.
  masterCaution(knots) {
    const on = this.cautions(knots);
    for (const name of this.cautionAcknowledged) if (!on.has(name)) this.cautionAcknowledged.delete(name);
    return [...on].some(name => !this.cautionAcknowledged.has(name));
  }

  acknowledgeCautions(knots) {
    for (const name of this.cautions(knots)) this.cautionAcknowledged.add(name);
  }

  // The up-front keypad: a function button picks what the digits will set.
  ufcFunction(name, flight) {
    const { ufc } = this;
    ufc.entry = "";
    ufc.function = ufc.function === name ? null : name;
    ufc.message = "";
    if (name === "A/P" && ufc.function) {
      ufc.message = this.autopilot ? `A/P ${this.autopilot}` : "A/P OFF";
      this.selectedHeading = Math.round(flight.heading);
      this.selectedAltitude = Math.round(flight.feet / 100) * 100;
    }
  }

  ufcOption(index, flight) {
    if (this.ufc.function !== "A/P") return;
    const mode = AUTOPILOT_MODES[index];
    if (!mode && index === 3) {
      this.autopilot = null;
      this.ufc.message = "A/P OFF";
      return;
    }
    if (!mode) return;
    this.autopilot = this.autopilot === mode ? null : mode;
    if (mode === "HDG") this.selectedHeading = Math.round(flight.heading);
    if (mode === "BALT") this.selectedAltitude = Math.round(flight.feet / 100) * 100;
    this.ufc.message = this.autopilot ? `A/P ${this.autopilot}` : "A/P OFF";
  }

  ufcKey(key) {
    const { ufc } = this;
    if (key === "CLR") {
      ufc.entry = ufc.entry.slice(0, -1);
    } else if (key === "ENT") {
      const value = Number(ufc.entry);
      if (ufc.entry && this.autopilot === "HDG") this.selectedHeading = clamp(value, 0, 360) % 360;
      if (ufc.entry && this.autopilot === "BALT") this.selectedAltitude = clamp(value, 13000, 42000);
      if (ufc.entry && ufc.function === "BINGO") this.bingo = clamp(value, 0, FUEL_KG);
      ufc.entry = "";
    } else if (ufc.entry.length < 5) {
      ufc.entry += key;
    }
  }

  // Stick input overrides the autopilot, as paddling it off would.
  step(dt, throttle, stick) {
    if (!this.realistic || this.simple) this.autopilot = null;
    if (!this.realistic) return;
    if (stick && Math.max(Math.abs(stick.roll), Math.abs(stick.pitch)) > 0.25) this.autopilot = null;
    const burn = BURN_KG_PER_S[0] + (BURN_KG_PER_S[1] - BURN_KG_PER_S[0]) * throttle + (this.fuelDump ? DUMP_KG_PER_S : 0);
    this.fuel = Math.max(0, this.fuel - burn * dt);
  }
}
