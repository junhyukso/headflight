// A procedural fighter cockpit flown with head tracking. No asset files: terrain, clouds, aircraft
// and instruments are all generated here.
import * as THREE from "three";
import { Avionics, PUSH_SHARE } from "/avionics.js";
import { createClassicCockpit } from "/classic.js";
import { Fight } from "/fight.js";
import { drawHud } from "/hud.js";
import { createPanel } from "/panel.js";

const DEG = Math.PI / 180;
const HORIZONTAL_FOV = 70;
const ALTITUDE = 5200;          // meters above sea level
const SPEED = 260;              // meters per second
const CLOUD_LAYER = 2100;       // meters above sea level
const EYE_ABOVE_AXIS = 1.0;     // pilot's eye relative to the fuselage centerline
const EYE_STATION = -4.2;       // and along it
const SUN = new THREE.Vector3(0.52, 0.42, -0.74).normalize();
const UP = new THREE.Vector3(0, 1, 0);

// An arcade flight model: enough to fly around while looking elsewhere, nothing more.
const ROLL_RATE = 120 * DEG;    // radians per second at full stick
const PITCH_RATE = 45 * DEG;
const YAW_RATE = 30 * DEG;
const TURN_ASSIST = 4;          // how hard a bank pulls the nose around
const G_BLEED = 0.4;            // meters per second per second lost per G squared, in Realistic
const MIN_SPEED = 130;          // meters per second at idle and at full throttle
const MAX_SPEED = 420;
// The shaders draw terrain and clouds as seen from above, so stay over the peaks.
const MIN_ALTITUDE = 3900;
const MAX_ALTITUDE = 13000;
export const COCKPITS = { hornot: "Hor'not'", bucket: "Old Bucket" };

const GREEN = "#7dffae";
const TURN_START_PIXELS = 3;    // a knob ignores a hand that shakes while clicking
const MACH_SPEED = 320;         // meters per second at our altitudes
const GRAVITY = 9.8;

// ---------------------------------------------------------------------------------- shaders

const NOISE_GLSL = /* glsl */ `
  uniform sampler2D uNoise;
  const mat2 ROTATE = mat2(0.8, 0.6, -0.6, 0.8);

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return texture2D(uNoise, (i + f + 0.5) / 256.0).r;
  }

  float fbm(vec2 p, int octaves) {
    float sum = 0.0, amp = 0.5, total = 0.0;
    for (int i = 0; i < octaves; i++) {
      sum += amp * vnoise(p);
      total += amp;
      p = ROTATE * p * 2.07;
      amp *= 0.5;
    }
    return sum / total;
  }

  float heightAt(vec2 xz, int octaves) {
    vec2 p = xz / 16000.0;
    float ridges = 0.0, amp = 1.0, total = 0.0;
    for (int i = 0; i < octaves; i++) {
      float ridge = 1.0 - abs(2.0 * vnoise(p) - 1.0);
      ridges += amp * ridge * ridge;
      total += amp;
      p = ROTATE * p * 2.03;
      amp *= 0.5;
    }
    ridges /= total;
    float mountains = smoothstep(0.3, 0.72, vnoise(xz / 90000.0 + 7.0));
    return (ridges - 0.2) * (500.0 + 4600.0 * mountains) - 520.0 + 900.0 * mountains;
  }
`;

const SKY_GLSL = /* glsl */ `
  uniform vec3 uSun;

  vec3 skyColor(vec3 d) {
    float up = max(d.y, 0.0);
    vec3 color = mix(vec3(0.44, 0.6, 0.8), vec3(0.035, 0.11, 0.3), pow(up, 0.5));
    float sun = max(dot(d, uSun), 0.0);
    color += vec3(1.0, 0.82, 0.58) * pow(sun, 6.0) * 0.12;
    color += vec3(1.0, 0.92, 0.75) * pow(sun, 220.0) * 0.8;
    return color;
  }
`;

const skyMaterial = uniforms => new THREE.ShaderMaterial({
  uniforms,
  side: THREE.BackSide,
  depthTest: false,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec3 vDirection;
    void main() {
      vDirection = position;
      gl_Position = (projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0)).xyww;
    }`,
  fragmentShader: /* glsl */ `
    ${NOISE_GLSL}
    ${SKY_GLSL}
    uniform vec2 uOffset;
    varying vec3 vDirection;

    void main() {
      vec3 d = normalize(vDirection);
      vec3 color = skyColor(d);
      color += vec3(30.0, 27.0, 22.0) * smoothstep(0.99994, 0.99999, dot(d, uSun));
      if (d.y > 0.01) {
        vec2 cirrus = d.xz / d.y * 9000.0 + uOffset * 0.2;
        float wisps = smoothstep(0.6, 0.9, fbm(cirrus * vec2(0.00016, 0.00005), 5));
        color = mix(color, vec3(1.0, 0.98, 0.96), wisps * 0.32 * smoothstep(0.02, 0.25, d.y));
      }
      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});

const terrainMaterial = uniforms => new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */ `
    ${NOISE_GLSL}
    uniform vec2 uOffset;
    uniform float uAltitude;
    varying vec3 vRelative;
    varying vec2 vWorld;

    void main() {
      vec2 relative = position.xz;
      vWorld = relative + uOffset;
      float height = max(heightAt(vWorld, 6), 0.0);
      float curvature = dot(relative, relative) / 12800000.0;
      vRelative = vec3(relative.x, height - uAltitude - curvature, relative.y);
      gl_Position = projectionMatrix * viewMatrix * vec4(vRelative, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    ${NOISE_GLSL}
    ${SKY_GLSL}
    uniform vec2 uOffset;
    uniform float uAltitude;
    uniform float uCloudLayer;
    uniform float uTime;
    varying vec3 vRelative;
    varying vec2 vWorld;

    const vec3 SUNLIGHT = vec3(1.25, 1.14, 0.98);
    const vec3 SKYLIGHT = vec3(0.26, 0.33, 0.44);

    float cloudDensity(vec2 xz, int octaves) {
      return fbm(xz / 6200.0, octaves);
    }

    float haze(float distance) {
      float amount = 1.0 - exp(-pow(distance / 78000.0, 1.45));
      return max(amount, smoothstep(92000.0, 124000.0, distance));
    }

    vec3 landColor(float height, float slope, vec2 world) {
      float patches = vnoise(world / 2300.0);
      float fields = vnoise(ROTATE * world / 520.0);
      vec3 low = mix(vec3(0.085, 0.135, 0.05), vec3(0.2, 0.2, 0.095), smoothstep(0.35, 0.7, patches * 0.7 + fields * 0.3));
      vec3 forest = vec3(0.03, 0.07, 0.035) * (0.75 + 0.5 * fields);
      vec3 rock = vec3(0.17, 0.155, 0.14) * (0.8 + 0.4 * fields);
      vec3 color = mix(low, forest, smoothstep(350.0, 900.0, height + 300.0 * patches));
      color = mix(color, rock, smoothstep(0.1, 0.3, slope));
      color = mix(color, rock, smoothstep(1500.0, 2200.0, height));
      float snowline = 2350.0 + 500.0 * patches;
      return mix(color, vec3(0.86, 0.89, 0.94), smoothstep(snowline, snowline + 300.0, height) * (1.0 - smoothstep(0.3, 0.5, slope)));
    }

    void main() {
      float distance = length(vRelative);
      vec3 view = vRelative / distance;
      int octaves = distance < 26000.0 ? 7 : 5;

      float step = clamp(distance * 0.0035, 14.0, 500.0);
      float height = heightAt(vWorld, octaves);
      float heightX = heightAt(vWorld + vec2(step, 0.0), octaves);
      float heightZ = heightAt(vWorld + vec2(0.0, step), octaves);
      vec3 normal = normalize(vec3(height - heightX, step, height - heightZ));

      vec3 color;
      float shadowHeight = max(height, 0.0);
      vec2 shadowAt = vWorld + uSun.xz / uSun.y * (uCloudLayer - shadowHeight);
      float shade = 1.0 - 0.55 * smoothstep(0.58, 0.68, cloudDensity(shadowAt, 3));

      if (height <= 0.0) {
        vec2 waves = vec2(vnoise(vWorld / 70.0 + uTime * 0.1), vnoise(vWorld.yx / 55.0 - uTime * 0.08)) - 0.5;
        vec3 water = normalize(vec3(waves.x * 0.12, 1.0, waves.y * 0.12));
        float fresnel = pow(1.0 - max(dot(-view, water), 0.0), 4.0);
        color = mix(vec3(0.012, 0.055, 0.105), skyColor(reflect(view, water)), 0.1 + 0.8 * fresnel);
        color += SUNLIGHT * pow(max(dot(reflect(view, water), uSun), 0.0), 240.0) * 2.5;
        color *= shade;
      } else {
        vec3 albedo = landColor(height, 1.0 - normal.y, vWorld);
        float sun = max(dot(normal, uSun), 0.0) * shade;
        color = albedo * (SUNLIGHT * sun + SKYLIGHT * (0.6 + 0.4 * normal.y));
      }

      vec3 hazeColor = skyColor(normalize(vec3(view.x, max(view.y, 0.0) + 0.012, view.z)));
      color = mix(color, hazeColor, haze(distance));

      if (view.y < -0.002) {
        float travel = (uAltitude - uCloudLayer) / -view.y;
        if (travel < distance) {
          vec2 at = uOffset + view.xz * travel;
          int detail = travel < 30000.0 ? 6 : 4;
          float density = cloudDensity(at, detail);
          float cover = smoothstep(0.58, 0.68, density) * (1.0 - smoothstep(70000.0, 120000.0, travel));
          float lit = clamp(0.62 + (density - cloudDensity(at + uSun.xz * 520.0, detail)) * 6.5, 0.0, 1.0);
          vec3 cloud = mix(vec3(0.42, 0.49, 0.6), vec3(1.22, 1.19, 1.13), lit);
          color = mix(color, mix(cloud, hazeColor, haze(travel)), cover);
        }
      }

      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});

function noiseTexture() {
  const size = 256;
  const data = new Uint8Array(size * size);
  let seed = 1337;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = seed >>> 24;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// Rings that widen with distance, so detail falls off the way the eye needs it to.
function terrainGeometry() {
  const segments = 280;
  const radii = [0];
  while (radii.at(-1) < 130000) radii.push(Math.max(radii.at(-1) * 1.042, radii.at(-1) + 60));
  const positions = [];
  const indices = [];
  for (const radius of radii) {
    for (let s = 0; s < segments; s++) {
      const angle = (s / segments) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    }
  }
  for (let r = 0; r < radii.length - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * segments + s;
      const b = r * segments + (s + 1) % segments;
      const c = a + segments;
      const d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

// --------------------------------------------------------------------------------- aircraft

const steel = (color, roughness = 0.55, metalness = 0.3) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, side: THREE.DoubleSide });

// Profile is [[z, radius], ...] from nose to tail; nose points toward -Z.
function lathe(profile) {
  const points = profile.map(([z, radius]) => new THREE.Vector2(radius, -z)).reverse();
  return new THREE.LatheGeometry(points, 28).rotateX(-Math.PI / 2);
}

// Outline is [[x, z], ...]; the result lies flat, one side of the aircraft.
function plate(outline, thickness) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)));
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }).rotateX(Math.PI / 2);
}

function fin(outline, thickness) {
  const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }).rotateY(-Math.PI / 2);
}

function buildJet({ own = false } = {}) {
  const jet = new THREE.Group();
  const skin = steel(own ? "#7b858f" : "#67727c");
  const dark = steel("#22272c", 0.7, 0.2);
  const add = (geometry, material = skin) => {
    const mesh = new THREE.Mesh(geometry, material);
    jet.add(mesh);
    return mesh;
  };

  const profile = [[-7.6, 0.02], [-7, 0.18], [-6, 0.38], [-5.1, 0.55], [-4, 0.68], [-3, 0.78],
    [-1.5, 0.86], [1, 0.92], [4, 0.86], [6, 0.72], [7, 0.58]];
  // The pilot sits inside the fuselage, so our own one is open around the cockpit.
  const sections = own
    ? [profile.filter(([z]) => z <= -5.1), profile.filter(([z]) => z >= -3)]
    : [profile];
  for (const section of sections) add(lathe(section)).scale.set(1.2, 0.86, 1);

  for (const side of [1, -1]) {
    const mirrored = geometry => geometry.scale(side, 1, 1);
    add(mirrored(plate([[0.55, -4.4], [1.1, -2], [5.4, 2.8], [5.4, 3.7], [0.55, 4.7]], 0.1))).position.y = -0.14;
    add(mirrored(plate([[0.6, 4.6], [3, 6.6], [3, 7.35], [0.6, 7.05]], 0.07))).position.y = -0.08;
    const tail = add(fin([[3.5, 0], [6.3, 3.05], [7.2, 3.05], [7, 0]], 0.08));
    tail.position.set(side * 1.0, 0.5, 0);
    tail.rotation.z = -side * 0.26;
    add(new THREE.BoxGeometry(0.8, 0.7, 3.4)).position.set(side * 1.05, -0.28, -0.6);
    const nozzle = add(new THREE.CylinderGeometry(0.46, 0.38, 1.1, 20, 1, true).rotateX(Math.PI / 2), dark);
    nozzle.position.set(side * 0.5, 0, 7.3);
  }

  if (!own) {
    const glass = steel("#18242e", 0.12, 0.8);
    const canopy = add(new THREE.SphereGeometry(1, 18, 12), glass);
    canopy.scale.set(0.4, 0.4, 1.35);
    canopy.position.set(0, 0.62, -4.2);
  }
  return jet;
}

function puffTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(255, 255, 255, 0.95)");
  glow.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

// Missile smoke and blasts. They stay where they were made in the world while we fly past.
class Puffs {
  #pool = [];
  #next = 0;

  constructor(scene, count = 96) {
    const map = puffTexture();
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, toneMapped: false }));
      sprite.visible = false;
      scene.add(sprite);
      this.#pool.push({ sprite, at: new THREE.Vector3(), age: 0, life: 0, size: 0, growth: 0 });
    }
  }

  add(at, color, life, size, growth) {
    const puff = this.#pool[this.#next];
    this.#next = (this.#next + 1) % this.#pool.length;
    Object.assign(puff, { age: 0, life, size, growth });
    puff.at.copy(at);
    puff.sprite.material.color.set(color);
    puff.sprite.visible = true;
  }

  step(dt, own) {
    for (const puff of this.#pool) {
      if (!puff.sprite.visible) continue;
      puff.age += dt;
      if (puff.age >= puff.life) {
        puff.sprite.visible = false;
        continue;
      }
      const size = puff.size + puff.growth * puff.age;
      puff.sprite.position.copy(puff.at).sub(own);
      puff.sprite.scale.set(size, size, 1);
      puff.sprite.material.opacity = 1 - puff.age / puff.life;
    }
  }
}

function markerTexture(color) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, 104, 104);
  return new THREE.CanvasTexture(canvas);
}

// ------------------------------------------------------------------------------------ scene

function addLights(scene, ambient) {
  scene.add(new THREE.HemisphereLight("#bcd4f0", "#3a3f3a", ambient));
  const sun = new THREE.DirectionalLight("#fff1dc", 3.0);
  sun.position.copy(SUN);
  scene.add(sun);
  return sun;
}

class Flight {
  attitude = new THREE.Quaternion();
  speed = SPEED;
  altitude = ALTITUDE;
  throttle = 0.45;
  resets = null;
  gLimited = false;
  #roll = 0;
  #pitch = 0;
  #yaw = 0;
  #euler = new THREE.Euler(0, 0, 0, "YXZ");
  #delta = new THREE.Quaternion();
  #forward = new THREE.Vector3();

  #reset() {
    this.attitude.identity();
    this.speed = SPEED;
    this.altitude = ALTITUDE;
  }

  step(dt, stick, offset, systems) {
    if (stick) this.#fly(dt, stick, systems);
    else this.#autolevel(dt);

    this.#forward.set(0, 0, -1).applyQuaternion(this.attitude);
    offset.x += this.#forward.x * this.speed * dt;
    offset.y += this.#forward.z * this.speed * dt;
    this.altitude = THREE.MathUtils.clamp(this.altitude + this.#forward.y * this.speed * dt, MIN_ALTITUDE, MAX_ALTITUDE);
  }

  // What the autopilot wants from the stick, or nothing when it is off.
  #autopilot(systems) {
    if (!systems.autopilot) return null;
    const { pitch, roll, heading, feet } = this.readout();
    const clamp = THREE.MathUtils.clamp;
    const level = { roll: clamp(-roll / 40, -0.6, 0.6), pitch: clamp(-pitch / 20, -0.3, 0.3) };
    if (systems.autopilot === "HDG") {
      const error = ((systems.selectedHeading - heading + 540) % 360) - 180;
      return { ...level, roll: clamp((clamp(error * 1.5, -30, 30) - roll) / 40, -0.6, 0.6) };
    }
    if (systems.autopilot === "BALT") {
      const wanted = clamp((systems.selectedAltitude - feet) / 200, -8, 8);
      return { ...level, pitch: clamp((wanted - pitch) / 10, -0.4, 0.4) };
    }
    return { roll: 0, pitch: 0 };
  }

  #fly(dt, stick, systems) {
    if (this.resets !== null && stick.resets !== this.resets) this.#reset();
    this.resets = stick.resets;
    const ease = 1 - Math.exp(-dt / 0.08);  // the phone sends about 30 times a second
    const command = this.#autopilot(systems) ?? stick;
    this.#roll += (command.roll - this.#roll) * ease;
    this.#pitch += (command.pitch - this.#pitch) * ease;
    this.#yaw += (stick.yaw - this.#yaw) * ease;
    this.throttle = stick.throttle;

    const limit = systems.turnLimit(this.speed);
    const asked = this.#pitch * PITCH_RATE * systems.pullBonus;
    const pull = THREE.MathUtils.clamp(asked, -limit * PUSH_SHARE, limit);
    this.#euler.set(pull * dt, -this.#yaw * YAW_RATE * dt, -this.#roll * ROLL_RATE * dt, "YXZ");
    this.attitude.multiply(this.#delta.setFromEuler(this.#euler)).normalize();

    this.#euler.setFromQuaternion(this.attitude, "YXZ");
    const assist = GRAVITY * Math.sin(-this.#euler.z) * TURN_ASSIST / this.speed;
    const room = Math.max(0, limit - Math.abs(pull));
    const turn = THREE.MathUtils.clamp(assist, -room, room);
    this.attitude.premultiply(this.#delta.setFromAxisAngle(UP, -turn * dt)).normalize();
    this.gLimited = Math.abs(asked) + Math.abs(assist) > limit;

    const thrust = systems.flamedOut ? MIN_SPEED : MIN_SPEED + this.throttle * (MAX_SPEED - MIN_SPEED);
    const target = Math.min(thrust, systems.speedLimit);
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / (target < this.speed ? 2.5 : 4)));
    if (systems.realistic) {
      const g = (Math.abs(pull) + Math.abs(turn)) * this.speed / GRAVITY;
      this.speed = Math.max(MIN_SPEED, this.speed - G_BLEED * g * g * dt);
    }
  }

  // Without a stick the aircraft flies itself straight and level on its current heading.
  #autolevel(dt) {
    this.#euler.setFromQuaternion(this.attitude, "YXZ");
    this.attitude.slerp(this.#delta.setFromAxisAngle(UP, this.#euler.y), 1 - Math.exp(-dt * 0.7));
    this.speed += (SPEED - this.speed) * (1 - Math.exp(-dt / 4));
  }

  readout() {
    this.#euler.setFromQuaternion(this.attitude, "YXZ");
    return {
      pitch: this.#euler.x / DEG,
      roll: -this.#euler.z / DEG,
      heading: (360 - this.#euler.y / DEG) % 360,
      knots: this.speed * 1.944,
      feet: this.altitude * 3.281,
      throttle: this.throttle,
    };
  }
}

// Holds formation off the right side, so it moves with us rather than through the world.
function holdFormation(t, jet, attitude) {
  jet.position.set(150 + Math.sin(t * 0.21) * 12, -22 + Math.sin(t * 0.34) * 7, -95 + Math.sin(t * 0.13) * 14);
  jet.position.applyQuaternion(attitude);
  jet.quaternion.copy(attitude);
}

export function createCockpit(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: "high-performance" });
  renderer.autoClear = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;

  // Two passes with separate depth ranges: 120 km of terrain and a cockpit 40 cm away do not
  // fit in one depth buffer.
  const outside = new THREE.Scene();
  const inside = new THREE.Scene();
  const farCamera = new THREE.PerspectiveCamera(50, 1, 4, 180000);
  const nearCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 80);
  farCamera.rotation.order = nearCamera.rotation.order = "YXZ";

  const uniforms = {
    uNoise: { value: noiseTexture() },
    uSun: { value: SUN },
    uOffset: { value: new THREE.Vector2(38000, 21000) },
    uAltitude: { value: ALTITUDE },
    uCloudLayer: { value: CLOUD_LAYER },
    uTime: { value: 0 },
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial(uniforms));
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  outside.add(sky);
  const terrain = new THREE.Mesh(terrainGeometry(), terrainMaterial(uniforms));
  terrain.frustumCulled = false;
  outside.add(terrain);
  addLights(outside, 1.5);

  function markedJet(color) {
    const jet = buildJet();
    const box = new THREE.Sprite(new THREE.SpriteMaterial({
      map: markerTexture(color), transparent: true, depthTest: false, sizeAttenuation: false, toneMapped: false,
    }));
    box.scale.set(0.05, 0.05, 1);
    jet.add(box);
    outside.add(jet);
    return jet;
  }
  const bandit = markedJet("#ff8a5c");
  const wingman = markedJet(GREEN);
  const lockBox = new THREE.Sprite(new THREE.SpriteMaterial({
    map: markerTexture("#ff2d20"), transparent: true, depthTest: false, sizeAttenuation: false, toneMapped: false,
  }));
  lockBox.scale.set(0.075, 0.075, 1);
  bandit.add(lockBox);

  const puffs = new Puffs(outside);
  const avionics = new Avionics();
  const fight = new Fight(avionics);
  fight.effects = {
    smoke(at) {
      puffs.add(at, "#77736c", 2.4, 8, 9);
      puffs.add(at, "#fff1c4", 0.1, 9, 0);
    },
    blast(at) {
      const spot = new THREE.Vector3();
      puffs.add(at, "#fff6dc", 0.45, 70, 170);
      for (let i = 0; i < 16; i++) {
        spot.randomDirection().multiplyScalar(12 + Math.random() * 22).add(at);
        puffs.add(spot, i % 3 ? "#ff8a2e" : "#2f2a26", 1.4 + Math.random() * 1.6, 34, 40);
      }
    },
  };

  const actions = {
    flight: () => flight.readout(),
    acknowledge: () => avionics.acknowledgeCautions(flight.readout().knots),
    dispense() {
      if (!avionics.dispense()) return;
      fight.dispense();
      for (const side of [-1, 1]) {
        flareSpot.set(side * 6, -8, 30).applyQuaternion(flight.attitude).add(me.position);
        puffs.add(flareSpot, "#fff4d6", 1.5, 6, 5);
      }
    },
  };
  const panel = createPanel(avionics, actions);
  inside.add(panel.group);
  const classic = createClassicCockpit(avionics, actions);
  classic.group.visible = false;
  inside.add(classic.group);
  const ownJet = buildJet({ own: true });
  ownJet.position.set(0, -EYE_ABOVE_AXIS, -EYE_STATION);
  inside.add(ownJet);
  const cockpitSun = addLights(inside, 1.6);
  const fill = new THREE.DirectionalLight("#dbe6f2", 1.5);
  fill.position.set(0.1, 0.7, 1);   // sky light bouncing in through the canopy
  inside.add(fill);

  const neck = new THREE.Vector3(0, -0.14, 0.05);
  const headTurn = new THREE.Quaternion();
  const rock = new THREE.Quaternion();
  const bodyFrame = new THREE.Quaternion();
  const worldToBody = new THREE.Quaternion();
  const listener = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const flight = new Flight();
  const me = { position: new THREE.Vector3(), forward: new THREE.Vector3(), speed: SPEED };
  const view = new THREE.Vector3();
  const relative = new THREE.Vector3();
  const onScreen = new THREE.Vector3();
  const flareSpot = new THREE.Vector3();
  const lastForward = new THREE.Vector3(0, 0, -1);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let shots = null;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  let width = 0, height = 0;
  let resets = null;
  let g = 1, peakG = 1;
  let lastRange = null, closure = null;
  let pointerOn = false, pointerX = 0, pointerY = 0;
  let hovering = null;      // the control under the mouse
  let gazed = null;         // and the one under the middle of the view
  let turning = null;
  let uses = null, backs = null;

  function resize() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    const aspect = width / height;
    const verticalFov = 2 * Math.atan(Math.tan((HORIZONTAL_FOV / 2) * DEG) / aspect) / DEG;
    for (const camera of [farCamera, nearCamera]) {
      camera.aspect = aspect;
      camera.fov = verticalFov;
      camera.updateProjectionMatrix();
    }
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  // Switches take the mouse. The view can move under a resting pointer, so the pick runs each frame.
  function trackPointer(event) {
    const box = canvas.getBoundingClientRect();
    pointerX = event.clientX - box.left;
    pointerY = event.clientY - box.top;
    pointer.set(pointerX / box.width * 2 - 1, 1 - pointerY / box.height * 2);
    pointerOn = true;
  }

  // Whichever cockpit is showing.
  const cab = () => (classic.group.visible ? classic : panel);

  function pickUnderPointer() {
    raycaster.setFromCamera(pointer, nearCamera);
    hovering = cab().pick(raycaster);
  }

  canvas.addEventListener("pointermove", trackPointer);
  canvas.addEventListener("pointerleave", () => { pointerOn = false; });
  canvas.addEventListener("pointerdown", event => {
    if (!avionics.realistic) return;
    trackPointer(event);
    pickUnderPointer();
    if (!hovering) return;
    const step = event.button === 2 ? -1 : 1;
    if (hovering.turn) turning = { control: hovering, x: event.clientX, y: event.clientY, value: hovering.value(), step, moved: false };
    else cab().use(hovering, step);
  });

  // A knob held down turns with the mouse, up or right for more. Left in place, it was a click.
  addEventListener("pointermove", event => {
    if (!turning) return;
    const pixels = turning.y - event.clientY + event.clientX - turning.x;
    if (Math.abs(pixels) > TURN_START_PIXELS) turning.moved = true;
    if (turning.moved) turning.control.turn(turning.value, pixels);
  });
  for (const type of ["pointerup", "pointercancel"]) {
    addEventListener(type, () => {
      if (turning && !turning.moved) cab().use(turning.control, turning.step);
      turning = null;
    });
  }
  canvas.addEventListener("contextmenu", event => {
    if (avionics.realistic) event.preventDefault();
  });
  canvas.addEventListener("wheel", event => {
    if (!hovering) return;
    event.preventDefault();
    cab().use(hovering, event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // Degrees right of the nose.
  function relativeAzimuth() {
    relative.copy(bandit.position).applyQuaternion(worldToBody);
    return Math.atan2(relative.x, -relative.z) / DEG;
  }

  return {
    // Trades sharpness for frame rate; head tracking is unusable when the view stutters.
    lowerResolution() {
      if (pixelRatio <= 0.6) return false;
      pixelRatio = Math.max(0.6, pixelRatio * 0.82);
      resize();
      return true;
    },

    selectTarget(name) {
      fight.select(name);
    },

    fire() {
      fight.trigger();
    },

    setRealistic(on) {
      avionics.realistic = on;
    },

    setCockpit(name) {
      cab().mark(null);
      hovering = gazed = null;
      panel.group.visible = name === "hornot";
      classic.group.visible = name === "bucket";
      avionics.simple = name === "bucket";
    },

    // `head` is how far the real head is turned, degrees right and up. Returns what the sound and
    // the panel need.
    render(seconds, dt, viewYaw, viewPitch, stick, head) {
      flight.step(dt, stick, uniforms.uOffset.value, avionics);
      avionics.step(dt, flight.throttle, stick);
      if (stick) {
        if (shots !== null && stick.shots !== shots) fight.trigger();
        shots = stick.shots;
        if (resets !== null && stick.resets !== resets) {
          avionics.replenish();
          peakG = 1;
        }
        resets = stick.resets;
        if (gazed && uses !== null && stick.uses !== uses) cab().use(gazed, 1);
        if (gazed && backs !== null && stick.backs !== backs) cab().use(gazed, -1);
        uses = stick.uses;
        backs = stick.backs;
      }
      uniforms.uTime.value = seconds;
      uniforms.uAltitude.value = flight.altitude;
      holdFormation(seconds, wingman, flight.attitude);

      euler.set(viewPitch * DEG, -viewYaw * DEG, 0);
      headTurn.setFromEuler(euler);

      // The head pivots on the neck, which gives the cockpit a little parallax.
      nearCamera.quaternion.copy(headTurn);
      nearCamera.position.set(0, 0.14, -0.05).applyQuaternion(headTurn).add(neck);
      // Pilots twist to see behind them, which moves the eye out over the shoulder.
      const twist = THREE.MathUtils.smoothstep(Math.abs(viewYaw), 70, 150);
      nearCamera.position.x += Math.sign(viewYaw) * 0.15 * twist;

      // A little air movement on top of the flight path, so the world never looks painted.
      euler.set(Math.sin(seconds * 0.23) * 0.4 * DEG, 0, Math.sin(seconds * 0.17) * 1.0 * DEG);
      rock.setFromEuler(euler);
      bodyFrame.copy(flight.attitude).multiply(rock);
      farCamera.quaternion.copy(bodyFrame).multiply(headTurn);

      me.position.set(uniforms.uOffset.value.x, flight.altitude, uniforms.uOffset.value.y);
      me.forward.set(0, 0, -1).applyQuaternion(flight.attitude);
      me.speed = flight.speed;
      view.set(0, 0, -1).applyQuaternion(farCamera.quaternion);
      farCamera.updateMatrixWorld();
      onScreen.copy(bandit.position).project(farCamera);
      fight.step(dt, me, view, Math.abs(onScreen.x) < 1 && Math.abs(onScreen.y) < 1 && onScreen.z < 1);
      bandit.visible = fight.alive;
      lockBox.visible = fight.locked;
      bandit.position.copy(fight.bandit.position).sub(me.position);
      fight.bandit.orient(bandit);
      puffs.step(dt, me.position);

      // The cockpit is drawn in the aircraft's own frame, so the sun moves around it instead.
      worldToBody.copy(bodyFrame).invert();
      cockpitSun.position.copy(SUN).applyQuaternion(worldToBody);

      const readout = flight.readout();
      const turnRate = dt > 0 ? lastForward.angleTo(me.forward) / dt : 0;
      lastForward.copy(me.forward);
      const load = Math.hypot(1, flight.speed * turnRate / GRAVITY);
      g += (load - g) * (1 - Math.exp(-dt / 0.15));
      peakG = Math.max(peakG, g);

      if (fight.range === null || lastRange === null || dt === 0) closure = null;
      else closure = (closure ?? 0) + ((lastRange - fight.range) / dt - (closure ?? 0)) * (1 - Math.exp(-dt / 0.3));
      lastRange = fight.range;

      const warning = avionics.fuelWarning ?? (flight.gLimited ? "G LIM" : null);
      const azimuth = relativeAzimuth();
      const contact = fight.alive ? { azimuth, range: fight.range ?? 0, threat: fight.threat } : null;
      const seen = fight.alive && avionics.radarOn;
      const elevation = Math.atan2(relative.y, Math.hypot(relative.x, relative.z)) / DEG;
      if (classic.group.visible) {
        classic.update({ dt, seconds, flight: readout, fight, target: contact, stick, warning });
      } else {
        drawHud(panel.hud.ctx, panel.hud.canvas.width, {
          ...readout, mach: flight.speed / MACH_SPEED, g, peakG, status: fight.status,
        }, {
          brightness: avionics.powered ? (avionics.realistic ? avionics.hudBrightness : 0.85) : 0,
          reject: avionics.realistic ? avionics.hudReject : 0,
          mode: avionics.realistic ? { NAV: "NAV", AA: "A/A", AG: "A/G" }[avionics.masterMode] : "A/A",
          weapon: !avionics.realistic ? "SRM" : avionics.masterArm ? `SRM ${avionics.missiles}` : "SAFE",
          autopilot: avionics.autopilot,
          gearDown: avionics.realistic && avionics.gearDown,
          warning,
        }, seen ? { right: azimuth, up: elevation, range: fight.range ?? 0, closure, locked: fight.locked, locking: fight.locking } : null);
        panel.hud.texture.needsUpdate = true;
        panel.update(dt, {
          seconds, flight: readout, stickInput: stick,
          target: contact,
          avionics,
        });
      }

      renderer.clear();
      renderer.render(outside, farCamera);
      renderer.clearDepth();
      renderer.render(inside, nearCamera);

      // A knob held by the mouse stays held even if the head moves.
      if (!turning) {
        gazed = avionics.realistic ? cab().pickNearest(nearCamera) : null;
        if (avionics.realistic && pointerOn) pickUnderPointer();
        else hovering = null;
        cab().mark(hovering ?? gazed);
      }

      // The view turns the world on screen, then the real head turns away from the screen, so a
      // sound stays on the monitor when you glance aside. Both together are what the ears see.
      euler.set(head.pitch * DEG, -head.yaw * DEG, 0);
      listener.copy(farCamera.quaternion).multiply(headTurn.setFromEuler(euler));
      return {
        listener: {
          forward: new THREE.Vector3(0, 0, -1).applyQuaternion(listener).toArray(),
          up: new THREE.Vector3(0, 1, 0).applyQuaternion(listener).toArray(),
        },
        bandit: bandit.position.toArray(),
        banditAlive: fight.alive,
        dogfight: Boolean(fight.kind.attacks),
        wingman: wingman.position.toArray(),
        tail: new THREE.Vector3(0, 0, 11).applyQuaternion(bodyFrame).toArray(),
        banditAzimuth: relativeAzimuth(),
        banditFromView: view.angleTo(bandit.position) / DEG,
        range: fight.range,
        onSight: fight.onSight,
        status: fight.status,
        locked: fight.locked,
        locking: fight.locking,
        lock: fight.lock,
        threat: fight.threat,
        flash: fight.flash,
        kills: fight.kills,
        losses: fight.losses,
        calls: fight.takeCalls(),
        tooltip: hovering ? { text: hovering.tip(), x: pointerX, y: pointerY } : null,
        gaze: gazed ? gazed.tip() : null,
        voiceVolume: avionics.realistic ? avionics.commVolume[0] : 0.8,
        toneVolume: avionics.realistic ? avionics.commVolume[1] : 0.5,
        throttle: flight.throttle,
        airspeed: (flight.speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED),
      };
    },
  };
}
