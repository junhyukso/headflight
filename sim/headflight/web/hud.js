// The head-up display, drawn to scale: the symbols sit at infinity in cockpit.js, so a line drawn
// 5 degrees above the center of this canvas really is 5 degrees above the nose.

const FONT = 'Menlo, Consolas, "DejaVu Sans Mono", monospace';
const COLOR = "#8dffb0";
const DEG = Math.PI / 180;

function text(ctx, string, x, y, align = "center") {
  ctx.textAlign = align;
  ctx.fillText(string, x, y);
}

function box(ctx, x, y, width, height) {
  ctx.strokeRect(x - width / 2, y - height / 2, width, height);
}

function rung(ctx, pitch, y) {
  const gap = 58, length = 120, tip = 14;
  // Rungs angle toward the horizon below it, so a glance tells which way is up.
  const slant = pitch < 0 ? -Math.tan(Math.min(-pitch, 45) / 2 * DEG) * length : 0;
  ctx.setLineDash(pitch < 0 ? [16, 10] : []);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * gap, y + (pitch < 0 ? slant : 0));
    ctx.lineTo(side * (gap + length), y);
    ctx.lineTo(side * (gap + length), y + (pitch < 0 ? -tip : tip));
    ctx.stroke();
    text(ctx, String(Math.abs(pitch)), side * (gap + length + 34), y + 1);
  }
  ctx.setLineDash([]);
}

function ladder(ctx, size, perDegree, pitch, roll) {
  const mid = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mid - 300, mid - 300, 600, 590);
  ctx.clip();
  ctx.translate(mid, mid);
  ctx.rotate(-roll * DEG);
  const horizon = pitch * perDegree;
  ctx.beginPath();
  ctx.moveTo(-340, horizon); ctx.lineTo(-58, horizon);
  ctx.moveTo(58, horizon); ctx.lineTo(340, horizon);
  ctx.stroke();
  const nearest = Math.round(pitch / 5) * 5;
  for (let at = nearest - 25; at <= nearest + 25; at += 5) {
    if (at !== 0 && Math.abs(at) <= 90) rung(ctx, at, (pitch - at) * perDegree);
  }
  ctx.restore();
}

function flightPath(ctx, mid) {
  ctx.beginPath();
  ctx.arc(mid, mid, 13, 0, Math.PI * 2);
  ctx.moveTo(mid - 38, mid); ctx.lineTo(mid - 13, mid);
  ctx.moveTo(mid + 13, mid); ctx.lineTo(mid + 38, mid);
  ctx.moveTo(mid, mid - 13); ctx.lineTo(mid, mid - 28);
  ctx.stroke();
}

function headingTape(ctx, mid, heading) {
  const top = 118, perDegree = 8.4, span = 26;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mid - 240, top - 44, 480, 90);
  ctx.clip();
  const first = Math.ceil((heading - span) / 5) * 5;
  for (let mark = first; mark <= heading + span; mark += 5) {
    const x = mid + (mark - heading) * perDegree;
    const major = mark % 10 === 0;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + (major ? 18 : 9));
    ctx.stroke();
    if (major) text(ctx, String(((mark + 360) % 360) / 10).padStart(2, "0"), x, top - 16);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(mid, top + 24); ctx.lineTo(mid - 9, top + 38); ctx.lineTo(mid + 9, top + 38); ctx.closePath();
  ctx.stroke();
}

function bankScale(ctx, mid, roll) {
  const center = mid - 60, radius = 390;
  ctx.save();
  ctx.translate(mid, center);
  for (const mark of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
    const angle = mark * DEG;
    const inner = radius - (mark % 30 === 0 ? 20 : 11);
    ctx.beginPath();
    ctx.moveTo(Math.sin(angle) * inner, Math.cos(angle) * inner);
    ctx.lineTo(Math.sin(angle) * radius, Math.cos(angle) * radius);
    ctx.stroke();
  }
  const pointer = Math.max(-50, Math.min(50, roll)) * DEG;
  ctx.rotate(-pointer);
  ctx.beginPath();
  ctx.moveTo(0, radius + 6); ctx.lineTo(-10, radius + 24); ctx.lineTo(10, radius + 24); ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function targetCue(ctx, mid, perDegree, target) {
  const { right, up, locked, locking } = target;
  const x = mid + right * perDegree, y = mid - up * perDegree;
  const inside = Math.abs(right) < 11.5 && up < 11 && up > -11;
  if (inside) {
    box(ctx, x, y, 44, 44);
    if (locked || locking) {
      ctx.save();
      ctx.lineWidth = locked ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 34); ctx.lineTo(x + 34, y); ctx.lineTo(x, y + 34); ctx.lineTo(x - 34, y); ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    return;
  }
  // Off the glass: a line from the flight path toward the bandit, labeled with how far off it is.
  const angle = Math.atan2(right, up);
  const offNose = Math.hypot(right, up);
  const [dx, dy] = [Math.sin(angle), -Math.cos(angle)];
  ctx.beginPath();
  ctx.moveTo(mid + dx * 40, mid + dy * 40);
  ctx.lineTo(mid + dx * 150, mid + dy * 150);
  ctx.stroke();
  text(ctx, String(Math.round(offNose)), mid + dx * 190, mid + dy * 190);
}

function rangeScale(ctx, mid, target) {
  const x = mid + 372, top = mid - 130, height = 260, fullScale = 10;
  ctx.beginPath();
  ctx.moveTo(x, top); ctx.lineTo(x, top + height);
  for (let i = 0; i <= 2; i++) { ctx.moveTo(x, top + height * i / 2); ctx.lineTo(x + 12, top + height * i / 2); }
  ctx.stroke();
  const km = target.range / 1000;
  const y = top + height * (1 - Math.min(km, fullScale) / fullScale);
  ctx.beginPath();
  ctx.moveTo(x - 4, y); ctx.lineTo(x - 20, y - 9); ctx.lineTo(x - 20, y + 9); ctx.closePath();
  ctx.stroke();
  text(ctx, km.toFixed(1), x - 28, y, "right");
  if (target.closure !== null) text(ctx, `${Math.round(target.closure)}V`, x - 28, y + 28, "right");
}

// `data` holds flight values, `systems` the HUD-related switch states, `target` the bandit if the
// radar sees it.
export function drawHud(ctx, pixels, data, systems, target) {
  const { pitch, roll, heading, knots, feet, mach, g, peakG, status } = data;
  const size = 1024;        // everything below is laid out on this scale, whatever the canvas is
  const mid = size / 2;
  const perDegree = size / 26;
  ctx.setTransform(pixels / size, 0, 0, pixels / size, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.globalAlpha = systems.brightness;
  ctx.strokeStyle = ctx.fillStyle = COLOR;
  ctx.lineWidth = 2.2;
  ctx.font = `24px ${FONT}`;
  ctx.textBaseline = "middle";

  flightPath(ctx, mid);
  ctx.lineWidth = 2.2;
  if (systems.reject < 2) ladder(ctx, size, perDegree, pitch, roll);

  ctx.textAlign = "center";
  if (systems.reject < 2) headingTape(ctx, mid, heading);
  if (systems.reject === 0) bankScale(ctx, mid, roll);

  // Speed on the left and altitude on the right, in boxes the eye can find without searching.
  ctx.font = `30px ${FONT}`;
  box(ctx, mid - 330, mid, 118, 50);
  box(ctx, mid + 330, mid, 136, 50);
  text(ctx, String(Math.round(knots)), mid - 330, mid + 1);
  const hundreds = Math.round(feet / 10) * 10;
  text(ctx, hundreds.toLocaleString("en-US"), mid + 330, mid + 1);
  ctx.font = `24px ${FONT}`;

  const left = mid - 388;
  if (systems.reject === 0) {
    text(ctx, `M ${mach.toFixed(2)}`, left, mid + 62, "left");
    text(ctx, `G ${g.toFixed(1)}`, left, mid + 92, "left");
    text(ctx, peakG.toFixed(1), left + 22, mid + 122, "left");
  }
  text(ctx, systems.mode, left, mid + 162, "left");
  if (systems.weapon) text(ctx, systems.weapon, mid + 268, mid + 162, "left");
  if (systems.autopilot) text(ctx, `A/P ${systems.autopilot}`, mid, 184);
  if (systems.gearDown) text(ctx, "GEAR", mid + 268, mid + 66, "left");
  if (systems.warning) text(ctx, systems.warning, mid, 214);

  if (target) {
    targetCue(ctx, mid, perDegree, target);
    rangeScale(ctx, mid, target);
  }
  if (status) {
    ctx.font = `32px ${FONT}`;
    text(ctx, status, mid, mid + 200);
  }
  ctx.globalAlpha = 1;
}
