// The bandit and the fight around it. The bandit flies in the same world as we do, so distance is
// real: you close on it by flying at it, and getting behind it takes actual maneuvering.
import * as THREE from "three";

const DEG = Math.PI / 180;
const GRAVITY = 9.8;
const UP = new THREE.Vector3(0, 1, 0);

// Where a bandit may go. The world is only drawn from above 3,900 m.
const FLOOR = 4600;
const CEILING = 11500;
const FLOOR_LOOKAHEAD_S = 7;    // bandits start pulling out this far ahead of the limits
const LEASH = 7000;             // past this range a bandit comes back to find you
const RUN_IN_S = 6;             // a new bandit holds its course this long, which gives you time to react

const PASS_ABOVE = 120;         // meters; a bandit aims this far over you, so a head-on pass misses
const BREAK_RANGE = 2500;       // someone this close...
const BREAK_ARC = 60 * DEG;     // ...and this near a bandit's tail makes it break
const BREAK_SPEED = 1.1;        // share of its normal speed while breaking
const BANDIT_TURN_SHARE = 0.8;  // of the G limit; it never makes a mistake, so it can't pull as hard as you
const JINK_GAP_S = [1.5, 3];

// The lock: hold the bandit in the middle of your view, from behind it and close enough. Once locked
// it stays locked until the bandit leaves the screen or gets too far away.
const LOCK_CONE = 7 * DEG;
const LOCK_TIME_S = 1.2;
const LOCK_FADE_S = 0.6;
const LOCK_RANGE = [150, 1500];
const HOLD_RANGE = 2000;        // a lock drops past this, a little beyond where one can start
const LOCK_OFF_NOSE = 65 * DEG; // how far from the nose a lock can start
const TAIL_ASPECT = Math.cos(100 * DEG);   // how far ahead of its tail you can be, about the wing line
const MISSILE_SPEED = 1200;
const MISSILE_DROP = 6;         // meters below us, so its trail doesn't start inside the cockpit
const RESPAWN_S = 3.5;
const FLASH_S = 1.2;

// The dogfighter's shot: its nose has to stay on you this long.
const ENEMY_CONE = 6 * DEG;
const ENEMY_RANGE = 2000;
const ENEMY_LOCK_TIME_S = 4;
const ENEMY_LOCK_FADE_S = 1.5;
const SIX_CALL_GAP_S = 8;

export const TARGETS = {
  easy: { label: "Easy", speed: 210, turn: 11 * DEG, roll: 70 * DEG, leg: [10, 16], swing: [30, 80], climb: 200 },
  fast: { label: "Fast", speed: 340, limitedSpeed: 300, turn: 26 * DEG, roll: 200 * DEG, leg: [5, 9], swing: [60, 150], climb: 700, breaks: true },
  dogfight: { label: "Dogfight", speed: 300, turn: 19 * DEG, roll: 180 * DEG, breaks: true, attacks: true },
};

const between = (low, high) => low + Math.random() * (high - low);

const toMe = new THREE.Vector3();
const wanted = new THREE.Vector3();
const across = new THREE.Vector3();
const level = new THREE.Vector3();
const lift = new THREE.Vector3();
const spin = new THREE.Vector3();
const right = new THREE.Vector3();
const back = new THREE.Vector3();
const basis = new THREE.Matrix4();

class Bandit {
  position = new THREE.Vector3();
  forward = new THREE.Vector3(0, 0, -1);
  up = new THREE.Vector3(0, 1, 0);
  speed = 200;
  #waypoint = new THREE.Vector3();
  #legLeft = 0;
  #jink = new THREE.Vector3();
  #jinkLeft = 0;

  place(position, forward, speed) {
    this.position.copy(position);
    this.forward.copy(forward).normalize();
    this.up.copy(UP).addScaledVector(this.forward, -this.forward.y).normalize();
    this.speed = speed;
    this.#legLeft = RUN_IN_S;
    this.#waypoint.copy(position).addScaledVector(this.forward, speed * RUN_IN_S);
    this.#jinkLeft = 0;
  }

  // Rolls the lift toward the turn it wants, then pulls, which is all an aircraft can do.
  #fly(dt, kind, speed, systems) {
    const { forward, up } = this;
    across.copy(wanted).addScaledVector(forward, -forward.dot(wanted));
    const rate = Math.min(kind.turn, systems.turnLimit(this.speed) * BANDIT_TURN_SHARE, Math.atan2(across.length(), forward.dot(wanted)) * 2);
    level.copy(UP).addScaledVector(forward, -forward.y);
    lift.copy(across.normalize()).multiplyScalar(this.speed * rate).addScaledVector(level, GRAVITY);
    const force = lift.length();
    lift.normalize();

    const angle = Math.atan2(spin.crossVectors(up, lift).dot(forward), up.dot(lift));
    up.applyAxisAngle(forward, THREE.MathUtils.clamp(angle, -kind.roll * dt, kind.roll * dt));
    const pull = force * Math.max(0, up.dot(lift));
    forward.addScaledVector(up, pull * dt / this.speed).addScaledVector(level, -GRAVITY * dt / this.speed).normalize();
    up.addScaledVector(forward, -up.dot(forward)).normalize();

    this.speed += (speed - this.speed) * (1 - Math.exp(-dt / 2));
    this.position.addScaledVector(forward, this.speed * dt);
  }

  #followRoute(dt, me, kind) {
    const { position, forward } = this;
    this.#legLeft -= dt;
    if (this.#legLeft <= 0 || position.distanceTo(this.#waypoint) < 400) {
      const seconds = between(...kind.leg);
      this.#legLeft = seconds * 1.3;
      if (position.distanceTo(me.position) > LEASH) {
        this.#waypoint.copy(me.position);
      } else {
        // Fast ones usually turn away from you, so they have to be run down.
        toMe.copy(me.position).sub(position);
        const away = -Math.sign(forward.x * -toMe.z + forward.z * toMe.x) || 1;
        const side = kind.breaks && Math.random() < 0.75 ? away : Math.random() < 0.5 ? -1 : 1;
        const heading = Math.atan2(forward.x, -forward.z) + side * between(...kind.swing) * DEG;
        const distance = kind.speed * seconds;
        this.#waypoint.set(position.x + Math.sin(heading) * distance, me.position.y + between(-kind.climb, kind.climb),
          position.z - Math.cos(heading) * distance);
      }
    }
    wanted.copy(this.#waypoint).sub(position).normalize();
  }

  #evade(dt) {
    this.#jinkLeft -= dt;
    if (this.#jinkLeft <= 0) {
      this.#jinkLeft = between(...JINK_GAP_S);
      const angle = between(-0.6, 0.6) + (Math.random() < 0.5 ? 0 : Math.PI);   // mostly sideways
      this.#jink.crossVectors(this.forward, UP).normalize().multiplyScalar(Math.cos(angle)).addScaledVector(UP, Math.sin(angle));
    }
    wanted.copy(this.forward).multiplyScalar(0.25).add(this.#jink).normalize();
  }

  step(dt, me, kind, systems) {
    const { position, forward } = this;
    toMe.copy(me.position).sub(position);
    const range = toMe.length();
    // Hard turns cost you speed under the G limit, so a target has to be slower to stay catchable.
    let speed = (systems.realistic && kind.limitedSpeed) || kind.speed;
    if (kind.breaks && range < BREAK_RANGE && -forward.dot(toMe) / range > Math.cos(BREAK_ARC)) {
      this.#evade(dt);
      speed *= BREAK_SPEED;
    } else if (kind.attacks) {
      wanted.copy(toMe).addScaledVector(me.forward, me.speed * Math.min(range / 800, 1.5));
      wanted.y += PASS_ABOVE;
      wanted.normalize();
      speed = THREE.MathUtils.clamp(me.speed + (range - 800) / 10, 240, 380);
    } else {
      this.#followRoute(dt, me, kind);
    }
    const altitude = position.y + forward.y * this.speed * FLOOR_LOOKAHEAD_S;
    if (altitude < FLOOR) wanted.y += (FLOOR - altitude) / 300;
    if (altitude > CEILING) wanted.y -= (altitude - CEILING) / 300;
    wanted.normalize();
    this.#fly(dt, kind, speed, systems);
  }

  orient(jet) {
    back.copy(this.forward).negate();
    right.crossVectors(this.up, back);
    jet.quaternion.setFromRotationMatrix(basis.makeBasis(right, this.up, back));
  }
}

export class Fight {
  kind = TARGETS.easy;
  bandit = new Bandit();
  alive = false;
  range = null;
  onSight = false;      // near enough the middle of the view to start a lock
  blocked = null;       // why what is on sight won't lock
  locking = false;
  locked = false;
  lock = 0;             // how far along the lock is, 0 to 1
  threat = 0;           // and the bandit's lock on us
  flash = 0;            // fades after we get hit
  kills = 0;
  losses = 0;
  effects = { smoke() {}, blast() {} };
  systems;
  #calls = [];
  #wait = 0;
  #missile = null;
  #smokeDue = 0;
  #sixCallDue = 0;
  #triggered = false;

  // `systems` says what the aircraft's switches allow.
  constructor(systems = { seekerOn: true, armed: true, canFire: true, launched() {}, turnLimit: () => Infinity }) {
    this.systems = systems;
  }

  select(name) {
    this.kind = TARGETS[name];
    this.#clear(0);
  }

  takeCalls() {
    return this.#calls.splice(0);
  }

  // Flares break the bandit's lock.
  dispense() {
    this.threat = 0;
  }

  // Fires on the next step, if there is a lock to fire on.
  trigger() {
    this.#triggered = true;
  }

  #clear(wait) {
    this.alive = false;
    this.range = null;
    this.onSight = this.locking = this.locked = this.#triggered = false;
    this.blocked = null;
    this.lock = this.threat = 0;
    this.#missile = null;
    this.#wait = wait;
  }

  // Easy and Fast start ahead with their tails to you, ready to chase. A dogfight starts head-on.
  #spawn(me) {
    const { attacks } = this.kind;
    const bearing = Math.atan2(me.forward.x, -me.forward.z) + between(-25, 25) * DEG;
    const distance = attacks ? 5000 : 3000;
    const altitude = THREE.MathUtils.clamp(me.position.y + between(-150, 150), FLOOR, CEILING);
    const at = new THREE.Vector3(me.position.x + Math.sin(bearing) * distance, altitude, me.position.z - Math.cos(bearing) * distance);
    const heading = attacks ? me.position.clone().sub(at) : new THREE.Vector3(Math.sin(bearing), 0, -Math.cos(bearing));
    this.bandit.place(at, heading, this.kind.speed);
    this.alive = true;
    this.#sixCallDue = 0;
    this.#calls.push(attacks ? "fight_on" : "contact");
  }

  #flyMissile(dt) {
    const missile = this.#missile;
    const gap = this.bandit.position.clone().sub(missile);
    const reach = MISSILE_SPEED * dt;
    if (gap.length() < reach + 20) {
      this.kills++;
      this.effects.blast(this.bandit.position);
      this.#calls.push("splash");
      this.#clear(RESPAWN_S);
      return;
    }
    missile.addScaledVector(gap.normalize(), reach);
    this.#smokeDue -= dt;
    if (this.#smokeDue <= 0) {
      this.effects.smoke(missile);
      this.#smokeDue = 0.04;
    }
  }

  // The word for the HUD and the view.
  get status() {
    if (this.threat > 0) return "BREAK";
    if (this.locked) return this.systems.canFire ? "SHOOT" : this.systems.armed ? "NO MSL" : "SAFE";
    return this.locking ? "LOCK" : this.blocked;
  }

  #lockFault(direction, me) {
    if (!this.systems.seekerOn) return "SELECT A/A";
    if (me.forward.angleTo(direction) > LOCK_OFF_NOSE) return "TURN TOWARD";
    if (this.bandit.forward.dot(direction) < TAIL_ASPECT) return "GET BEHIND";
    if (this.range > LOCK_RANGE[1]) return "TOO FAR";
    if (this.range < LOCK_RANGE[0]) return "TOO CLOSE";
    return null;
  }

  // `me` is our position, forward vector and speed. `view` is where the head is looking, and
  // `onScreen` says whether the bandit is inside it.
  step(dt, me, view, onScreen) {
    this.flash = Math.max(0, this.flash - dt / FLASH_S);
    if (!this.alive) {
      this.#wait -= dt;
      if (this.#wait <= 0) this.#spawn(me);
      return;
    }
    this.bandit.step(dt, me, this.kind, this.systems);

    const direction = new THREE.Vector3().copy(this.bandit.position).sub(me.position);
    this.range = direction.length();
    direction.divideScalar(this.range);

    this.onSight = view.angleTo(direction) < LOCK_CONE;
    const fault = this.#lockFault(direction, me);
    this.blocked = this.onSight ? fault : null;
    if (this.locked && (!onScreen || this.range > HOLD_RANGE || !this.systems.seekerOn)) {
      this.locked = false;
      this.lock = 0;
    }
    if (!this.locked) {
      this.locking = this.onSight && !fault && !this.#missile;
      this.lock = THREE.MathUtils.clamp(this.lock + dt * (this.locking ? 1 / LOCK_TIME_S : -1 / LOCK_FADE_S), 0, 1);
      this.locked = this.locking && this.lock >= 1;
    }
    if (this.#triggered && this.locked && this.systems.canFire) {
      this.systems.launched();
      this.#missile = me.position.clone();
      this.#missile.y -= MISSILE_DROP;
      this.#calls.push("fox_two");
      this.locked = this.locking = false;
      this.lock = 0;
    }
    this.#triggered = false;

    if (this.kind.attacks) {
      const onUs = this.range < ENEMY_RANGE && this.bandit.forward.angleTo(direction.negate()) < ENEMY_CONE;
      this.threat = THREE.MathUtils.clamp(this.threat + dt * (onUs ? 1 / ENEMY_LOCK_TIME_S : -1 / ENEMY_LOCK_FADE_S), 0, 1);
      this.#sixCallDue -= dt;
      if (onUs && this.#sixCallDue <= 0) {
        this.#calls.push("on_your_six");
        this.#sixCallDue = SIX_CALL_GAP_S;
      }
      if (this.threat >= 1) {
        this.losses++;
        this.flash = 1;
        this.#calls.push("hit");
        this.#clear(RESPAWN_S);
        return;
      }
    }
    if (this.#missile) this.#flyMissile(dt);
  }
}
