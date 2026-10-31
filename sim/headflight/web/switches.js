// Controls the mouse can reach, shared by both cockpits: push buttons, levers, knobs and lights.
import * as THREE from "three";

export const FACE_Z = -0.7;     // the front panel, meters ahead of the eye
const GREEN = "#7dffae";
const WHITE = "#e9edf0";
const AMBER = "#ffb347";
const TURN_PIXELS = 160;        // mouse travel across a knob's whole range
const GAZE_REACH = 2.5 * Math.PI / 180;     // a head can't aim at a button as finely as a mouse
const THROTTLE_SWING = 0.9;     // radians of lever travel from idle to full

export function metal(color, roughness = 0.65, metalness = 0.2) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

export function canvasOf(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { canvas, ctx: canvas.getContext("2d"), texture };
}

export function textTile(lines, color, width = 128, height = 56) {
  const { ctx, texture } = canvasOf(width, height);
  ctx.fillStyle = "#050607";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = color;
  ctx.font = `700 ${lines.length > 1 ? 19 : 23}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => ctx.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * 22));
  return texture;
}

// The center stick and the throttle quadrant inboard of the left console. Both follow the phone.
export function addFlightControls(group) {
  const black = metal("#0c0e10", 0.7, 0.1);
  const dark = metal("#16191c", 0.85, 0.1);
  const trim = metal("#5a636b", 0.5, 0.45);

  const stick = new THREE.Group();
  stick.position.set(0, -0.72, -0.3);
  group.add(stick);
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, 0.12, 14), black);
  boot.position.y = 0.05;
  stick.add(boot);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.22, 10), trim);
  shaft.position.y = 0.2;
  stick.add(shaft);
  const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.07, 6, 12), black);
  grip.position.set(0, 0.34, 0.006);
  grip.rotation.x = 0.16;
  stick.add(grip);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.018, 0.008), metal("#a52a22", 0.5, 0.2));
  trigger.position.set(0, 0.385, -0.018);
  stick.add(trigger);

  // The quadrant's top, painted with its slot and throttle stops.
  const { canvas, ctx, texture } = canvasOf(192, 864);
  ctx.fillStyle = "#1a1d20";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#050607";
  ctx.fillRect(58, 120, 76, 624);
  ctx.font = "600 28px Helvetica, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [word, y, color] of [["AB", 156, AMBER], ["MIL", 336, WHITE], ["IDLE", 708, WHITE]]) {
    ctx.fillStyle = color;
    ctx.fillText(word, 164, y);
  }
  texture.needsUpdate = true;

  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.36), dark);
  pedestal.position.set(-0.205, -0.615, -0.27);
  group.add(pedestal);
  const top = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.36), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 }));
  top.rotation.x = -Math.PI / 2;
  top.position.set(-0.205, -0.489, -0.27);
  group.add(top);

  const lever = new THREE.Group();
  lever.position.set(-0.205, -0.6, -0.27);
  group.add(lever);
  const gripPaint = metal("#4a5157", 0.55, 0.25);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.15, 0.014), trim);
    arm.position.set(side * 0.008, 0.075, 0);
    lever.add(arm);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.034, 0.052), gripPaint);
    handle.position.set(side * 0.013, 0.165, -0.002);
    lever.add(handle);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.022, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), gripPaint);
    cap.position.set(side * 0.013, 0.182, -0.002);
    lever.add(cap);
  }
  const thumbSwitch = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 0.01), metal("#c03328", 0.5, 0.2));
  thumbSwitch.position.set(0.024, 0.19, -0.014);
  lever.add(thumbSwitch);
  const fingerLift = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.006, 0.016), metal("#c9ced2", 0.4, 0.6));
  fingerLift.position.set(-0.024, 0.186, 0.01);
  lever.add(fingerLift);

  return {
    update(input, throttle) {
      stick.rotation.z = -(input?.roll ?? 0) * 0.2;
      stick.rotation.x = (input?.pitch ?? 0) * 0.16;
      lever.rotation.x = (0.5 - throttle) * THROTTLE_SWING;
    },
  };
}

export function createSwitches(group) {
  const eye = new THREE.Vector3();
  const gaze = new THREE.Vector3();
  const spot = new THREE.Vector3();
  const black = metal("#0c0e10", 0.7, 0.1);
  const trim = metal("#5a636b", 0.5, 0.45);
  const controls = [];      // everything the mouse can reach
  const targets = [];
  const indicators = [];    // lights, each with a test for whether it is lit
  const moving = [];        // parts animated from the state of a switch

  function register(mesh, control) {
    mesh.userData.control = control;
    control.hit = mesh;
    targets.push(mesh);
    controls.push(control);
    return control;
  }

  // A push button. `act` runs on each press.
  function button(x, y, w, h, name, act, { parent = group, z = FACE_Z, text = null, color = "#23272b", tip = null } = {}) {
    const faces = text
      ? new THREE.MeshBasicMaterial({ map: textTile([text], WHITE, 96, 72) })
      : metal(color, 0.6);
    const materials = [black, black, black, black, faces, black];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.012), materials);
    mesh.position.set(x, y, z + 0.008);
    parent.add(mesh);
    const control = { name, tip: tip ?? (() => name), act, mesh, restZ: z + 0.008, pressed: 0 };
    return register(mesh, control);
  }

  // A switch with a lever. `positions` names its stops from the bottom up, or from the top down if
  // `inverted`. The clickable area stays put while the lever moves.
  function toggle(x, y, name, positions, get, set, { parent = group, z = FACE_Z, axis = "x", inverted = false } = {}) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.01, 0.006, 12).rotateX(Math.PI / 2), trim);
    base.position.set(x, y, z + 0.003);
    parent.add(base);
    const lever = new THREE.Group();
    lever.position.set(x, y, z + 0.005);
    parent.add(lever);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0045, 0.03, 8).rotateX(Math.PI / 2), metal("#d7dbde", 0.35, 0.7));
    stem.position.z = 0.015;
    lever.add(stem);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.04), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(x, y, z + 0.025);
    parent.add(hit);
    const count = positions.length;
    moving.push(() => {
      const angle = (inverted ? -1 : 1) * (get() / (count - 1) - 0.5) * 0.9;
      lever.rotation[axis] = axis === "x" ? -angle : angle;
    });
    return register(hit, {
      name,
      tip: () => `${name}: ${positions[get()]}`,
      act: step => set((get() + step + count) % count),
      mesh: null,
    });
  }

  // A knob. Clicks and the wheel move it a step, and dragging turns it; `format` gives its reading.
  function knob(x, y, radius, name, get, set, format, { parent = group, z = FACE_Z, step = 0.1, low = 0, high = 1 } = {}) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.85, radius, 0.016, 18).rotateX(Math.PI / 2), metal("#1b1e21", 0.5, 0.3));
    cap.position.set(x, y, z + 0.009);
    parent.add(cap);
    const pointer = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.18, radius * 0.9, 0.002), new THREE.MeshBasicMaterial({ color: WHITE }));
    pointer.position.set(0, radius * 0.45, 0.0085);
    cap.add(pointer);
    moving.push(() => { cap.rotation.z = -(((get() - low) / (high - low)) - 0.5) * 4.4; });
    return register(cap, {
      name,
      tip: () => `${name}: ${format(get())}`,
      act: delta => set(Math.round(Math.max(low, Math.min(high, get() + delta * step)) * 100) / 100),
      value: get,
      turn(start, pixels) {
        const wanted = Math.max(low, Math.min(high, start + pixels / TURN_PIXELS * (high - low)));
        set(step >= 1 ? Math.round(wanted) : Math.round(wanted * 100) / 100);
      },
      mesh: null,
    });
  }

  function light(x, y, w, h, words, color, isOn, { parent = group, z = FACE_Z } = {}) {
    const material = new THREE.MeshBasicMaterial({ map: textTile(words, color), toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.position.set(x, y, z + 0.003);
    parent.add(mesh);
    indicators.push({ material, isOn });
  }

  // A ring that shows what the mouse is on.
  const highlight = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0016, 6, 28),
    new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false, depthTest: false, transparent: true }));
  highlight.visible = false;
  highlight.renderOrder = 3;
  group.add(highlight);

  return {
    button, toggle, knob, light, register, moving,

    update(dt) {
      for (const update of moving) update();
      for (const { material, isOn } of indicators) material.color.setScalar(isOn() ? 1 : 0.1);
      for (const control of controls) {
        if (!control.mesh || !control.pressed) continue;
        control.pressed = Math.max(0, control.pressed - dt);
        control.mesh.position.z = control.restZ - (control.pressed > 0 ? 0.005 : 0);
      }
    },

    pick(raycaster) {
      const [hit] = raycaster.intersectObjects(targets, false);
      return hit?.object.userData.control ?? null;
    },

    // The control nearest the middle of the view, if one is close enough.
    pickNearest(camera) {
      camera.getWorldPosition(eye);
      camera.getWorldDirection(gaze);
      let nearest = null, reach = GAZE_REACH;
      for (const mesh of targets) {
        const angle = gaze.angleTo(spot.setFromMatrixPosition(mesh.matrixWorld).sub(eye));
        if (angle < reach) {
          reach = angle;
          nearest = mesh.userData.control;
        }
      }
      return nearest;
    },

    // Rings the control in use, whether the mouse or the head found it.
    mark(control) {
      highlight.visible = control !== null;
      if (!control) return;
      control.hit.getWorldPosition(highlight.position);
      group.worldToLocal(highlight.position);
    },

    use(control, step) {
      control.act(step);
      if (control.mesh) control.pressed = 0.12;
    },
  };
}
