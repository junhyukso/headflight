// Cockpit audio. Everything is synthesized except the radio voices. Sources sit in the same world
// space as the scene, so HRTF puts each one where its aircraft actually is.

const RADIO_CALLS = ["radar", "fuel", "sector", "formation", "check_six", "clear"];
const TALLY_CALLS = ["tally", "tally_again"];
const CLOCK_CALLS = { 12: "bandit_12", 3: "bandit_3", 6: "bandit_6", 9: "bandit_9" };
const FIGHT_CALLS = ["contact", "fight_on", "on_your_six", "fox_two", "splash", "hit"];
const RADIO_FILES = [...RADIO_CALLS, ...TALLY_CALLS, ...Object.values(CLOCK_CALLS), ...FIGHT_CALLS];

const CALL_GAP_S = [11, 22];    // silence between radio calls
const CLOCK_CALL_ODDS = 0.55;   // share of calls that report where the bandit really is
const WARNING_GAP_S = 2.4;
const URGENT_WARNING_GAP_S = 0.6;   // while the bandit is locking us
const TALLY_AFTER_S = 1.5;      // how long the bandit must stay in view to earn a call
const TALLY_GAP_S = 40;
const TALLY_CONE_DEG = 14;
const SEEKER_IDLE_HZ = 620;      // under the view but not lockable, so it doesn't rise
const SEEKER_LOCK_HZ = [1050, 1650];

function noiseBuffer(ctx, seconds, brown) {
  const buffer = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
  for (const channel of [0, 1]) {
    const data = buffer.getChannelData(channel);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else {
        data[i] = white;
      }
    }
  }
  return buffer;
}

function loop(ctx, buffer) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start();
  return source;
}

function filter(ctx, type, frequency, q = 0.8) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

function gain(ctx, value) {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

function chain(...nodes) {
  nodes.reduce((from, to) => { from.connect(to); return to; });
  return nodes.at(-1);
}

function spatial(ctx, output, referenceDistance) {
  const panner = ctx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = referenceDistance;
  panner.rolloffFactor = 1;
  panner.maxDistance = 30000;
  panner.connect(output);
  return panner;
}

function place(panner, [x, y, z]) {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}

function aim(listener, [fx, fy, fz], [ux, uy, uz]) {
  if (listener.forwardX) {
    listener.forwardX.value = fx;
    listener.forwardY.value = fy;
    listener.forwardZ.value = fz;
    listener.upX.value = ux;
    listener.upY.value = uy;
    listener.upZ.value = uz;
  } else {
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

// A broad band of noise and a turbine tone, which is what makes a jet easy to place by ear.
function jetVoice(ctx, noise, panner, level) {
  chain(loop(ctx, noise), filter(ctx, "bandpass", 900, 0.5), gain(ctx, level), panner);
  for (const [frequency, share] of [[1420, 0.1], [2130, 0.06]]) {
    const tone = ctx.createOscillator();
    tone.type = "sawtooth";
    tone.frequency.value = frequency;
    tone.start();
    chain(tone, filter(ctx, "bandpass", frequency, 4), gain(ctx, level * share), panner);
  }
}

function radioDistortion(ctx) {
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / 511.5 - 1) * 3.2) * 0.8;
  shaper.curve = curve;
  return shaper;
}

export async function createSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.resume();

  const white = noiseBuffer(ctx, 4, false);
  const brown = noiseBuffer(ctx, 6, true);

  const limiter = ctx.createDynamicsCompressor();
  const master = gain(ctx, 0.8);
  chain(master, limiter, ctx.destination);

  // Everything but the radio, so it can duck while someone is talking.
  const aircraftBus = gain(ctx, 1);
  aircraftBus.connect(master);

  // Our own aircraft: rumble in the seat, wind on the canopy, and the engines behind us.
  const rumbleFilter = filter(ctx, "lowpass", 220, 0.7);
  const rumbleLevel = gain(ctx, 0.3);
  chain(loop(ctx, brown), rumbleFilter, rumbleLevel, aircraftBus);

  const windFilter = filter(ctx, "bandpass", 1200, 0.6);
  const windLevel = gain(ctx, 0.08);
  chain(loop(ctx, white), windFilter, windLevel, aircraftBus);

  const engines = spatial(ctx, aircraftBus, 6);
  const exhaustFilter = filter(ctx, "lowpass", 1200, 0.5);
  const exhaustLevel = gain(ctx, 0.12);
  chain(loop(ctx, white), exhaustFilter, exhaustLevel, engines);
  const whine = ctx.createOscillator();
  whine.type = "sawtooth";
  whine.start();
  const whineFilter = filter(ctx, "bandpass", 2400, 6);
  const whineLevel = gain(ctx, 0.02);
  chain(whine, whineFilter, whineLevel, engines);

  // Other aircraft.
  const banditLevel = gain(ctx, 1);
  banditLevel.connect(aircraftBus);
  const banditVoice = spatial(ctx, banditLevel, 420);
  jetVoice(ctx, white, banditVoice, 0.9);
  const wingmanVoice = spatial(ctx, aircraftBus, 45);
  jetVoice(ctx, white, wingmanVoice, 0.8);

  // Radar warning, placed on the bandit. Noise makes it easy to locate, as a pure beep is not.
  const warningVoice = spatial(ctx, aircraftBus, 3000);

  function warning(at) {
    for (const offset of [0, 0.13]) {
      const burst = ctx.createBufferSource();
      burst.buffer = white;
      const level = gain(ctx, 0);
      chain(burst, filter(ctx, "bandpass", 3000, 0.7), level, warningVoice);
      const tone = ctx.createOscillator();
      tone.type = "square";
      tone.frequency.value = 2300;
      const toneLevel = gain(ctx, 0);
      chain(tone, toneLevel, warningVoice);
      const start = at + offset;
      for (const [node, peak] of [[level, 0.5], [toneLevel, 0.1]]) {
        node.gain.setValueAtTime(peak, start);
        node.gain.exponentialRampToValueAtTime(0.0001, start + 0.075);
      }
      burst.start(start, Math.random() * 3, 0.09);
      tone.start(start);
      tone.stop(start + 0.09);
    }
  }

  // A low thump, placed where the bandit went down.
  const blastVoice = spatial(ctx, aircraftBus, 1500);

  function blast(at) {
    const burst = ctx.createBufferSource();
    burst.buffer = brown;
    const level = gain(ctx, 0);
    chain(burst, filter(ctx, "lowpass", 380, 0.7), level, blastVoice);
    level.gain.setValueAtTime(2.2, at);
    level.gain.exponentialRampToValueAtTime(0.001, at + 1.4);
    burst.start(at, Math.random() * 3, 1.5);
  }

  // Seeker tone: tells you the bandit is under your view without looking at a number, and rises as
  // the lock builds.
  const seeker = ctx.createOscillator();
  seeker.frequency.value = SEEKER_IDLE_HZ;
  seeker.start();
  const seekerLevel = gain(ctx, 0);
  chain(seeker, seekerLevel, aircraftBus);

  // Radio: a narrow, clipped channel with its own hiss and a squelch at each end.
  const radioBus = gain(ctx, 1.3);
  const radioInput = filter(ctx, "highpass", 420, 0.7);
  chain(radioInput, radioDistortion(ctx), filter(ctx, "lowpass", 2700, 0.7), radioBus, master);
  const hissLevel = gain(ctx, 0);
  chain(loop(ctx, white), filter(ctx, "bandpass", 2100, 0.8), hissLevel, radioBus);

  const voices = new Map();
  await Promise.all(RADIO_FILES.map(async name => {
    const response = await fetch(`/radio/${name}.m4a`);
    if (response.ok) voices.set(name, await ctx.decodeAudioData(await response.arrayBuffer()));
  }));

  function squelch(at) {
    const click = ctx.createBufferSource();
    click.buffer = white;
    const level = gain(ctx, 0);
    chain(click, filter(ctx, "bandpass", 1800, 1), level, radioBus);
    level.gain.setValueAtTime(0.28, at);
    level.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    click.start(at, Math.random() * 3, 0.07);
  }

  let radioBusyUntil = 0;

  function transmit(name) {
    const voice = voices.get(name);
    if (!voice) return;     // voices are generated on first run; the rest of the sound works without
    const start = ctx.currentTime + 0.12;
    const end = start + voice.duration;
    const source = ctx.createBufferSource();
    source.buffer = voice;
    source.connect(radioInput);
    source.start(start);
    squelch(start - 0.08);
    squelch(end + 0.06);
    hissLevel.gain.setTargetAtTime(0.05, start - 0.08, 0.01);
    hissLevel.gain.setTargetAtTime(0, end + 0.1, 0.01);
    aircraftBus.gain.setTargetAtTime(0.5, start - 0.08, 0.08);
    aircraftBus.gain.setTargetAtTime(1, end + 0.1, 0.25);
    radioBusyUntil = end + 0.3;
  }

  const between = ([low, high]) => low + Math.random() * (high - low);
  const pickCall = (() => {
    let last = null;
    return list => {
      const options = list.filter(name => name !== last);
      last = options[Math.floor(Math.random() * options.length)];
      return last;
    };
  })();

  function clockCall(azimuth) {
    const hour = ((Math.round(azimuth / 90) * 3 + 12) % 12) || 12;
    return CLOCK_CALLS[hour];
  }

  let nextCall = ctx.currentTime + 4;
  let nextWarning = ctx.currentTime + 2;
  let nextTally = 0;
  let inView = 0;
  const pending = [];     // fight calls waiting for the radio to clear

  const seconds = { rumble: 0.1, slow: 0.25 };

  return {
    context: ctx,

    setVolume(value) {
      master.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    },

    async setEnabled(on) {
      if (on) await ctx.resume();
      else await ctx.suspend();
    },

    update(scene, dt) {
      const now = ctx.currentTime;
      aim(ctx.listener, scene.listener.forward, scene.listener.up);
      place(banditVoice, scene.bandit);
      place(warningVoice, scene.bandit);
      place(blastVoice, scene.bandit);
      place(wingmanVoice, scene.wingman);
      place(engines, scene.tail);

      const { throttle, airspeed } = scene;
      rumbleFilter.frequency.setTargetAtTime(150 + 300 * throttle, now, seconds.slow);
      rumbleLevel.gain.setTargetAtTime(0.2 + 0.22 * throttle, now, seconds.slow);
      exhaustFilter.frequency.setTargetAtTime(800 + 2200 * throttle, now, seconds.slow);
      exhaustLevel.gain.setTargetAtTime(0.06 + 0.16 * throttle, now, seconds.slow);
      whine.frequency.setTargetAtTime(1500 + 2400 * throttle, now, seconds.slow);
      whineFilter.frequency.setTargetAtTime(1500 + 2400 * throttle, now, seconds.slow);
      whineLevel.gain.setTargetAtTime(0.012 + 0.03 * throttle, now, seconds.slow);
      windFilter.frequency.setTargetAtTime(700 + 1100 * airspeed, now, seconds.slow);
      windLevel.gain.setTargetAtTime(0.03 + 0.11 * airspeed, now, seconds.slow);

      banditLevel.gain.setTargetAtTime(scene.banditAlive ? 1 : 0, now, 0.05);
      const [low, high] = SEEKER_LOCK_HZ;
      seeker.frequency.setTargetAtTime(scene.locking || scene.locked ? low + (high - low) * scene.lock : SEEKER_IDLE_HZ, now, 0.02);
      seekerLevel.gain.setTargetAtTime(scene.onSight || scene.locked ? 0.018 : 0, now, 0.03);

      if (scene.banditAlive && now >= nextWarning) {
        warning(now + 0.02);
        nextWarning = now + (scene.threat > 0 ? URGENT_WARNING_GAP_S : WARNING_GAP_S);
      }

      for (const call of scene.calls) {
        if (call === "splash") blast(now);
        pending.push(call);
      }

      inView = scene.banditAlive && scene.banditFromView < TALLY_CONE_DEG ? inView + dt : 0;
      if (now < radioBusyUntil) return;
      if (pending.length) {
        transmit(pending.shift());
        nextCall = Math.max(nextCall, now + between(CALL_GAP_S));
      } else if (inView > TALLY_AFTER_S && now >= nextTally) {
        transmit(pickCall(TALLY_CALLS));
        nextTally = now + TALLY_GAP_S;
        nextCall = Math.max(nextCall, now + between(CALL_GAP_S));
      } else if (now >= nextCall) {
        const clock = scene.banditAlive && (scene.dogfight || Math.random() < CLOCK_CALL_ODDS);
        transmit(clock ? clockCall(scene.banditAzimuth) : pickCall(RADIO_CALLS));
        nextCall = now + between(CALL_GAP_S);
      }
    },
  };
}
