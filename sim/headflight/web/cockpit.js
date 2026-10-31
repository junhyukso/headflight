// A procedural fighter cockpit flown with head tracking. No asset files: terrain, clouds, aircraft
// and instruments are all generated here.
import * as THREE from "three";
import { Fight } from "/fight.js";

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
const MIN_SPEED = 130;          // meters per second at idle and at full throttle
const MAX_SPEED = 420;
// The shaders draw terrain and clouds as seen from above, so stay over the peaks.
const MIN_ALTITUDE = 3900;
const MAX_ALTITUDE = 13000;
const RADAR_RANGE = 10000;      // meters
const RADAR_ARC = 58;           // degrees either side of the nose

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
    draw({ pitch, roll, heading, knots, feet, throttle, target }) {
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
      ctx.fillText("MSL 96", mid + 210, mid + 150);
      if (target.range !== null) ctx.fillText(`RNG ${(target.range / 1000).toFixed(1)}`, mid - 302, mid + 182);
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

function drawStores(ctx, size) {
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
  ctx.fillText("MSL 96", size * 0.06, size * 0.95);
}

// ---------------------------------------------------------------------------------- cockpit

function buildCockpit(radar, hud, attitude) {
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
  const stores = canvasPanel(256, 256);
  drawStores(stores.ctx, 256);
  stores.texture.needsUpdate = true;
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

  // Stick and throttle.
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.16, 12), dark);
  grip.position.set(0.32, -0.34, -0.08);
  cockpit.add(grip);
  box(0.05, 0.06, 0.1, -0.32, -0.385, -0.1, dark);

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

  step(dt, stick, offset) {
    if (stick) this.#fly(dt, stick);
    else this.#autolevel(dt);

    this.#forward.set(0, 0, -1).applyQuaternion(this.attitude);
    offset.x += this.#forward.x * this.speed * dt;
    offset.y += this.#forward.z * this.speed * dt;
    this.altitude = THREE.MathUtils.clamp(this.altitude + this.#forward.y * this.speed * dt, MIN_ALTITUDE, MAX_ALTITUDE);
  }

  #fly(dt, stick) {
    if (this.resets !== null && stick.resets !== this.resets) this.#reset();
    this.resets = stick.resets;
    const ease = 1 - Math.exp(-dt / 0.08);  // the phone sends about 30 times a second
    this.#roll += (stick.roll - this.#roll) * ease;
    this.#pitch += (stick.pitch - this.#pitch) * ease;
    this.#yaw += (stick.yaw - this.#yaw) * ease;
    this.throttle = stick.throttle;

    this.#euler.set(this.#pitch * PITCH_RATE * dt, -this.#yaw * YAW_RATE * dt, -this.#roll * ROLL_RATE * dt, "YXZ");
    this.attitude.multiply(this.#delta.setFromEuler(this.#euler)).normalize();

    this.#euler.setFromQuaternion(this.attitude, "YXZ");
    const turn = 9.8 * Math.sin(-this.#euler.z) * TURN_ASSIST / this.speed;
    this.attitude.premultiply(this.#delta.setFromAxisAngle(UP, -turn * dt)).normalize();

    const target = MIN_SPEED + this.throttle * (MAX_SPEED - MIN_SPEED);
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / 4));
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
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
  const fight = new Fight();
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

  const radar = canvasPanel(256, 256);
  const attitudeScreen = canvasPanel(256, 256);
  const hud = createHud();
  inside.add(buildCockpit(radar, hud, attitudeScreen));
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
  let shots = null;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  let width = 0, height = 0;
  let screensDue = 0;
  let hudDue = 0;

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

    // `head` is how far the real head is turned, degrees right and up. Returns what the sound and
    // the panel need.
    render(seconds, dt, viewYaw, viewPitch, stick, head) {
      flight.step(dt, stick, uniforms.uOffset.value);
      if (stick) {
        if (shots !== null && stick.shots !== shots) fight.trigger();
        shots = stick.shots;
      }
      uniforms.uTime.value = seconds;
      uniforms.uAltitude.value = flight.altitude;
      holdFormation(seconds, wingman, flight.attitude);

      const readout = flight.readout();
      if (seconds >= hudDue) {
        hudDue = seconds + 1 / 30;
        hud.draw({ ...readout, target: fight });
      }
      if (seconds >= screensDue) {
        screensDue = seconds + 1 / 15;
        drawRadar(radar.ctx, radar.canvas.width, seconds * 1.4, fight.alive ? { azimuth: relativeAzimuth(), range: fight.range ?? Infinity } : null);
        radar.texture.needsUpdate = true;
        drawAttitude(attitudeScreen.ctx, attitudeScreen.canvas.width, readout.pitch, readout.roll);
        attitudeScreen.texture.needsUpdate = true;
      }

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

      renderer.clear();
      renderer.render(outside, farCamera);
      renderer.clearDepth();
      renderer.render(inside, nearCamera);

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
        throttle: flight.throttle,
        airspeed: (flight.speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED),
      };
    },
  };
}
