// Engine sound synthesis + vehicle physics, running inside an AudioWorklet.
//
// Sound model based on:
//  - "Physics-Informed Neural Engine Sound Modeling with Differentiable
//    Pulse-Train Synthesis" (arXiv:2603.09391): engine sound = train of bipolar
//    exhaust pressure pulses aligned to firing phase, asymmetric pressure-release
//    envelope, downward intra-pulse pitch, per-bank Karplus-Strong resonators.
//  - Baldan, Delle Monache, Rocchesso, "Physically informed car engine sound
//    synthesis for virtual and augmented environments" (IEEE SIVE 2015).
//  - A. Farnell, "Designing Sound" (MIT Press): angle-locked per-cylinder phases.
//
// Key design decision: everything is synthesized in the CRANK-ANGLE domain.
// Each cylinder's waveform is a continuous function of crank angle, so rpm can
// change arbitrarily fast without any waveform discontinuity (no clicks on
// shifts / rev changes). Per-cycle parameters (combustion amplitude jitter,
// fuel-cut) are sampled only at the start of each cylinder's pulse where the
// envelope is zero.

const TWO_PI = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const PHYS_INTERVAL = 64;       // samples between physics steps
const DEFAULT_PULSE_WINDOW = 260; // crank degrees of one exhaust pulse
const LAYOUTS = new Set(['inline', 'v60', 'v90', 'flat', 'crossplane', 'vtwin']);
const ENVELOPE_TABLE_SIZE = 2048;
const PULSE_ENVELOPE = new Float32Array(ENVELOPE_TABLE_SIZE + 1);
const INTAKE_ENVELOPE = new Float32Array(ENVELOPE_TABLE_SIZE + 1);

for (let i = 0; i <= ENVELOPE_TABLE_SIZE; i++) {
  const u = i / ENVELOPE_TABLE_SIZE;
  const om = 1 - u;
  PULSE_ENVELOPE[i] = 6.0 * Math.pow(u, 0.7) * om * om * om;
  const s = Math.sin(Math.PI * u);
  INTAKE_ENVELOPE[i] = s * s;
}

function finiteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function defaultConfig() {
  return {
    displacement: 2.0,     // L
    cylinders: 4,
    layout: 'inline',      // inline | v60 | v90 | flat | crossplane | vtwin
    firingUnevenness: 0,
    idleRpm: 850,
    redline: 7200,
    maxTorque: 200,        // Nm
    peakTorqueRpm: 4200,
    maxSpeedKmh: 220,
    vehicleMass: 1300,     // kg
    maxBrakeG: 0.9,        // peak braking deceleration (g)
    numGears: 6,
    engineInertia: 0.18,
    engineBrake: 1.0,
    transmission: 'auto',
    pipeLength: 2.5,       // m
    muffler: 0.55,         // 0 = straight pipe
    drive: 0.35,
    intakeNoise: 0.35,
    crackle: 0.25,
    turboWhine: 0,
    mechanicalNoise: 0.35,
    camLope: 0.05,
  };
}

function sanitizeConfig(input) {
  const d = defaultConfig();
  const c = Object.assign(d, input || {});
  c.displacement = clamp(finiteNumber(c.displacement, d.displacement), 0.05, 9);
  c.cylinders = Math.round(clamp(finiteNumber(c.cylinders, d.cylinders), 1, 16));
  c.layout = LAYOUTS.has(c.layout) ? c.layout : d.layout;
  c.firingUnevenness = clamp(finiteNumber(c.firingUnevenness, d.firingUnevenness), 0, 1);
  c.idleRpm = clamp(finiteNumber(c.idleRpm, d.idleRpm), 400, 5000);
  c.redline = clamp(finiteNumber(c.redline, d.redline), Math.max(3000, c.idleRpm + 500), 20000);
  c.maxTorque = clamp(finiteNumber(c.maxTorque, d.maxTorque), 20, 1200);
  c.peakTorqueRpm = clamp(finiteNumber(c.peakTorqueRpm, d.peakTorqueRpm), 1000, Math.max(1100, c.redline - 200));
  c.maxSpeedKmh = clamp(finiteNumber(c.maxSpeedKmh, d.maxSpeedKmh), 60, 450);
  c.vehicleMass = clamp(finiteNumber(c.vehicleMass, d.vehicleMass), 100, 3500);
  c.maxBrakeG = clamp(finiteNumber(c.maxBrakeG, d.maxBrakeG), 0.3, 6);
  c.numGears = Math.round(clamp(finiteNumber(c.numGears, d.numGears), 1, 9));
  c.engineInertia = clamp(finiteNumber(c.engineInertia, d.engineInertia), 0.03, 1.5);
  c.engineBrake = clamp(finiteNumber(c.engineBrake, d.engineBrake), 0, 3);
  c.transmission = c.transmission === 'manual' ? 'manual' : 'auto';
  c.pipeLength = clamp(finiteNumber(c.pipeLength, d.pipeLength), 0.4, 6);
  c.muffler = clamp(finiteNumber(c.muffler, d.muffler), 0, 1);
  c.drive = clamp(finiteNumber(c.drive, d.drive), 0, 1);
  c.intakeNoise = clamp(finiteNumber(c.intakeNoise, d.intakeNoise), 0, 1);
  c.crackle = clamp(finiteNumber(c.crackle, d.crackle), 0, 1);
  c.turboWhine = clamp(finiteNumber(c.turboWhine, d.turboWhine), 0, 1);
  c.mechanicalNoise = clamp(finiteNumber(c.mechanicalNoise, d.mechanicalNoise), 0, 1);
  c.camLope = clamp(finiteNumber(c.camLope, d.camLope), 0, 1);
  return c;
}

function hash01(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildFiringTable(cfg) {
  const n = Math.max(1, Math.round(cfg.cylinders));
  const fires = [];
  const step = 720 / n;
  if (cfg.layout === 'vtwin') {
    const m = Math.max(2, n);
    const vstep = 720 / m; // use the effective cylinder count for spacing
    for (let i = 0; i < m; i++) {
      const base = i * vstep;
      fires.push({ angle: (i % 2 === 0) ? base : base + vstep * 0.28, bank: 0 });
    }
  } else if (cfg.layout === 'crossplane' && n === 8) {
    const banks = [0, 1, 0, 0, 1, 0, 1, 1];
    for (let i = 0; i < 8; i++) fires.push({ angle: i * 90, bank: banks[i] });
  } else {
    const twoBank = (cfg.layout === 'v60' || cfg.layout === 'v90' || cfg.layout === 'flat' || cfg.layout === 'crossplane');
    for (let i = 0; i < n; i++) fires.push({ angle: i * step, bank: twoBank ? i % 2 : 0 });
  }
  if (cfg.firingUnevenness > 0) {
    for (let i = 1; i < fires.length; i++) {
      fires[i].angle += (hash01(i) - 0.5) * step * 0.9 * cfg.firingUnevenness;
    }
  }
  for (const f of fires) f.angle = ((f.angle % 720) + 720) % 720;
  const numBanks = fires.reduce((m, f) => Math.max(m, f.bank), 0) + 1;
  return { fires, numBanks };
}

// Karplus-Strong style feedback delay line with in-loop damping lowpass
// (per-bank exhaust resonator, see arXiv:2603.09391 sec. resonator design).
// Strong damping keeps the resonance from ringing on after the excitation
// stops — a long fixed-pitch ring under a falling engine pitch sounds like a
// "stuck robotic tone".
class Comb {
  constructor(sr, freq, g, damp) {
    this.size = 1 << 14;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.tune(sr, freq);
    this.g = g; // negative -> odd harmonics (quarter-wave / closed pipe)
    this.damp = damp;
    this.lp = 0;
  }
  // retune without resetting the buffer (live config editing stays click-free)
  tune(sr, freq) {
    this.delay = clamp(Math.round(sr / (2 * freq)), 4, this.size - 4);
  }
  process(x) {
    const i1 = (this.w - this.delay + this.size) % this.size;
    const i2 = (i1 - 1 + this.size) % this.size;
    this.lp += this.damp * (0.55 * this.buf[i1] + 0.45 * this.buf[i2] - this.lp);
    const y = x + this.g * this.lp;
    this.buf[this.w] = y;
    this.w = (this.w + 1) % this.size;
    return y;
  }
}

// RBJ bandpass biquad (fixed body/shell formants)
class Bandpass {
  constructor(sr, f, q) {
    const w = TWO_PI * f / sr;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = -2 * Math.cos(w) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.cfg = null;
    this.controls = {
      throttle: 0, brake: 0, ignition: true,
      mode: 'sim', extRpm: 1000, extLoad: null,
    };
    // physics state
    this.rpm = 0;
    this.speed = 0;
    this.gear = 1;
    this.time = 0;
    this.physCounter = 0;
    this.limiterUntil = -1;
    this.shiftUntil = -1;   // upshift torque cut
    this.blipUntil = -1;    // downshift rev-match blip
    this.blipStrength = 0.45;
    this.lastShiftT = -10;
    this.manualHoldUntil = -1; // manual shift pauses auto scheduling
    this.clutchLocked = false;
    this.limiterOn = false;
    this.shiftCutOn = false;
    this.accel = 0;       // smoothed vehicle acceleration (m/s^2)
    this.prevSpeed = 0;
    this.coastSince = 0;  // when the throttle was last released
    this.prevThrottle = 0;
    this.throttleVel = 0;
    this.prevAcousticRpm = 0;
    this.loadTransient = 0; // short timbre change from load/rev derivatives
    this.liftHoldUntil = -1; // short sport/engine-brake hold after big lifts
    this.effLoadT = 0;      // load target (pre-cut), slewed into audioLoad
    this.effThr = 0;
    this.decelFlowT = 0;    // closed-throttle back-driven airflow target
    this.manifold = 0;      // normalized intake manifold filling / air mass
    this.turboSpool = 0;    // slow turbo/e-motor acoustic energy
    this.bypassEnv = 0;     // turbo recirculation / wastegate transient
    // audio-rate smoothed values (remove clicks when physics jumps)
    this.audioRpm = 0;
    this.audioLoad = 0;
    this.audioDecel = 0;
    this.kRpm = 1 - Math.exp(-1 / (0.025 * this.sr));  // ~25 ms smoothing
    this.riseLim = 15000 / this.sr;  // rpm/sample: free-rev blips stay snappy
    this.kLoad = 1 - Math.exp(-1 / (0.045 * this.sr)); // fast acoustic load response
    this.kDecel = 1 - Math.exp(-1 / (0.090 * this.sr)); // DFCO airflow slew
    this.kDC = 1 - Math.exp(-TWO_PI * 15 / this.sr);   // 15 Hz DC blocker
    // synthesis state
    this.theta = 0;         // crank cycle angle 0..720
    this.cyls = [];
    this.pops = [];         // afterfire transients (event-based, short)
    this.noiseLP = 0;
    this.bedEnv0 = 0;
    this.bedEnv1 = 0;
    this.wander = 1;
    this.outLP = 0;
    this.mufLP = 0;
    this.rumbleLP = 0;
    this.rumbleDC = 0;
    this.mechPhase = 0;
    this.mechLP = 0;
    this.gearWhinePhase = 0;
    this.orderPhase = 0;
    this.orderLP = 0;
    this.sideLP = 0;
    this.turboPhase = 0;
    this.hybridPhase = 0;
    this.bypassPhase = 0;
    this.intakeLP1 = 0;
    this.intakeLP2 = 0;
    this.intakeBed = 0;
    this.reportCounter = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.applyConfig(defaultConfig());
  }

  onMessage(m) {
    if (m.type === 'config') this.applyConfig(m.config);
    else if (m.type === 'controls') {
      // sanitize: a single NaN (e.g. malformed OSC float) would poison the
      // integrators permanently and silence the engine until reload
      for (const k of Object.keys(m.controls)) {
        const v = m.controls[k];
        if (typeof v === 'number' && !Number.isFinite(v)) continue;
        this.controls[k] = v;
      }
    }
    else if (m.type === 'command') this.command(m.cmd);
  }

  command(cmd) {
    const c = this.cfg;
    if (cmd === 'gearUp' && this.gear < c.numGears) {
      this.gear++;
      // audible torque-cut dip only when there is torque to cut
      if (clamp(this.controls.throttle, 0, 1) > 0.25) this.shiftUntil = this.time + 0.15;
      this.lastShiftT = this.time; this.manualHoldUntil = this.time + 2.5;
      this.syncRpmToWheels();
    } else if (cmd === 'gearDown' && this.gear > 0) {
      // short rev-match blip only: a long one cancels engine braking
      this.gear--; this.blipUntil = this.time + 0.12; this.blipStrength = 0.5;
      this.lastShiftT = this.time; this.manualHoldUntil = this.time + 2.5;
      this.syncRpmToWheels();
    } else if (cmd === 'neutral') { this.gear = 0; }
    else if (cmd === 'drive' && this.gear === 0) { this.gear = 1; this.syncRpmToWheels(); }
    else if (cmd === 'testpop') this.spawnPop(); // debug: fire one afterfire pop
  }

  // momentum-conserving clutch engagement on gear changes: spinning the
  // engine up to match a lower gear takes kinetic energy FROM the car (the
  // deceleration jolt you feel on an aggressive downshift); an upshift gives
  // the engine's excess spin back as a slight surge.
  syncRpmToWheels() {
    const c = this.cfg;
    if (this.gear <= 0) return;
    const G = c.ratios[this.gear - 1] * c.finalDrive;
    const rpmW = this.speed / c.wheelR * G * 60 / TWO_PI;
    if (rpmW <= c.idleRpm * 0.98) return; // too slow: clutch stays slipping
    const gr = G / c.wheelR;                       // rad of engine per m of car
    const iEq = c.engineInertia * gr * gr;         // engine inertia felt by car
    const wE = this.rpm * TWO_PI / 60;
    const vNew = (c.vehicleMass * this.speed + c.engineInertia * wE * gr) /
                 (c.vehicleMass + iEq);
    this.speed = Math.max(0, vNew);
    this.rpm = this.speed / c.wheelR * G * 60 / TWO_PI;
  }

  applyConfig(cfg) {
    cfg = sanitizeConfig(cfg);
    this.cfg = cfg;
    const c = cfg;
    c.cylVol = c.displacement / Math.max(1, c.cylinders);
    // pulse loudness ~ cylinder volume; carrier cycle count ~ 1/size (small
    // cylinders "bark" higher, big cylinders "thump" lower)
    c.pulseAmp = 0.22 + 0.85 * Math.pow(c.cylVol, 0.6);
    c.carrierScale = clamp(0.9 / Math.cbrt(c.cylVol + 0.02), 0.7, 2.6);
    c.pulseWindow = clamp(215 + 58 * Math.cbrt(c.cylVol + 0.02) - (c.redline > 10000 ? 18 : 0), 205, 295);
    c.mainOrder = Math.max(0.5, c.cylinders / 2);
    c.bankSpread = (c.layout === 'v60' || c.layout === 'v90' || c.layout === 'flat' || c.layout === 'crossplane') ? 1 : 0;
    c.layoutRumble = c.layout === 'crossplane' ? 1.25 : (c.layout === 'vtwin' ? 1.45 : (c.layout === 'inline' && c.cylinders <= 4 ? 0.85 : 0.55));
    const ft = buildFiringTable(c);
    // rebuild cylinder state only when the firing structure actually changed;
    // otherwise keep phases/amps so live config edits don't click
    const sameTable = this.cyls.length === ft.fires.length &&
      ft.fires.every((f, i) => Math.abs(this.cyls[i].angle - f.angle) < 1e-9 && this.cyls[i].bank === f.bank);
    if (!sameTable) {
      this.cyls = ft.fires.map((f, i) => ({
        angle: f.angle, bank: f.bank, microJitter: 0,
        lastX: 1e9, amp: 0, carrier: 3, chirp: 1, cutState: false,
        // fixed per-cylinder manufacturing variation: gives each cylinder its
        // own voice instead of per-cycle randomness (which sounds granular)
        trim: 0.97 + hash01(i + 7) * 0.06,
        carrierTrim: 0.95 + hash01(i + 41) * 0.10,
      }));
    }
    // exhaust resonators: one per bank (header) + shared tailpipe.
    // moderate feedback + strong in-loop damping = short, warm ring.
    // retuned in place when possible (no buffer reset while editing live)
    const hotGasC = 430 + 75 * (1 - c.muffler) + 25 * c.drive;
    const f0 = hotGasC / (4 * Math.max(0.3, c.pipeLength));
    const fbBank = -(0.30 + (1 - c.muffler) * 0.32);
    if (!this.bankCombs || this.bankCombs.length !== ft.numBanks) {
      this.bankCombs = [];
      for (let b = 0; b < ft.numBanks; b++) {
        this.bankCombs.push(new Comb(this.sr, f0 * (1 + b * 0.04), fbBank, 0.35));
      }
    } else {
      for (let b = 0; b < this.bankCombs.length; b++) {
        this.bankCombs[b].tune(this.sr, f0 * (1 + b * 0.04));
        this.bankCombs[b].g = fbBank;
      }
    }
    if (!this.tailComb) {
      this.tailComb = new Comb(this.sr, f0 * 0.62, 0.16 * (1 - c.muffler * 0.5), 0.22);
    } else {
      this.tailComb.tune(this.sr, f0 * 0.62);
      this.tailComb.g = 0.16 * (1 - c.muffler * 0.5);
    }
    // broad, non-vocal body coloration (two mid formants at 170/520 Hz sit
    // exactly on vowel F1/F2 and made the engine sound like a robot voice)
    if (!this.formant1) {
      this.formant1 = new Bandpass(this.sr, 118, 0.8);
      this.formant2 = new Bandpass(this.sr, 1150, 0.7);
    }
    // ---- drivetrain derived values ----
    const r = 0.31;
    const finalDrive = 3.9;
    const vmax = c.maxSpeedKmh / 3.6;
    const wRed = c.redline * TWO_PI / 60;
    let gTop = wRed * r / (finalDrive * vmax);
    let g1 = 3.6;
    if (gTop >= g1) g1 = gTop * 1.6;
    const ng = Math.max(1, Math.round(c.numGears));
    c.ratios = [];
    for (let i = 0; i < ng; i++) {
      c.ratios.push(ng === 1 ? gTop : g1 * Math.pow(gTop / g1, i / (ng - 1)));
    }
    c.finalDrive = finalDrive;
    c.wheelR = r;
    const Crr = 0.012;
    const fAvail = this.torqueCurve(c.redline) * gTop * finalDrive * 0.9 / r;
    c.CdA = clamp((fAvail - Crr * c.vehicleMass * 9.81) * 2 / (1.225 * vmax * vmax), 0.2, 2.5);
    c.Crr = Crr;
    // audio helpers
    c.mufCoef = 1 - Math.exp(-TWO_PI * (900 + (1 - c.muffler) * 6500) / this.sr);
    c.drivePre = 1.1 + c.drive * 4.5;
    c.drivePost = 0.9 / (1 + c.drive * 0.7);
    if (this.gear > c.numGears) this.gear = c.numGears;
    let pMax = 0;
    for (let rpm = 1000; rpm <= c.redline; rpm += 100) {
      pMax = Math.max(pMax, this.torqueCurve(rpm) * rpm * TWO_PI / 60 / 1000);
    }
    this.port.postMessage({ type: 'derived', powerKw: pMax, ratios: c.ratios.map(x => +x.toFixed(2)), CdA: +c.CdA.toFixed(2) });
  }

  torqueCurve(rpm) {
    const c = this.cfg;
    if (rpm <= 0) return 0;
    if (rpm < c.peakTorqueRpm) {
      const x = clamp(rpm / c.peakTorqueRpm, 0, 1);
      const s = x * x * (3 - 2 * x);
      return c.maxTorque * (0.5 + 0.5 * s);
    }
    const x = clamp((rpm - c.peakTorqueRpm) / Math.max(500, c.redline - c.peakTorqueRpm), 0, 1.2);
    return c.maxTorque * (1 - 0.4 * x * x);
  }

  updateDynamicTimbre(dt) {
    const rpmRate = (this.rpm - this.prevAcousticRpm) / Math.max(dt, 1e-6);
    this.prevAcousticRpm = this.rpm;
    const target = clamp(
      Math.abs(this.throttleVel) * 0.025 +
      Math.abs(rpmRate) / Math.max(6000, this.cfg.redline * 3.2),
      0, 1,
    );
    const tau = target > this.loadTransient ? 0.012 : 0.14;
    this.loadTransient += (target - this.loadTransient) * (1 - Math.exp(-dt / tau));
  }

  // ---------- vehicle / rpm physics ----------
  physics(dt) {
    const c = this.cfg;
    const ctl = this.controls;
    this.time += dt;

    if (ctl.mode === 'ext') {
      const extThr = clamp(ctl.throttle, 0, 1);
      this.throttleVel = (extThr - this.prevThrottle) / Math.max(dt, 1e-6);
      this.prevThrottle = extThr;
      const target = clamp(ctl.extRpm, 0, c.redline * 1.05);
      const maxStep = 25000 * dt;
      this.rpm += clamp(target - this.rpm, -maxStep, maxStep);
      this.effLoadT = ctl.extLoad != null ? clamp(ctl.extLoad, 0, 1) : clamp(ctl.throttle, 0, 1);
      this.effThr = this.effLoadT;
      this.decelFlowT = 0;
      const extAir = ctl.ignition ? this.effLoadT : 0;
      this.manifold += clamp((extAir - this.manifold) * dt / 0.08, -0.12, 0.12);
      const rpmBoost = clamp((this.rpm - c.idleRpm * 0.7) / Math.max(800, c.redline * 0.58), 0, 1);
      const spoolTarget = ctl.ignition ? c.turboWhine * rpmBoost * (0.15 + 0.85 * this.manifold) : 0;
      const spoolTau = spoolTarget > this.turboSpool ? 0.18 + 0.10 * (1 - c.turboWhine) : 0.42;
      this.turboSpool += clamp((spoolTarget - this.turboSpool) * dt / spoolTau, -0.08, 0.08);
      this.limiterOn = false;
      this.shiftCutOn = false;
      if (this.gear > 0) {
        const G = c.ratios[this.gear - 1] * c.finalDrive;
        this.speed = this.rpm / 60 * TWO_PI * c.wheelR / G;
      }
      this.updateDynamicTimbre(dt);
      return;
    }

    const thr = clamp(ctl.throttle, 0, 1);
    this.throttleVel = (thr - this.prevThrottle) / Math.max(dt, 1e-6);
    if (this.prevThrottle > 0.65 && thr < 0.12 && this.gear > 0 && this.speed > 2) {
      this.liftHoldUntil = this.time + 1.6;
      if (c.crackle > 0 && this.rpm > c.idleRpm * 1.8 && Math.random() < 0.45 * c.crackle) this.spawnPop();
      if (c.turboWhine > 0.05 && this.turboSpool > 0.12) {
        this.bypassEnv = Math.max(this.bypassEnv, this.turboSpool * c.turboWhine * 0.75);
      }
    }
    this.prevThrottle = thr;

    const idleLump = c.camLope * clamp(1 - this.rpm / (c.idleRpm * 2.2), 0, 1) * (1 - clamp(thr * 3, 0, 1));
    const idleTarget = c.idleRpm * (
      1 + idleLump * (0.018 * Math.sin(this.time * 12.7) + 0.012 * Math.sin(this.time * 19.1 + 0.7))
    );
    const idleThr = ctl.ignition ? clamp((idleTarget + 60 - this.rpm) / 350, 0, 0.35 + c.camLope * 0.05) : 0;
    let effThr = Math.max(thr, idleThr);
    // downshift rev-match blip
    if (this.time < this.blipUntil) effThr = Math.max(effThr, this.blipStrength);
    if (!ctl.ignition) effThr = 0;

    // rev limiter, split into two decoupled parts:
    //  SOUND: hard cut with a FIXED ~12 Hz rhythm (45 ms cut / 40 ms burn) —
    //  the classic "bah-bah-bah" with real volume dips but guaranteed
    //  full-power bursts, independent of engine inertia.
    //  TORQUE: a smooth governor that fades torque to zero approaching the
    //  redline — a rhythmic torque cut would let low-inertia engines run away
    //  through the burn windows (observed: 43,000 rpm on the F1 preset).
    if (this.rpm >= c.redline * 0.995) this.limiterUntil = this.time + 0.10;
    const limiterArmed = this.time < this.limiterUntil;
    this.limiterOn = limiterArmed && (this.time % 0.085) < 0.045;
    this.shiftCutOn = this.time < this.shiftUntil;
    // effLoadT (sound brightness) deliberately does NOT collapse during cuts —
    // the stutter comes from per-cycle amplitude gating in newCycle().
    let thrForTorque = effThr;
    if (!ctl.ignition) thrForTorque = 0;
    else if (limiterArmed) thrForTorque *= clamp((c.redline - this.rpm) / (c.redline * 0.012), 0, 1);
    else if (this.shiftCutOn) thrForTorque *= 0.15;

    const rpmNPhys = clamp(this.rpm / c.redline, 0, 1);
    const airDemand = Math.pow(clamp(thrForTorque, 0, 1), 0.65);
    const manifoldTarget = ctl.ignition ? airDemand : 0;
    const manifoldTau = manifoldTarget > this.manifold ?
      0.030 + 0.045 * (1 - rpmNPhys) :
      0.090 + 0.060 * rpmNPhys;
    this.manifold += clamp((manifoldTarget - this.manifold) * dt / manifoldTau, -0.12, 0.12);
    const torqueAir = 0.38 * airDemand + 0.62 * this.manifold;

    const rpmBoost = clamp((this.rpm - c.idleRpm * 0.7) / Math.max(800, c.redline * 0.58), 0, 1);
    const spoolTarget = ctl.ignition ? c.turboWhine * rpmBoost * (0.15 + 0.85 * torqueAir) : 0;
    const spoolTau = spoolTarget > this.turboSpool ? 0.18 + 0.10 * (1 - c.turboWhine) : 0.42;
    this.turboSpool += clamp((spoolTarget - this.turboSpool) * dt / spoolTau, -0.08, 0.08);

    // Pedal input fills a manifold instead of instantly becoming cylinder air.
    // This keeps transients from sounding like an on/off synth envelope.
    let tEngine = torqueAir * this.torqueCurve(this.rpm);
    const turboTorqueLag = 1 - c.turboWhine * 0.16 +
      c.turboWhine * 0.16 * clamp(this.turboSpool / Math.max(c.turboWhine, 0.001), 0, 1);
    tEngine *= turboTorqueLag;
    // closed-throttle motoring torque (pumping + friction). Sized to real
    // measurements (~50-70 Nm for a 2L at high rpm) so engine braking
    // through a low gear actually hauls the car down
    const tFric = c.engineBrake * c.displacement * (9 + 20 * this.rpm / c.redline) * (1 - 0.6 * torqueAir);
    tEngine -= tFric;
    if (ctl.ignition && this.rpm < c.idleRpm * 0.6) tEngine += 35; // starter

    const m = c.vehicleMass;
    const brakeF = clamp(ctl.brake, 0, 1) * m * 9.81 * c.maxBrakeG;
    const dragF = 0.5 * 1.225 * c.CdA * this.speed * this.speed;
    const rrF = this.speed > 0.1 ? c.Crr * m * 9.81 : 0;

    if (this.gear === 0) {
      const dw = tEngine / c.engineInertia;
      this.rpm = Math.max(0, this.rpm + dw * dt * 60 / TWO_PI);
      const dv = -(dragF + rrF + brakeF) / m;
      this.speed = Math.max(0, this.speed + dv * dt);
    } else {
      const G = c.ratios[this.gear - 1] * c.finalDrive;
      const r = c.wheelR;
      const rpmFromWheel = this.speed / r * G * 60 / TWO_PI;
      // clutch state with hysteresis; on lock the ENGINE syncs to the wheels
      // (never the other way round, which would drag the car speed back and
      // trap the launch in a slip/lock oscillation at the boundary)
      if (!this.clutchLocked && rpmFromWheel >= c.idleRpm * 1.02) {
        this.clutchLocked = true;
        this.rpm = rpmFromWheel;
      } else if (this.clutchLocked && rpmFromWheel < c.idleRpm * 0.96) {
        this.clutchLocked = false;
      }
      if (!this.clutchLocked) {
        // clutch slipping (launch / near stop)
        const engage = clamp((this.rpm - c.idleRpm * 0.7) / 800, 0, 1);
        const tClutch = engage * c.maxTorque * 0.9;
        const dw = (tEngine - tClutch * 0.85) / c.engineInertia;
        this.rpm = Math.max(0, this.rpm + dw * dt * 60 / TWO_PI);
        const dv = (tClutch * G * 0.9 / r - dragF - rrF - brakeF) / m;
        this.speed = Math.max(0, this.speed + dv * dt);
      } else {
        const iEff = c.engineInertia + m * r * r / (G * G);
        const tLoad = (dragF + rrF + brakeF) * r / G;
        const dw = (tEngine * 0.9 - tLoad) / iEff;
        let w = this.rpm * TWO_PI / 60 + dw * dt;
        w = Math.max(0, w);
        this.rpm = w * 60 / TWO_PI;
        this.speed = Math.max(0, w * r / G);
      }
      if (c.transmission === 'auto' && !this.shiftCutOn && this.time >= this.blipUntil && this.time >= this.manualHoldUntil) {
        const sinceShift = this.time - this.lastShiftT;
        const coasting = thr < 0.08;
        const lowLoad = thr < 0.25;
        if (!coasting) this.coastSince = this.time;
        const coastTime = this.time - this.coastSince;
        const hardLiftHold = coasting && this.time < this.liftHoldUntil;
        // throttle-dependent shift point: light throttle -> early upshift,
        // full throttle -> near redline (natural AT scheduling)
        const upLo = c.idleRpm * 1.85;
        const upRpm = Math.min(c.redline * 0.96, upLo + (c.redline * 0.96 - upLo) * Math.pow(thr, 1.35));
        // anti-hunting guards: never upshift while the clutch is slipping
        // (engine revs freely at walking pace), and only if the post-shift rpm
        // stays clear of the coast-downshift threshold
        const driveDownRpm = Math.max(c.idleRpm * 1.25, c.peakTorqueRpm * 0.35);
        const coastDownRpm = Math.max(c.idleRpm * 1.45, Math.min(c.peakTorqueRpm * 0.52, c.redline * 0.42));
        const rpmAfterUp = this.gear < c.numGears ? this.rpm * c.ratios[this.gear] / c.ratios[this.gear - 1] : 0;
        // Do not treat a closed throttle as a request for an economy upshift.
        // After a 100% -> 0% lift the old logic saw "light throttle" and
        // shifted upward during engine braking, then chased itself downward.
        const overrevProtection = coasting && this.rpm > c.redline * 1.02;
        const allowUpshift = !coasting || overrevProtection;
        const upInterval = lowLoad ? 0.9 : 0.6;
        const upMargin = lowLoad ? 1.22 : 1.12;
        if (this.clutchLocked && this.rpm > upRpm && this.gear < c.numGears && sinceShift > upInterval &&
            rpmAfterUp > driveDownRpm * upMargin && allowUpshift && !hardLiftHold) {
          this.gear++;
          if (!lowLoad) this.shiftUntil = this.time + 0.15;
          this.lastShiftT = this.time; this.syncRpmToWheels();
        } else if (this.gear > 1 && sinceShift > 0.8) {
          const rpmAfter = this.rpm * c.ratios[this.gear - 2] / c.ratios[this.gear - 1];
          if (thr > 0.85 && rpmAfter < c.redline * 0.8) {
            // kickdown for passing acceleration
            this.gear--; this.blipUntil = this.time + 0.2; this.blipStrength = 0.65;
            this.lastShiftT = this.time; this.syncRpmToWheels();
          } else if (coasting && coastTime > 0.35 && this.rpm < coastDownRpm &&
                     rpmAfter < c.redline * 0.82) {
            // Coast-down: keep the current gear for engine braking, then step
            // down only as road speed falls. No throttle blip while braking.
            this.gear--; this.blipUntil = this.time + 0.15;
            this.blipStrength = 0.45 * (1 - clamp(ctl.brake * 2, 0, 0.9));
            this.lastShiftT = this.time; this.syncRpmToWheels();
          } else if (!coasting && this.rpm < driveDownRpm && rpmAfter < c.redline * 0.85) {
            this.gear--; this.blipUntil = this.time + 0.12; this.blipStrength = 0.35;
            this.lastShiftT = this.time; this.syncRpmToWheels();
          }
        }
      }
    }

    this.effThr = effThr;
    const overrun = ctl.ignition && this.gear > 0 && thr < 0.08 &&
      this.speed > 0.5 && this.rpm > c.idleRpm * 1.22;
    const rpmOver = clamp((this.rpm - c.idleRpm * 1.22) / Math.max(500, c.redline - c.idleRpm * 1.22), 0, 1);
    this.decelFlowT = overrun ? clamp(0.15 + 0.85 * rpmOver + 0.12 * c.engineBrake / 3, 0, 1) : 0;
    const soundLoad = 0.25 * effThr + 0.75 * torqueAir;
    this.effLoadT = ctl.ignition ? soundLoad * (1 - 0.50 * this.decelFlowT) : 0;

    // smoothed vehicle acceleration (used by the AT scheduler)
    const aInst = (this.speed - this.prevSpeed) / dt;
    this.prevSpeed = this.speed;
    this.accel += 0.08 * (aInst - this.accel);
    this.updateDynamicTimbre(dt);

    // slow multiplicative combustion drift (~1 Hz random walk, ±5%):
    // real engines breathe; a perfectly static amplitude sounds synthetic
    this.wander += (Math.random() - 0.5) * 0.06 * dt * 30;
    this.wander += (1 - this.wander) * dt * 2.5;
    this.wander = clamp(this.wander, 0.93, 1.07);

    // overrun afterfire transients
    if (c.crackle > 0 && effThr < 0.05 && this.rpm > c.idleRpm * 2) {
      if (Math.random() < c.crackle * dt * 6) this.spawnPop();
    }
    // limiter afterfire: unburnt fuel banging in the pipe during cut phases
    if (this.limiterOn && Math.random() < (4 + c.crackle * 10) * dt) this.spawnPop();
  }

  // afterfire = a small explosion in the exhaust pipe. Impulsive: near-instant
  // attack (~1.5 ms) + exponential decay, a low "whump" whose pitch drops fast
  // as the pressure wave expands, plus a short noise burst. The previous
  // version used a symmetric sin^2 swell of filtered noise, which sounds like
  // "pfff" (air leak), not a pop.
  spawnPop() {
    if (this.pops.length > 8) this.pops.shift();
    this.pops.push({
      t: 0,
      dur: 0.05 + Math.random() * 0.05,    // total lifetime 50-100 ms
      tau: 0.010 + Math.random() * 0.018,  // decay time constant
      f: 55 + Math.random() * 50,          // thump fundamental (Hz)
      ph: Math.random() * TWO_PI,
      amp: this.cfg.pulseAmp * (0.4 + Math.random() * 0.4),
      bank: (Math.random() * this.bankCombs.length) | 0,
      lp: 0,
    });
  }

  // Sample per-cycle combustion parameters. Called only when a cylinder's
  // pulse window restarts (envelope == 0), so parameter jumps never click.
  newCycle(cyl) {
    const c = this.cfg;
    if (!this.controls.ignition) { cyl.amp = 0; return; }
    const L = this.audioLoad;
    const D = this.audioDecel;
    // loudness depends on BOTH load and rpm: a closed-throttle engine at high
    // rpm still moves a lot of exhaust gas — load alone made lift-off
    // collapse by ~20 dB, which sounds like the engine being switched off
    const rpmN = clamp(this.audioRpm / c.redline, 0, 1);
    // During DFCO the cylinders still pump air, but combustion itself stops.
    // Keep that airflow in the resonators below instead of leaving a quiet
    // pitched combustion train running under closed throttle.
    const combustionGate = Math.pow(1 - D, 1.35);
    let amp = (0.13 + 0.24 * rpmN + 0.63 * L) * combustionGate * cyl.trim * this.wander;
    // small per-cycle combustion variation. Kept SMALL on purpose: at high rpm
    // per-cycle randomness becomes >100 Hz amplitude modulation, which reads
    // as granular/robotic. Slow variation comes from `wander` instead.
    const idleFactor = this.audioRpm < c.idleRpm * 1.6 ? 1.8 : 1;
    const sigma = (0.025 + 0.045 * (1 - L)) * idleFactor;
    amp *= 1 + sigma * (Math.random() * 2 - 1);
    const idleLump = c.camLope * clamp(1 - Math.max(0, this.audioRpm - c.idleRpm) / Math.max(300, c.idleRpm * 1.2), 0, 1);
    amp *= 1 + idleLump * (
      0.14 * Math.sin(this.time * 10.3 + cyl.bank) +
      0.08 * (hash01(cyl.angle + Math.floor(this.time * 3)) - 0.5)
    );
    const timingSigma = (0.035 + 0.18 * (1 - L) + 0.22 * idleLump) *
      (1 + c.camLope * 1.4) * (1 - 0.55 * rpmN);
    cyl.microJitter = clamp(cyl.microJitter * 0.35 + timingSigma * (Math.random() * 2 - 1), -1.4, 1.4);
    // overrun burble: event-RATE-based (constant events/second), not
    // per-cycle probability — per-cycle chance made the burble rate scale
    // with rpm into harsh machine-gun territory
    if ((L < 0.06 || D > 0.15) && this.audioRpm > c.idleRpm * 1.7) {
      const cycleTime = 120 / Math.max(300, this.audioRpm); // s per 720deg cycle
      const eventsPerSec = (4 + c.crackle * 12 + D * 5) / this.cyls.length;
      if (Math.random() < eventsPerSec * cycleTime) amp *= 1.4 + Math.random() * 0.6;
      else amp *= 0.6;
    }
    // rev limiter: hard cut — ALL cylinders silenced during the cut phase of
    // the ~12 Hz limiter rhythm. The classic "bah-bah-bah" comes from real
    // full-volume dips between guaranteed full-power bursts
    if (this.limiterOn) amp *= 0.08;
    else if (this.shiftCutOn) amp *= 0.35;
    cyl.amp = amp * c.pulseAmp;
    // carrier: few cycles of tone inside the pulse; more/sharper under load.
    // fixed per-cylinder trim instead of per-cycle randomness
    cyl.carrier = (2.7 + 1.6 * L + 0.35 * D) * c.carrierScale * cyl.carrierTrim;
    // downward intra-pulse pitch (thermodynamic phase modulation)
    cyl.chirp = cyl.carrier * 0.175;
  }

  process(inputs, outputs) {
    const channels = outputs[0];
    const outL = channels[0];
    const outR = channels[1] || outL;
    const c = this.cfg;
    if (!c) {
      for (const ch of channels) ch.fill(0);
      return true;
    }
    const invSr = 1 / this.sr;
    const nBanks = this.bankCombs.length;
    const pulseWindow = c.pulseWindow || DEFAULT_PULSE_WINDOW;
    const invW = 1 / pulseWindow;

    for (let i = 0; i < outL.length; i++) {
      if (this.physCounter-- <= 0) {
        this.physics(PHYS_INTERVAL * invSr);
        this.physCounter = PHYS_INTERVAL - 1;
      }
      // audio-rate smoothing of rpm & load. Falling rpm is rate-limited so
      // gear-shift snaps glide down like a real flywheel instead of jumping.
      // The fall rate is load-dependent: snappy on-power shifts, gentle
      // rev settling when coasting
      // fall rate scales with redline (an F1 engine sheds revs proportionally
      // faster) and opens up under braking so the sound tracks hard stops
      const step = this.kRpm * (this.rpm - this.audioRpm);
      const brk = clamp(this.controls.brake, 0, 1);
      const fallLim = c.redline * (0.42 + 0.7 * this.audioLoad + 1.3 * brk) * invSr;
      this.audioRpm += clamp(step, -fallLim, this.riseLim);
      this.audioLoad += this.kLoad * (this.effLoadT - this.audioLoad);
      this.audioDecel += this.kDecel * (this.decelFlowT - this.audioDecel);

      // crank advance (720 deg = one 4-stroke cycle)
      this.theta += this.audioRpm * 6 * invSr;
      if (this.theta >= 720) this.theta -= 720;
      this.mechPhase += TWO_PI * (this.audioRpm / 60) * invSr;
      if (this.mechPhase >= TWO_PI) this.mechPhase -= TWO_PI;
      const rpmNPhase = clamp(this.audioRpm / c.redline, 0, 1);
      this.orderPhase += TWO_PI * (this.audioRpm / 60) * c.mainOrder * invSr;
      if (this.orderPhase >= TWO_PI) this.orderPhase %= TWO_PI;
      if (this.gear > 0 && this.speed > 0.2) {
        const wheelHz = this.speed / (TWO_PI * c.wheelR);
        const gearMeshHz = clamp(wheelHz * c.ratios[this.gear - 1] * c.finalDrive * (12 + this.gear * 1.4), 90, 7800);
        this.gearWhinePhase += TWO_PI * gearMeshHz * invSr;
        if (this.gearWhinePhase >= TWO_PI) this.gearWhinePhase %= TWO_PI;
      }
      const turboHz = 850 + rpmNPhase * 4200 + this.turboSpool * 5200;
      this.turboPhase += TWO_PI * turboHz * invSr;
      if (this.turboPhase >= TWO_PI) this.turboPhase %= TWO_PI;
      const hybridHz = 2400 + rpmNPhase * 7000 + this.audioLoad * 900;
      this.hybridPhase += TWO_PI * hybridHz * invSr;
      if (this.hybridPhase >= TWO_PI) this.hybridPhase %= TWO_PI;

      // per-cylinder bipolar exhaust pulses (crank-angle domain)
      let exc0 = 0, exc1 = 0, envSum0 = 0, envSum1 = 0, pumpEnv0 = 0, pumpEnv1 = 0;
      let intakePulseEnv = 0;
      if (this.audioRpm > 30) {
        for (let k = 0; k < this.cyls.length; k++) {
          const cyl = this.cyls[k];
          let baseX = this.theta - cyl.angle;
          if (baseX < 0) baseX += 720;
          if (baseX < cyl.lastX) this.newCycle(cyl); // wrapped -> new combustion cycle
          cyl.lastX = baseX;
          let x = baseX - cyl.microJitter;
          if (x < 0) x += 720;
          // Intake-valve flow occurs on the opposite half of the four-stroke
          // cycle. A separate phase-locked envelope gives the induction sound
          // recognizable cylinder articulation instead of steady filtered hiss.
          let intakeX = baseX - 360 - cyl.microJitter * 0.35;
          if (intakeX < 0) intakeX += 720;
          if (intakeX < 205) {
            const iu = intakeX / 205;
            const envelopeIndex = Math.min(ENVELOPE_TABLE_SIZE, (iu * ENVELOPE_TABLE_SIZE) | 0);
            intakePulseEnv += INTAKE_ENVELOPE[envelopeIndex];
          }
          if (x < pulseWindow) {
            const u = x * invW;
            // u^0.7 attack: softer corner than sqrt -> less aliasing fizz at
            // high rpm where the pulse compresses to a few milliseconds
            const envelopeIndex = Math.min(ENVELOPE_TABLE_SIZE, (u * ENVELOPE_TABLE_SIZE) | 0);
            const env = PULSE_ENVELOPE[envelopeIndex];
            const pump = env * c.pulseAmp;
            if (cyl.bank === 0) pumpEnv0 += pump;
            else pumpEnv1 += pump;
            if (cyl.amp !== 0) {
              const s = env * cyl.amp * Math.sin(TWO_PI * (cyl.carrier * u - cyl.chirp * u * u));
              if (cyl.bank === 0) { exc0 += s; envSum0 += env * cyl.amp; }
              else { exc1 += s; envSum1 += env * cyl.amp; }
            }
          }
        }
      }

      // turbulence: exhaust flow noise following the pulse envelopes, with a
      // smoothed "bed" so the noise never hard-gates to zero between pulses
      // (hard gating at firing rate = vocoder-like buzz)
      const white = Math.random() * 2 - 1;
      this.noiseLP += 0.32 * (white - this.noiseLP);
      this.bedEnv0 += 0.004 * (envSum0 - this.bedEnv0);
      this.bedEnv1 += 0.004 * (envSum1 - this.bedEnv1);
      const noiseMix = 0.35 + 0.3 * this.audioLoad + 0.22 * this.audioDecel + 0.10 * this.loadTransient;
      exc0 += (0.7 * envSum0 + 0.5 * this.bedEnv0) * this.noiseLP * noiseMix;
      exc1 += (0.7 * envSum1 + 0.5 * this.bedEnv1) * this.noiseLP * noiseMix;
      if (this.audioDecel > 0.001) {
        const pumpShake = Math.sin(this.theta * Math.PI / 90);
        const pumpAir = 0.30 * this.noiseLP + 0.055 * pumpShake;
        exc0 += pumpEnv0 * this.audioDecel * pumpAir;
        exc1 += pumpEnv1 * this.audioDecel * pumpAir;
        const steadyAir = this.noiseLP * this.audioDecel * (0.012 + 0.028 * rpmNPhase);
        exc0 += steadyAir;
        if (nBanks > 1) exc1 += steadyAir * 0.92;
      }

      // afterfire pops (short smooth transients)
      for (let p = this.pops.length - 1; p >= 0; p--) {
        const pop = this.pops[p];
        pop.t += invSr;
        if (pop.t >= pop.dur) { this.pops[p] = this.pops[this.pops.length - 1]; this.pops.pop(); continue; }
        const attack = 1 - Math.exp(-pop.t / 0.0015); // ~1.5 ms rise
        const decay = Math.exp(-pop.t / pop.tau);
        const env = attack * decay;
        // pressure-wave pitch drop: starts ~2.5x, settles to fundamental
        const f = pop.f * (1 + 1.5 * Math.exp(-pop.t / 0.008));
        pop.ph += TWO_PI * f * invSr;
        pop.lp += 0.10 * (white - pop.lp);
        const s = env * pop.amp * (0.9 * Math.sin(pop.ph) + 1.7 * pop.lp * decay);
        if (pop.bank === 0) exc0 += s; else exc1 += s;
      }

      // exhaust: per-bank header resonator -> shared tailpipe -> formants
      const header0 = this.bankCombs[0].process(exc0);
      const header1 = nBanks > 1 ? this.bankCombs[1].process(exc1) : 0;
      let y = header0 + header1;
      const rawSide = nBanks > 1 ? (header0 - header1) * c.bankSpread * (0.045 + 0.075 * (1 - c.muffler)) : 0;
      this.sideLP += 0.45 * (rawSide - this.sideLP);
      y = this.tailComb.process(y * 0.75);
      y += this.formant1.process(y) * 0.3 + this.formant2.process(y) * 0.15;

      // drive (waveshaping) + muffler lowpass
      y = Math.tanh(y * c.drivePre) * c.drivePost;
      this.mufLP += c.mufCoef * (y - this.mufLP);
      y = this.mufLP;

      // engine-block rumble: unipolar envelope train reinforces the firing
      // fundamental & half-orders (bipolar pulses alone are zero-mean)
      const envAll = envSum0 + envSum1;
      this.rumbleLP += 0.012 * (envAll - this.rumbleLP);
      // fast 15 Hz DC blocker: a slow one lets a large DC step linger after
      // sudden load drops, biasing the tanh stage and choking the sound
      this.rumbleDC += this.kDC * (this.rumbleLP - this.rumbleDC);
      y += (this.rumbleLP - this.rumbleDC) * (0.5 + 0.5 * this.audioLoad) * 0.9;
      const rpmNBlock = clamp(this.audioRpm / c.redline, 0, 1);
      const orderTone = (
        Math.sin(this.orderPhase) +
        0.34 * Math.sin(this.orderPhase * 2 + 0.35) +
        0.16 * Math.sin(this.orderPhase * 0.5 + 1.1) * c.layoutRumble
      ) * rpmNBlock * (0.010 + 0.018 * (1 - c.muffler)) * (0.35 + 0.65 * this.audioLoad);
      this.orderLP += 0.035 * (orderTone - this.orderLP);
      y += this.orderLP;
      const mechTarget = (
        0.70 * Math.sin(this.mechPhase * 2) +
        0.35 * Math.sin(this.mechPhase * 4 + 0.4) +
        0.18 * Math.sin(this.mechPhase * 6.5 + 1.2)
      ) * rpmNBlock * c.mechanicalNoise * (0.018 + 0.030 * this.audioDecel + 0.010 * this.audioLoad);
      this.mechLP += 0.08 * (mechTarget - this.mechLP);
      y += this.mechLP;
      y += (white - this.noiseLP) * c.mechanicalNoise * rpmNBlock *
        (0.003 + 0.007 * this.audioLoad + 0.004 * this.audioDecel);
      if (this.gear > 0 && this.speed > 0.2) {
        const gearTone = Math.sin(this.gearWhinePhase) + 0.32 * Math.sin(this.gearWhinePhase * 2.01 + 0.2);
        const gearLoad = 0.20 + 0.65 * this.audioLoad + 0.95 * this.audioDecel;
        const lowerGearFocus = 1 + 0.25 * (1 - (this.gear - 1) / Math.max(1, c.numGears - 1));
        y += gearTone * c.mechanicalNoise * rpmNBlock * gearLoad * lowerGearFocus * 0.010;
      }

      // intake noise
      if (c.intakeNoise > 0 && this.audioRpm > 30) {
        this.intakeLP1 += 0.25 * (white - this.intakeLP1);
        this.intakeLP2 += 0.03 * (this.intakeLP1 - this.intakeLP2);
        const bp = this.intakeLP1 - this.intakeLP2;
        const rpmN = clamp(this.audioRpm / c.redline, 0, 1);
        const intakeNorm = intakePulseEnv / Math.sqrt(Math.max(1, c.cylinders));
        this.intakeBed += 0.0035 * (intakeNorm - this.intakeBed);
        const cycleGate = clamp(0.42 + 0.72 * intakeNorm + 0.22 * this.intakeBed, 0.25, 1.7);
        const intakeFlow = this.audioLoad * (0.12 + 0.45 * rpmN) + this.audioDecel * 0.07 * rpmN;
        const intakeTexture = 0.84 * bp + 0.16 * (white - this.noiseLP);
        y += intakeTexture * c.intakeNoise * intakeFlow * cycleGate * (1 + 0.22 * this.loadTransient);
      }

      const turboAmt = c.turboWhine * (0.15 + 0.85 * this.turboSpool) *
        (0.20 + 0.80 * Math.max(this.audioLoad, this.audioDecel * 0.45));
      if (turboAmt > 0.001) {
        const turboTone = Math.sin(this.turboPhase) + 0.25 * Math.sin(this.turboPhase * 2 + 0.3);
        const wasteAir = this.audioDecel * (white - this.noiseLP) * 0.035;
        y += turboTone * turboAmt * (0.010 + 0.030 * (1 - c.muffler)) + wasteAir * c.turboWhine;
        if (c.redline > 10000 && c.turboWhine > 0.7) {
          y += Math.sin(this.hybridPhase) * (0.004 + 0.014 * this.audioLoad) * c.turboWhine;
        }
      }
      if (this.bypassEnv > 0.0001) {
        const flutterHz = 24 + 52 * clamp(this.turboSpool, 0, 1);
        this.bypassPhase += TWO_PI * flutterHz * invSr;
        if (this.bypassPhase >= TWO_PI) this.bypassPhase %= TWO_PI;
        const flutter = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.bypassPhase));
        const bypassAir = (white - this.noiseLP) * flutter + 0.18 * Math.sin(this.turboPhase * 0.73);
        y += bypassAir * this.bypassEnv * c.turboWhine * (0.020 + 0.035 * (1 - c.muffler));
        this.bypassEnv *= Math.exp(-1 / (0.11 * this.sr));
      } else {
        this.bypassEnv = 0;
      }

      // gentle top-end rolloff (~8 kHz): removes the last of the digital fizz
      const shaped = Math.tanh(y * 1.1) * 0.9;
      this.outLP += 0.66 * (shaped - this.outLP);
      if (outR !== outL) {
        const stereoSide = this.sideLP * (0.55 + 0.45 * rpmNBlock);
        outL[i] = Math.tanh((this.outLP + stereoSide) * 1.02);
        outR[i] = Math.tanh((this.outLP - stereoSide) * 1.02);
      } else {
        outL[i] = this.outLP;
      }
    }

    for (let ch = 2; ch < channels.length; ch++) channels[ch].set(outL);

    this.reportCounter += outL.length;
    if (this.reportCounter >= this.sr / 20) {
      this.reportCounter = 0;
      this.port.postMessage({
        type: 'state',
        rpm: this.audioRpm, // what you hear is what the gauge shows
        speedKmh: this.speed * 3.6,
        gear: this.gear,
        throttle: this.effThr,
        limiter: this.limiterOn,
        mode: this.controls.mode,
        decel: this.audioDecel,
      });
    }
    return true;
  }
}

registerProcessor('engine-processor', EngineProcessor);
