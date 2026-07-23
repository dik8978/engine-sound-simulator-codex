// Engine Sound Simulator - UI / control / OSC routing

const $ = (id) => document.getElementById(id);

// ---------------- config schema & presets ----------------
const DEFAULT_CONFIG = {
  displacement: 2.0, cylinders: 4, layout: 'inline', firingUnevenness: 0,
  idleRpm: 850, redline: 7200,
  maxTorque: 200, peakTorqueRpm: 4200, maxSpeedKmh: 220, vehicleMass: 1300,
  maxBrakeG: 0.9,
  numGears: 6, engineInertia: 0.18, engineBrake: 1.0, transmission: 'auto',
  pipeLength: 2.5, muffler: 0.55, drive: 0.35, intakeNoise: 0.35, crackle: 0.25,
  turboWhine: 0, mechanicalNoise: 0.35, camLope: 0.05,
  eqLow: 0, eqLowMid: 0, eqPresence: 0, eqHigh: 0,
};

const CONFIG_SCHEMA = [
  { section: 'エンジン基本', items: [
    { key: 'displacement', label: '排気量 (L)', min: 0.05, max: 9, step: 0.05 },
    { key: 'cylinders', label: '気筒数', min: 1, max: 16, step: 1 },
    { key: 'layout', label: 'エンジン形式', type: 'select', options: [
      ['inline', '直列'], ['v60', 'V型 60°'], ['v90', 'V型 90°'],
      ['flat', '水平対向'], ['crossplane', 'V8 クロスプレーン'], ['vtwin', 'Vツイン (不等間隔)'],
    ]},
    { key: 'firingUnevenness', label: '点火間隔の不等度', min: 0, max: 1, step: 0.01 },
    { key: 'idleRpm', label: 'アイドル回転数 (rpm)', min: 400, max: 5000, step: 50 },
    { key: 'redline', label: 'レブリミット (rpm)', min: 3000, max: 20000, step: 50 },
  ]},
  { section: '性能・車両', items: [
    { key: 'maxTorque', label: '最大トルク (Nm)', min: 20, max: 1200, step: 5 },
    { key: 'peakTorqueRpm', label: '最大トルク回転数 (rpm)', min: 1000, max: 14000, step: 50 },
    { key: 'maxSpeedKmh', label: '最高速度 (km/h)', min: 60, max: 450, step: 5 },
    { key: 'vehicleMass', label: '車両重量 (kg)', min: 100, max: 3500, step: 5 },
    { key: 'maxBrakeG', label: 'ブレーキ最大減速G', min: 0.3, max: 6, step: 0.1 },
    { key: 'numGears', label: 'ギア段数', min: 1, max: 9, step: 1 },
    { key: 'transmission', label: 'トランスミッション', type: 'select', options: [
      ['auto', 'オートマチック'], ['manual', 'マニュアル'],
    ]},
    { key: 'engineInertia', label: 'エンジン慣性 (kg·m²)', min: 0.03, max: 1.5, step: 0.01 },
    { key: 'engineBrake', label: 'エンジンブレーキ強さ', min: 0, max: 3, step: 0.05 },
  ]},
  { section: '排気・サウンド', items: [
    { key: 'pipeLength', label: '排気管長 (m)', min: 0.4, max: 6, step: 0.05 },
    { key: 'muffler', label: 'マフラー消音度', min: 0, max: 1, step: 0.01 },
    { key: 'drive', label: '歪み / 荒々しさ', min: 0, max: 1, step: 0.01 },
    { key: 'intakeNoise', label: '吸気ノイズ', min: 0, max: 1, step: 0.01 },
    { key: 'crackle', label: 'アフターファイア (減速時)', min: 0, max: 1, step: 0.01 },
    { key: 'turboWhine', label: 'ターボ / 電動ホイーン', min: 0, max: 1, step: 0.01 },
    { key: 'mechanicalNoise', label: 'メカノイズ / ギア鳴り', min: 0, max: 1, step: 0.01 },
    { key: 'camLope', label: 'アイドル不整脈', min: 0, max: 1, step: 0.01 },
  ]},
  { section: '最終EQ', items: [
    { key: 'eqLow', label: 'Low Shelf 120Hz (dB)', min: -12, max: 12, step: 0.5 },
    { key: 'eqLowMid', label: 'Low-Mid 420Hz (dB)', min: -12, max: 12, step: 0.5 },
    { key: 'eqPresence', label: 'Presence 2.4kHz (dB)', min: -12, max: 12, step: 0.5 },
    { key: 'eqHigh', label: 'High Shelf 6.5kHz (dB)', min: -12, max: 12, step: 0.5 },
  ]},
];

const CONFIG_BY_KEY = new Map(CONFIG_SCHEMA.flatMap((sec) => sec.items.map((item) => [item.key, item])));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalServerPage() {
  return !!location.host && LOCAL_HOSTNAMES.has(location.hostname);
}

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function finiteDirectNumber(v) {
  const text = String(v).trim();
  if (!text || text === '-' || text === '.' || text === '-.') return null;
  return finiteNumber(text);
}

function sanitizeConfigValue(key, value, fallback = DEFAULT_CONFIG[key]) {
  const item = CONFIG_BY_KEY.get(key);
  if (!item) return undefined;
  if (item.type === 'select') {
    return item.options.some(([v]) => v === value) ? value : fallback;
  }
  const n = finiteNumber(value);
  if (n == null) return fallback;
  const clamped = clamp(n, item.min, item.max);
  return item.step === 1 ? Math.round(clamped) : clamped;
}

function sanitizeConfig(src) {
  const next = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    next[key] = sanitizeConfigValue(key, src?.[key], DEFAULT_CONFIG[key]);
  }
  next.redline = Math.max(next.redline, next.idleRpm + 500);
  next.peakTorqueRpm = clamp(next.peakTorqueRpm, 1000, next.redline - 200);
  return next;
}

const PRESETS = {
  '2026 F1 1.6L V6 Hybrid': {
    displacement: 1.6, cylinders: 6, layout: 'v90', firingUnevenness: 0,
    idleRpm: 4200, redline: 12500,
    maxTorque: 690, peakTorqueRpm: 7800, maxSpeedKmh: 355, vehicleMass: 780,
    maxBrakeG: 4.5,
    numGears: 8, transmission: 'manual', engineInertia: 0.035, engineBrake: 0.9,
    pipeLength: 0.85, muffler: 0.02, drive: 0.72, intakeNoise: 0.62, crackle: 0.08,
    turboWhine: 0.95, mechanicalNoise: 0.78, camLope: 0.12,
  },
  'Mazda Roadster RF 2.0 NA': {
    displacement: 2.0, cylinders: 4, layout: 'inline', firingUnevenness: 0.03,
    idleRpm: 850, redline: 7500,
    maxTorque: 205, peakTorqueRpm: 4600, maxSpeedKmh: 220, vehicleMass: 1130,
    numGears: 6, engineInertia: 0.13, engineBrake: 1.05,
    pipeLength: 2.6, muffler: 0.50, drive: 0.34, intakeNoise: 0.46, crackle: 0.18,
    turboWhine: 0, mechanicalNoise: 0.42, camLope: 0.08,
  },
  'Corvette C8 6.2L V8': {
    displacement: 6.2, cylinders: 8, layout: 'crossplane', idleRpm: 700, redline: 6600,
    maxTorque: 640, peakTorqueRpm: 5150, maxSpeedKmh: 312, vehicleMass: 1650,
    numGears: 8, engineInertia: 0.34, engineBrake: 1.2,
    pipeLength: 3.0, muffler: 0.16, drive: 0.62, intakeNoise: 0.42, crackle: 0.50,
    turboWhine: 0, mechanicalNoise: 0.36, camLope: 0.28,
  },
  'BMW M3 G80 3.0L I6 Turbo': {
    displacement: 3.0, cylinders: 6, layout: 'inline', idleRpm: 780, redline: 7200,
    maxTorque: 650, peakTorqueRpm: 3600, maxSpeedKmh: 290, vehicleMass: 1740,
    numGears: 8, engineInertia: 0.16, engineBrake: 0.95,
    pipeLength: 2.4, muffler: 0.36, drive: 0.46, intakeNoise: 0.45, crackle: 0.42,
    turboWhine: 0.48, mechanicalNoise: 0.42, camLope: 0.06,
  },
  'Porsche 911 GT3 4.0 Flat-6': {
    displacement: 4.0, cylinders: 6, layout: 'flat', idleRpm: 900, redline: 9000,
    maxTorque: 470, peakTorqueRpm: 6100, maxSpeedKmh: 318, vehicleMass: 1435,
    numGears: 7, engineInertia: 0.12, engineBrake: 1.1,
    pipeLength: 1.7, muffler: 0.24, drive: 0.48, intakeNoise: 0.58, crackle: 0.34,
    turboWhine: 0, mechanicalNoise: 0.70, camLope: 0.12,
  },
  'Lamborghini Aventador 6.5L V12': {
    displacement: 6.5, cylinders: 12, layout: 'v60', idleRpm: 900, redline: 9250,
    maxTorque: 720, peakTorqueRpm: 6750, maxSpeedKmh: 350, vehicleMass: 1575,
    numGears: 7, engineInertia: 0.2, engineBrake: 1.15,
    pipeLength: 1.45, muffler: 0.18, drive: 0.57, intakeNoise: 0.56, crackle: 0.38,
    turboWhine: 0, mechanicalNoise: 0.58, camLope: 0.08,
  },
  'Harley Sportster 1.2L V-Twin': {
    displacement: 1.2, cylinders: 2, layout: 'vtwin', idleRpm: 1000, redline: 6200,
    maxTorque: 105, peakTorqueRpm: 3800, maxSpeedKmh: 180, vehicleMass: 280,
    numGears: 6, engineInertia: 0.08, engineBrake: 1.35,
    pipeLength: 1.45, muffler: 0.12, drive: 0.68, intakeNoise: 0.25, crackle: 0.28,
    turboWhine: 0, mechanicalNoise: 0.32, camLope: 0.62,
  },
  'Toyota GR Corolla 1.6L I3 Turbo': {
    displacement: 1.6, cylinders: 3, layout: 'inline', firingUnevenness: 0.08,
    idleRpm: 950, redline: 7200,
    maxTorque: 370, peakTorqueRpm: 3600, maxSpeedKmh: 230, vehicleMass: 1475,
    numGears: 6, engineInertia: 0.09, engineBrake: 1.0,
    pipeLength: 2.0, muffler: 0.38, drive: 0.50, intakeNoise: 0.52, crackle: 0.36,
    turboWhine: 0.56, mechanicalNoise: 0.48, camLope: 0.12,
  },
  'F1風 V10 3.0L': {
    displacement: 3.0, cylinders: 10, layout: 'v90', idleRpm: 2000, redline: 18000,
    maxTorque: 360, peakTorqueRpm: 14000, maxSpeedKmh: 340, vehicleMass: 600,
    numGears: 7, engineInertia: 0.05, pipeLength: 0.9, muffler: 0.02, drive: 0.7, crackle: 0.5, intakeNoise: 0.6,
    turboWhine: 0, mechanicalNoise: 0.85, camLope: 0.05,
  },
};

const DEFAULT_PRESET_NAME = 'Lamborghini Aventador 6.5L V12';

// startup default: Lamborghini V12. F1 remains available from the preset list.
let config = sanitizeConfig({ ...DEFAULT_CONFIG, ...PRESETS[DEFAULT_PRESET_NAME] });

// ---------------- audio ----------------
let audioCtx = null;
let engineNode = null;
let gainNode = null;
let eqNodes = null;
let outputStreamDest = null;
let outputAudio = null;
let outputRouting = 'context';
let audioOutputDeviceId = 'default';

function setFilterParam(param, value, timeConstant = 0.03) {
  if (!audioCtx) {
    param.value = value;
    return;
  }
  param.setTargetAtTime(value, audioCtx.currentTime, timeConstant);
}

function createEqNodes(ctx) {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  const lowMid = ctx.createBiquadFilter();
  lowMid.type = 'peaking';
  lowMid.frequency.value = 420;
  lowMid.Q.value = 0.9;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2400;
  presence.Q.value = 0.85;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 6500;
  return { low, lowMid, presence, high };
}

function applyOutputEq() {
  if (!eqNodes) return;
  setFilterParam(eqNodes.low.gain, config.eqLow);
  setFilterParam(eqNodes.lowMid.gain, config.eqLowMid);
  setFilterParam(eqNodes.presence.gain, config.eqPresence);
  setFilterParam(eqNodes.high.gain, config.eqHigh);
}

function setAudioOutputStatus(text, active = false) {
  const el = $('audioOutputStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('active', active);
}

function audioOutputLabel(deviceId = audioOutputDeviceId) {
  const sel = $('audioOutput');
  const option = sel ? [...sel.options].find((item) => item.value === deviceId) : null;
  return option?.textContent || (deviceId === 'default' ? 'Default' : 'Selected');
}

async function applyReferenceAudioSink(sinkId) {
  const referenceAudio = $('referenceAudio');
  if (!referenceAudio || typeof referenceAudio.setSinkId !== 'function') return;
  try {
    await referenceAudio.setSinkId(sinkId);
  } catch {
    // The synthesized engine output remains active even if preview routing is unavailable.
  }
}

function connectAudioToOutput(useElementSink = false) {
  if (!audioCtx || !gainNode) return;
  try { gainNode.disconnect(); } catch {}
  if (useElementSink) {
    if (!outputStreamDest) outputStreamDest = audioCtx.createMediaStreamDestination();
    if (!outputAudio) {
      outputAudio = new Audio();
      outputAudio.autoplay = true;
      outputAudio.playsInline = true;
      outputAudio.srcObject = outputStreamDest.stream;
      outputAudio.style.display = 'none';
      document.body.appendChild(outputAudio);
    }
    gainNode.connect(outputStreamDest);
    outputRouting = 'element';
  } else {
    gainNode.connect(audioCtx.destination);
    outputRouting = 'context';
  }
}

async function applyAudioOutput(deviceId = audioOutputDeviceId) {
  audioOutputDeviceId = deviceId || 'default';
  const sinkId = audioOutputDeviceId === 'default' ? '' : audioOutputDeviceId;
  const label = audioOutputLabel(audioOutputDeviceId);
  if (!audioCtx) {
    setAudioOutputStatus(`${label} / 音開始後`);
    return;
  }
  const canSetContextSink = typeof audioCtx.setSinkId === 'function';
  const canSetElementSink = 'setSinkId' in HTMLMediaElement.prototype;
  try {
    if (canSetContextSink) {
      connectAudioToOutput(false);
      await audioCtx.setSinkId(sinkId);
    } else if (canSetElementSink && sinkId) {
      connectAudioToOutput(true);
      await outputAudio.setSinkId(sinkId);
      await outputAudio.play();
    } else {
      connectAudioToOutput(false);
      if (sinkId) throw new Error('Audio output selection is not supported by this browser.');
    }
    await applyReferenceAudioSink(sinkId);
    setAudioOutputStatus(label, audioOutputDeviceId !== 'default');
  } catch (err) {
    setAudioOutputStatus('出力先変更失敗');
    $('oscLog').textContent = `音声出力先の変更に失敗: ${err.message || err}`;
  }
}

async function refreshAudioOutputs(selectedId = audioOutputDeviceId) {
  const sel = $('audioOutput');
  sel.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = 'default';
  defaultOption.textContent = 'Default';
  sel.appendChild(defaultOption);
  const canEnumerate = !!navigator.mediaDevices?.enumerateDevices;
  const canSetSink = typeof AudioContext.prototype.setSinkId === 'function' || 'setSinkId' in HTMLMediaElement.prototype;
  if (!canEnumerate || !canSetSink || !window.isSecureContext) {
    sel.disabled = true;
    $('audioOutputRefreshBtn').disabled = true;
    setAudioOutputStatus(canSetSink ? 'HTTPSのみ' : '未対応');
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((device) => device.kind === 'audiooutput' && device.deviceId !== 'default');
    outputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Audio Output ${index + 1}`;
      sel.appendChild(option);
    });
    sel.disabled = false;
    $('audioOutputRefreshBtn').disabled = false;
    const found = [...sel.options].some((option) => option.value === selectedId);
    sel.value = found ? selectedId : 'default';
    audioOutputDeviceId = sel.value;
    setAudioOutputStatus(audioOutputLabel(sel.value), sel.value !== 'default');
  } catch (err) {
    sel.disabled = true;
    setAudioOutputStatus('取得失敗');
    $('oscLog').textContent = `音声出力先の取得に失敗: ${err.message || err}`;
  }
}

async function chooseAudioOutput() {
  const canPrompt = !!navigator.mediaDevices?.selectAudioOutput;
  try {
    if (canPrompt) {
      const device = await navigator.mediaDevices.selectAudioOutput();
      await refreshAudioOutputs(device.deviceId);
      const hasOption = [...$('audioOutput').options].some((option) => option.value === device.deviceId);
      if (!hasOption) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || 'Selected Output';
        $('audioOutput').appendChild(option);
      }
      $('audioOutput').value = device.deviceId;
      await applyAudioOutput(device.deviceId);
    } else {
      await refreshAudioOutputs(audioOutputDeviceId);
      await applyAudioOutput($('audioOutput').value);
    }
  } catch (err) {
    setAudioOutputStatus('選択キャンセル');
  }
}

function configurePlaybackAudioSession() {
  const session = navigator.audioSession;
  if (!session || !('type' in session)) return false;
  try {
    session.type = 'playback';
    return session.type === 'playback';
  } catch {
    return false;
  }
}

function waitForAudioAttempt(promise, timeoutMs = 750) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function resumeAudioPlayback() {
  configurePlaybackAudioSession();
  if (!audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') await waitForAudioAttempt(audioCtx.resume());
    if (outputRouting === 'element' && outputAudio?.paused) await waitForAudioAttempt(outputAudio.play());
  } catch {
    // A later user gesture will retry through the pointer handler.
  }
}

async function startAudio() {
  configurePlaybackAudioSession();
  if (audioCtx) {
    await resumeAudioPlayback();
    return;
  }
  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  await audioCtx.audioWorklet.addModule('engine-worklet.js');
  engineNode = new AudioWorkletNode(audioCtx, 'engine-processor', { outputChannelCount: [2] });
  eqNodes = createEqNodes(audioCtx);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = $('volume').value / 100;
  engineNode
    .connect(eqNodes.low)
    .connect(eqNodes.lowMid)
    .connect(eqNodes.presence)
    .connect(eqNodes.high)
    .connect(gainNode);
  connectAudioToOutput(false);
  engineNode.port.onmessage = (e) => onWorkletMessage(e.data);
  applyOutputEq();
  await applyAudioOutput(audioOutputDeviceId);
  await resumeAudioPlayback();
  sendConfig();
  sendControls();
}

function sendConfig() {
  config = sanitizeConfig(config);
  applyOutputEq();
  if (engineNode) engineNode.port.postMessage({ type: 'config', config });
}
function sendCommand(cmd) {
  if (engineNode) engineNode.port.postMessage({ type: 'command', cmd });
}

// ---------------- control state ----------------
// throttle/brake take the max of UI slider, keyboard ramp, and the selected external input
const ctl = {
  sliderThrottle: 0, sliderBrake: 0,
  keyThrottle: 0, keyBrake: 0,
  oscThrottle: 0, oscBrake: 0,
  midiThrottle: 0, midiBrake: 0,
  externalSource: isLocalServerPage() ? 'osc' : 'midi',
  ignition: true,
  mode: 'sim',
  extRpm: 1000, extLoad: null,
};
const keys = { throttle: false, brake: false };
let lastSent = '';

function getExternalPedals() {
  if (ctl.externalSource === 'midi') {
    return { throttle: ctl.midiThrottle, brake: ctl.midiBrake };
  }
  return { throttle: ctl.oscThrottle, brake: ctl.oscBrake };
}

function getEffectivePedals() {
  const external = getExternalPedals();
  return {
    throttle: Math.max(ctl.sliderThrottle, ctl.keyThrottle, external.throttle),
    brake: Math.max(ctl.sliderBrake, ctl.keyBrake, external.brake),
  };
}

function sendControls() {
  if (!engineNode) return;
  const pedals = getEffectivePedals();
  const controls = {
    throttle: pedals.throttle,
    brake: pedals.brake,
    ignition: ctl.ignition,
    mode: ctl.mode,
    extRpm: ctl.extRpm,
    extLoad: ctl.extLoad,
  };
  const s = JSON.stringify(controls);
  if (s !== lastSent) {
    engineNode.port.postMessage({ type: 'controls', controls });
    lastSent = s;
  }
}

// ---------------- worklet state / gauges ----------------
let state = { rpm: 0, speedKmh: 0, gear: 1, throttle: 0, limiter: false };

function onWorkletMessage(m) {
  if (m.type === 'state') {
    state = m;
  } else if (m.type === 'derived') {
    const ps = (m.powerKw * 1.3596).toFixed(0);
    $('derivedInfo').textContent =
      `推定最高出力: ${m.powerKw.toFixed(0)} kW (${ps} PS)\n` +
      `ギア比: ${m.ratios.join(' / ')}\nCdA(空気抵抗): ${m.CdA}`;
  }
}

const tach = $('tach');
const speedo = $('speedo');

// generic 270-degree gauge
function drawGauge(canvas, opts) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, R = W / 2 - 14;
  g.clearRect(0, 0, W, H);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const vToA = (v) => a0 + (a1 - a0) * Math.min(Math.max(v / opts.max, 0), 1);

  // arc background
  g.lineWidth = 10;
  g.strokeStyle = '#e3e8e9';
  g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
  // red zone
  if (opts.redFrom != null && opts.redFrom < opts.max) {
    g.strokeStyle = '#b8d4d0';
    g.beginPath(); g.arc(cx, cy, R, vToA(opts.redFrom), a1); g.stroke();
  }
  // value fill
  if (opts.value > 0) {
    g.strokeStyle = opts.flash ? '#a44f24' : '#0f766e';
    g.beginPath(); g.arc(cx, cy, R, a0, vToA(opts.value)); g.stroke();
  }
  // ticks & labels
  g.font = `${opts.tickFont || 13}px "SFMono-Regular", "SF Mono", monospace`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let v = 0; v <= opts.max; v += opts.step) {
    const a = vToA(v);
    const inRed = opts.redFrom != null && v >= opts.redFrom;
    const x1 = cx + Math.cos(a) * (R - 14), y1 = cy + Math.sin(a) * (R - 14);
    const x2 = cx + Math.cos(a) * (R - 22), y2 = cy + Math.sin(a) * (R - 22);
    g.strokeStyle = inRed ? '#0f766e' : '#a4adaf';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    const xl = cx + Math.cos(a) * (R - 38), yl = cy + Math.sin(a) * (R - 38);
    g.fillStyle = inRed ? '#0f766e' : '#6c777a';
    g.fillText(opts.tickLabel(v), xl, yl);
  }
  // needle
  const a = vToA(opts.value);
  g.strokeStyle = '#1d272a'; g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + Math.cos(a) * (R - 26), cy + Math.sin(a) * (R - 26));
  g.stroke();
  g.fillStyle = '#1d272a';
  g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
  // center label
  g.fillStyle = '#6c777a'; g.font = '12px "SFMono-Regular", "SF Mono", monospace';
  g.fillText(opts.label, cx, cy + R * 0.55);
}

function drawGauges() {
  drawGauge(tach, {
    value: state.rpm,
    max: Math.ceil((config.redline + 500) / 1000) * 1000,
    redFrom: config.redline,
    step: 1000,
    tickLabel: (v) => String(v / 1000),
    label: '×1000 rpm',
    flash: state.limiter,
  });
  const spdMax = Math.ceil((config.maxSpeedKmh + 10) / 20) * 20;
  drawGauge(speedo, {
    value: state.speedKmh,
    max: spdMax,
    redFrom: config.maxSpeedKmh,
    step: spdMax > 300 ? 40 : 20,
    tickLabel: (v) => String(v),
    label: 'km/h',
    tickFont: 11,
  });
}

// ---------------- main loop ----------------
let lastT = performance.now();
function loop(now) {
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  // keyboard pedal ramps
  ctl.keyThrottle = keys.throttle ? Math.min(1, ctl.keyThrottle + dt * 3.5) : Math.max(0, ctl.keyThrottle - dt * 5);
  ctl.keyBrake = keys.brake ? Math.min(1, ctl.keyBrake + dt * 4.5) : Math.max(0, ctl.keyBrake - dt * 6);
  sendControls();

  drawGauges();
  $('rpmVal').textContent = Math.round(state.rpm);
  $('speedVal').textContent = Math.round(state.speedKmh);
  $('gearVal').textContent = state.gear === 0 ? 'N' : state.gear;
  syncPedalUi();
  requestAnimationFrame(loop);
}

// ---------------- config UI ----------------
function formatConfigNumber(key, value = config[key]) {
  const item = CONFIG_BY_KEY.get(key);
  if (!item || item.type === 'select') return String(value);
  const n = finiteNumber(value);
  if (n == null) return String(value);
  const stepText = String(item.step);
  const decimals = stepText.includes('.') ? stepText.split('.')[1].length : 0;
  return decimals > 0 ? n.toFixed(Math.min(decimals, 3)).replace(/\.?0+$/, '') : String(Math.round(n));
}

function buildConfigForm() {
  const form = $('configForm');
  form.innerHTML = '';
  for (const sec of CONFIG_SCHEMA) {
    const div = document.createElement('div');
    div.className = 'cfg-section';
    const h = document.createElement('h3');
    h.textContent = sec.section;
    div.appendChild(h);
    for (const item of sec.items) {
      const row = document.createElement('div');
      row.className = 'cfg-item';
      const label = document.createElement('label');
      label.textContent = item.label;
      row.appendChild(label);
      if (item.type === 'select') {
        const sel = document.createElement('select');
        sel.dataset.key = item.key;
        for (const [v, t] of item.options) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          sel.appendChild(o);
        }
        sel.value = config[item.key];
        // live apply: hear the change immediately
        sel.addEventListener('change', () => { config[item.key] = sanitizeConfigValue(item.key, sel.value); sendConfig(); });
        row.appendChild(sel);
      } else {
        const range = document.createElement('input');
        range.type = 'range';
        range.min = item.min; range.max = item.max; range.step = item.step;
        range.value = config[item.key];
        range.dataset.key = item.key;
        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'num';
        num.min = item.min;
        num.max = item.max;
        num.step = item.step;
        num.value = formatConfigNumber(item.key);
        num.dataset.key = item.key;
        num.inputMode = item.step === 1 ? 'numeric' : 'decimal';
        num.title = 'クリックして数値を直接入力';
        const applyValue = (raw, immediate = false) => {
          const parsed = finiteDirectNumber(raw);
          config[item.key] = sanitizeConfigValue(item.key, parsed == null ? config[item.key] : parsed, config[item.key]);
          config = sanitizeConfig(config);
          refreshConfigForm();
          if (immediate) sendConfig();
          else scheduleApply();
        };
        // live apply while dragging (debounced)
        range.addEventListener('input', () => {
          applyValue(range.value);
        });
        num.addEventListener('input', () => {
          const parsed = finiteDirectNumber(num.value);
          if (parsed == null) return;
          config[item.key] = sanitizeConfigValue(item.key, parsed, config[item.key]);
          config = sanitizeConfig(config);
          range.value = config[item.key];
          scheduleApply();
        });
        num.addEventListener('change', () => applyValue(num.value, true));
        num.addEventListener('blur', () => { num.value = formatConfigNumber(item.key); });
        num.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applyValue(num.value, true);
            num.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            num.value = formatConfigNumber(item.key);
            num.blur();
          }
        });
        row.appendChild(range);
        row.appendChild(num);
      }
      div.appendChild(row);
    }
    form.appendChild(div);
  }
}

function refreshConfigForm() {
  for (const el of document.querySelectorAll('#configForm [data-key]')) {
    const k = el.dataset.key;
    el.value = el.classList.contains('num') ? formatConfigNumber(k) : config[k];
  }
}

// ---------------- reference audio analysis ----------------
const referenceState = {
  file: null,
  audioBuffer: null,
  objectUrl: '',
  result: null,
};

const REFERENCE_LAYOUT_LABELS = {
  inline: '直列',
  v60: 'V型 60°',
  v90: 'V型 90°',
  flat: '水平対向',
  crossplane: 'V8 クロスプレーン',
  vtwin: 'Vツイン',
};

function setConfigMode(mode) {
  const selected = mode === 'reference' ? 'reference' : 'adjust';
  $('configPanel').dataset.configMode = selected;
  const adjust = selected === 'adjust';
  $('engineAdjustTab').setAttribute('aria-selected', String(adjust));
  $('engineAdjustTab').tabIndex = adjust ? 0 : -1;
  $('referenceTab').setAttribute('aria-selected', String(!adjust));
  $('referenceTab').tabIndex = adjust ? -1 : 0;
  $('configForm').setAttribute('aria-hidden', String(!adjust));
  $('referencePanel').setAttribute('aria-hidden', String(adjust));
  if (!adjust && referenceState.result) requestAnimationFrame(() => drawReferenceSpectrum(referenceState.result));
}

function formatReferenceBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setReferenceStatus(message, isError = false) {
  $('referenceStatus').textContent = message;
  $('referenceStatus').classList.toggle('error', isError);
}

async function loadReferenceFile(file) {
  if (!file) return;
  const extensionOk = /\.(wav|mp3|m4a|aac|flac|ogg|oga|webm)$/i.test(file.name);
  if (!file.type.startsWith('audio/') && !extensionOk) {
    setReferenceStatus('対応する音声ファイルを選択してください', true);
    return;
  }
  if (file.size > 80 * 1024 * 1024) {
    setReferenceStatus('ファイルは80 MB以下にしてください', true);
    return;
  }

  $('referenceAnalyzeBtn').disabled = true;
  $('referenceResult').hidden = true;
  setReferenceStatus('音声を読み込み中...');
  try {
    const encoded = await file.arrayBuffer();
    const decodeContext = audioCtx || new AudioContext({ latencyHint: 'playback' });
    const decoded = await decodeContext.decodeAudioData(encoded.slice(0));
    if (decodeContext !== audioCtx) await decodeContext.close();
    if (referenceState.objectUrl) URL.revokeObjectURL(referenceState.objectUrl);
    referenceState.file = file;
    referenceState.audioBuffer = decoded;
    referenceState.objectUrl = URL.createObjectURL(file);
    referenceState.result = null;
    $('referenceAudio').src = referenceState.objectUrl;
    $('referenceAudio').hidden = false;
    $('referenceFileMeta').textContent =
      `${file.name} / ${decoded.duration.toFixed(1)} s / ${Math.round(decoded.sampleRate)} Hz / ${decoded.numberOfChannels} ch / ${formatReferenceBytes(file.size)}`;
    $('referenceAnalyzeBtn').disabled = false;
    setReferenceStatus('解析可能');
  } catch (error) {
    referenceState.file = null;
    referenceState.audioBuffer = null;
    $('referenceFileMeta').textContent = '読み込み失敗';
    setReferenceStatus(`音声を読み込めません: ${error.message || error}`, true);
  }
}

function referenceConfidenceLabel(confidence) {
  const level = confidence >= 0.72 ? '高' : confidence >= 0.48 ? '中' : '低';
  return `確度 ${level} ${Math.round(confidence * 100)}%`;
}

function drawReferenceSpectrum(result) {
  const canvas = $('referenceSpectrum');
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(280, rect.width || 340);
  const cssHeight = Math.max(112, rect.height || cssWidth / 2.6);
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssWidth * scale);
  canvas.height = Math.round(cssHeight * scale);
  const context = canvas.getContext('2d');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = '#f3f5f5';
  context.fillRect(0, 0, cssWidth, cssHeight);

  const padding = { left: 32, right: 10, top: 10, bottom: 22 };
  const width = cssWidth - padding.left - padding.right;
  const height = cssHeight - padding.top - padding.bottom;
  const spectrum = result.orderSpectrum;
  const maxOrder = spectrum.at(-1)?.order || 1;
  context.font = '9px "SF Mono", Menlo, monospace';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (const db of [-36, -24, -12, 0]) {
    const y = padding.top + (1 - (db + 48) / 48) * height;
    context.strokeStyle = db === 0 ? '#aeb8ba' : '#dde3e4';
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + width, y);
    context.stroke();
    context.fillStyle = '#697477';
    context.fillText(String(db), padding.left - 4, y);
  }
  context.textAlign = 'center';
  context.textBaseline = 'top';
  const orderStep = maxOrder > 16 ? 4 : 2;
  for (let order = orderStep; order <= maxOrder; order += orderStep) {
    const x = padding.left + order / maxOrder * width;
    context.fillStyle = '#697477';
    context.fillText(String(order), x, padding.top + height + 5);
  }

  context.strokeStyle = '#0f766e';
  context.lineWidth = 1.5;
  context.beginPath();
  spectrum.forEach((point, index) => {
    const x = padding.left + point.order / maxOrder * width;
    const y = padding.top + (1 - (point.db + 48) / 48) * height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();

  context.fillStyle = '#0f766e';
  for (let order = result.candidate.firingOrder; order <= maxOrder; order += result.candidate.firingOrder) {
    const point = spectrum.reduce((closest, item) =>
      Math.abs(item.order - order) < Math.abs(closest.order - order) ? item : closest, spectrum[0]);
    const x = padding.left + point.order / maxOrder * width;
    const y = padding.top + (1 - (point.db + 48) / 48) * height;
    context.beginPath();
    context.arc(x, y, 2.5, 0, Math.PI * 2);
    context.fill();
  }
}

function showReferenceResult(result) {
  const layout = REFERENCE_LAYOUT_LABELS[result.candidate.layout] || result.candidate.layout;
  $('referenceCandidate').textContent = `${result.candidate.cylinders}気筒相当 / ${layout}`;
  $('referenceConfidence').textContent = referenceConfidenceLabel(result.confidence);
  $('referenceOrder').textContent = result.candidate.firingOrder.toFixed(1);
  $('referenceHarmonicity').textContent = `${Math.round(result.features.harmonicity * 100)}%`;
  $('referenceBroadband').textContent = `${Math.round(result.features.broadband * 100)}%`;
  $('referenceCentroid').textContent = `${Math.round(result.features.centroidHz)} Hz`;
  $('referenceResult').hidden = false;
  drawReferenceSpectrum(result);
}

async function analyzeReferenceFile() {
  if (!referenceState.audioBuffer || !window.ReferenceEngineAnalyzer) return;
  const rpm = finiteNumber($('referenceRpm').value);
  const speedKmh = finiteNumber($('referenceSpeed').value);
  if (rpm == null || rpm < 400 || rpm > 20000) {
    setReferenceStatus('回転数は400〜20000 rpmで入力してください', true);
    $('referenceRpm').focus();
    return;
  }
  if (speedKmh == null || speedKmh < 0 || speedKmh > 450) {
    setReferenceStatus('速度は0〜450 km/hで入力してください', true);
    $('referenceSpeed').focus();
    return;
  }

  $('referenceAnalyzeBtn').disabled = true;
  setReferenceStatus('次数成分と広帯域成分を解析中...');
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    const channels = Array.from(
      { length: referenceState.audioBuffer.numberOfChannels },
      (_, channel) => referenceState.audioBuffer.getChannelData(channel),
    );
    referenceState.result = window.ReferenceEngineAnalyzer.analyze(
      channels,
      referenceState.audioBuffer.sampleRate,
      { rpm, speedKmh, currentConfig: config },
    );
    showReferenceResult(referenceState.result);
    setReferenceStatus(`解析完了 / 使用区間 ${referenceState.result.analysis.durationSeconds.toFixed(1)} s`);
  } catch (error) {
    referenceState.result = null;
    $('referenceResult').hidden = true;
    setReferenceStatus(`解析できません: ${error.message || error}`, true);
  } finally {
    $('referenceAnalyzeBtn').disabled = false;
  }
}

function markReferencePreset() {
  const select = $('preset');
  select.querySelector('option[data-reference]')?.remove();
  const option = document.createElement('option');
  option.dataset.reference = 'true';
  option.value = 'r:reference';
  option.textContent = `Reference: ${referenceState.file?.name || '推定結果'}`;
  select.appendChild(option);
  select.value = option.value;
}

function applyReferenceResult(audition = false) {
  const result = referenceState.result;
  if (!result) return;
  config = sanitizeConfig({ ...config, ...result.configPatch });
  refreshConfigForm();
  markReferencePreset();
  const presetName = (referenceState.file?.name || 'Reference').replace(/\.[^.]+$/, '').slice(0, 48);
  $('presetName').value = `${presetName} Reference`;
  sendConfig();

  if (audition) {
    ctl.extRpm = result.rpm;
    ctl.extLoad = clamp(0.38 + result.features.harmonicity * 0.48, 0, 1);
    $('extRpm').value = result.rpm;
    $('extRpmVal').textContent = String(Math.round(result.rpm));
    setMode('ext');
    sendControls();
    setReferenceStatus(`${Math.round(result.rpm)} rpmへ固定 / 操作タブで試聴中`);
  } else {
    setConfigMode('adjust');
  }
}

function setupReferenceMode() {
  setConfigMode('adjust');
  $('engineAdjustTab').addEventListener('click', () => setConfigMode('adjust'));
  $('referenceTab').addEventListener('click', () => setConfigMode('reference'));
  $('configPanel').querySelector('.config-mode-tabs').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = $('configPanel').dataset.configMode === 'adjust' ? 'reference' : 'adjust';
    setConfigMode(next);
    $(next === 'reference' ? 'referenceTab' : 'engineAdjustTab').focus();
  });

  const fileInput = $('referenceFile');
  const dropZone = $('referenceDropZone');
  fileInput.addEventListener('click', () => { fileInput.value = ''; });
  fileInput.addEventListener('change', () => { void loadReferenceFile(fileInput.files?.[0]); });
  dropZone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    fileInput.click();
  });
  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    void loadReferenceFile(event.dataTransfer.files?.[0]);
  });
  $('referenceAnalyzeBtn').addEventListener('click', () => { void analyzeReferenceFile(); });
  $('referenceApplyBtn').addEventListener('click', () => applyReferenceResult(false));
  $('referenceAuditionBtn').addEventListener('click', () => applyReferenceResult(true));
  window.addEventListener('resize', () => {
    if (referenceState.result && $('configPanel').dataset.configMode === 'reference') drawReferenceSpectrum(referenceState.result);
  });
}

// debounced live config apply
let applyTimer = null;
function scheduleApply() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(sendConfig, 120);
}

// ---------------- presets (built-in + user, persisted in localStorage) ----------------
const USER_PRESET_KEY = 'engineSimUserPresets';
function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem(USER_PRESET_KEY)) || {}; }
  catch { return {}; }
}
function refreshPresetList(selectedValue) {
  const sel = $('preset');
  sel.innerHTML = '';
  const gb = document.createElement('optgroup');
  gb.label = '内蔵プリセット';
  for (const name of Object.keys(PRESETS)) {
    const o = document.createElement('option');
    o.value = 'b:' + name; o.textContent = name;
    gb.appendChild(o);
  }
  sel.appendChild(gb);
  const users = loadUserPresets();
  const names = Object.keys(users);
  if (names.length) {
    const gu = document.createElement('optgroup');
    gu.label = 'カスタム';
    for (const name of names) {
      const o = document.createElement('option');
      o.value = 'u:' + name; o.textContent = name;
      gu.appendChild(o);
    }
    sel.appendChild(gu);
  }
  if (selectedValue) sel.value = selectedValue;
}

function buildPresets() {
  refreshPresetList(`b:${DEFAULT_PRESET_NAME}`);
  $('preset').addEventListener('change', () => {
    const v = $('preset').value;
    const src = v.startsWith('u:') ? loadUserPresets()[v.slice(2)] : PRESETS[v.slice(2)];
    if (!src) return;
    config = sanitizeConfig({ ...DEFAULT_CONFIG, ...src });
    refreshConfigForm();
    sendConfig();
  });
  $('savePresetBtn').addEventListener('click', () => {
    const name = $('presetName').value.trim();
    if (!name) { $('presetName').focus(); return; }
    const users = loadUserPresets();
    users[name] = { ...config };
    localStorage.setItem(USER_PRESET_KEY, JSON.stringify(users));
    refreshPresetList('u:' + name);
    $('presetName').value = '';
  });
  $('deletePresetBtn').addEventListener('click', () => {
    const v = $('preset').value;
    if (!v.startsWith('u:')) return;
    const users = loadUserPresets();
    delete users[v.slice(2)];
    localStorage.setItem(USER_PRESET_KEY, JSON.stringify(users));
    refreshPresetList();
  });
}

// ---------------- OSC via WebSocket ----------------
let oscMsgCount = 0;
function connectWS() {
  if (!location.host) {
    $('wsStatus').textContent = 'WS: 静的表示';
    $('oscStatus').textContent = 'OSC: ローカルサーバー起動時のみ';
    return;
  }
  if (!isLocalServerPage()) {
    $('wsStatus').textContent = 'WS: 公開版';
    $('oscStatus').textContent = 'OSC: ローカル版のみ';
    $('oscLog').textContent = '公開URLではWeb MIDI入力を使えます。OSC UDP入力はローカルで npm start を起動した時に使えます。';
    return;
  }
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${wsScheme}://${location.host}/ws`);
  ws.onopen = () => {
    $('wsStatus').textContent = 'WS: 接続中';
    $('wsStatus').classList.add('active');
  };
  ws.onclose = () => {
    $('wsStatus').textContent = 'WS: 未接続';
    $('wsStatus').classList.remove('active');
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'hello') {
      $('oscStatus').textContent = `OSC: udp/${m.oscPort} 待機中`;
    } else if (m.type === 'osc') {
      handleOsc(m.address, m.args);
      oscMsgCount++;
      $('oscStatus').textContent = `OSC: 受信中 (${oscMsgCount})`;
      $('oscStatus').classList.add('active');
      $('oscLog').textContent = `OSC受信: ${m.address} ${m.args.map(a => typeof a === 'number' ? +a.toFixed(3) : a).join(' ')}`;
      if (ctl.externalSource === 'osc') {
        sendControls(); // immediate: don't wait for the (possibly throttled) loop
        syncPedalUi();
      }
    }
  };
}

function handleOsc(address, args) {
  const a = args[0];
  const rawNum = typeof a === 'number' ? a : (a === true ? 1 : 0);
  const num = Number.isFinite(rawNum) ? rawNum : 0;
  const pedalValue = (v) => {
    if (!Number.isFinite(v)) return 0;
    if (v > 100) return clamp(v / 127, 0, 1);
    if (v > 1) return clamp(v / 100, 0, 1);
    return clamp(v, 0, 1);
  };
  switch (address) {
    case '/engine/throttle':
    case '/engine/accelerator':
    case '/engine/accel':
    case '/engine/gas':
    case '/throttle':
    case '/accelerator':
    case '/accel':
    case '/gas':
      ctl.oscThrottle = pedalValue(num);
      break;
    case '/engine/brake':
    case '/brake':
      ctl.oscBrake = pedalValue(num);
      break;
    case '/engine/pedals':
    case '/pedals':
      ctl.oscThrottle = pedalValue(num);
      ctl.oscBrake = pedalValue(typeof args[1] === 'number' ? args[1] : 0);
      break;
    case '/engine/rpm': ctl.extRpm = num; $('extRpm').value = num; $('extRpmVal').textContent = Math.round(num); break;
    case '/engine/load': ctl.extLoad = pedalValue(num); break;
    case '/engine/ignition': setIgnition(num >= 0.5); break;
    case '/engine/gear':
      if (num <= 0) sendCommand('neutral');
      else { sendCommand('neutral'); for (let i = 0; i < Math.round(num); i++) sendCommand('gearUp'); }
      break;
    case '/engine/gearup': sendCommand('gearUp'); break;
    case '/engine/geardown': sendCommand('gearDown'); break;
    case '/engine/mode': setMode((a === 'ext' || num >= 0.5) ? 'ext' : 'sim'); break;
    default:
      if (address.startsWith('/engine/config/')) {
        const key = address.slice('/engine/config/'.length);
        if (key in DEFAULT_CONFIG) {
          config[key] = sanitizeConfigValue(key, typeof a === 'string' ? a : num, config[key]);
          config = sanitizeConfig(config);
          refreshConfigForm();
          scheduleApply();
        }
      }
  }
}

// ---------------- Web MIDI ----------------
let midiAccess = null;
let activeMidiInputId = 'all';
let midiMsgCount = 0;

function setMidiStatus(text, active = false) {
  const el = $('midiStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('active', active);
}

function setExternalSource(source) {
  ctl.externalSource = source === 'midi' ? 'midi' : 'osc';
  $('externalInput').value = ctl.externalSource;
  $('externalInputStatus').textContent = ctl.externalSource === 'midi' ? 'Web MIDI' : 'OSC';
  $('midiRow').style.display = ctl.externalSource === 'midi' ? '' : 'none';
  sendControls();
  syncPedalUi();
}

function midiValue(v) {
  return clamp((Number.isFinite(v) ? v : 0) / 127, 0, 1);
}

function handleMidiMessage(e) {
  const [status, data1, data2] = e.data;
  const command = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const sourceName = e.target?.name || 'MIDI';
  midiMsgCount++;
  setMidiStatus(`MIDI: 受信中 (${midiMsgCount})`, true);
  $('oscLog').textContent = `MIDI Raw: ${sourceName} status ${status} ch${channel} data ${data1} ${data2}`;
  if (command === 0xb0) {
    const value = midiValue(data2);
    if (data1 === 1 || data1 === 11) {
      ctl.midiThrottle = value;
      $('oscLog').textContent = `MIDI受信: ${sourceName} ch${channel} CC${data1} ${data2} → アクセル`;
    } else if (data1 === 2 || data1 === 64) {
      ctl.midiBrake = value;
      $('oscLog').textContent = `MIDI受信: ${sourceName} ch${channel} CC${data1} ${data2} → ブレーキ`;
    }
  }
  sendControls();
  syncPedalUi();
}

function selectMidiInput(id) {
  if (!midiAccess) return;
  activeMidiInputId = id || 'all';
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = null;
  }
  if (activeMidiInputId === 'all') {
    for (const input of midiAccess.inputs.values()) {
      input.onmidimessage = handleMidiMessage;
    }
    setMidiStatus('MIDI: 全入力 待機中', false);
    return;
  }
  const input = midiAccess.inputs.get(activeMidiInputId);
  if (!input) {
    setMidiStatus('MIDI: 入力なし');
    return;
  }
  input.onmidimessage = handleMidiMessage;
  setMidiStatus(`MIDI: ${input.name || '入力'} 待機中`, false);
}

function refreshMidiInputs() {
  const sel = $('midiInput');
  sel.innerHTML = '';
  const inputs = midiAccess ? Array.from(midiAccess.inputs.values()) : [];
  if (!inputs.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'MIDI入力なし';
    sel.appendChild(o);
    sel.disabled = true;
    selectMidiInput('');
    return;
  }
  sel.disabled = false;
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'All MIDI Inputs';
  sel.appendChild(allOption);
  for (const input of inputs) {
    const o = document.createElement('option');
    o.value = input.id;
    o.textContent = input.name || `MIDI入力 ${sel.length + 1}`;
    sel.appendChild(o);
  }
  const hasActive = activeMidiInputId === 'all' || inputs.some((input) => input.id === activeMidiInputId);
  sel.value = hasActive ? activeMidiInputId : 'all';
  selectMidiInput(sel.value);
}

async function enableMidi() {
  setExternalSource('midi');
  if (!('requestMIDIAccess' in navigator)) {
    setMidiStatus('MIDI: 非対応');
    $('oscLog').textContent = 'このブラウザはWeb MIDIに対応していません。Chrome / Edge系で試してください。';
    return;
  }
  if (!window.isSecureContext) {
    setMidiStatus('MIDI: HTTPSのみ');
    $('oscLog').textContent = 'Web MIDIはHTTPSまたはlocalhostで有効です。';
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess.onstatechange = refreshMidiInputs;
    refreshMidiInputs();
  } catch (err) {
    setMidiStatus('MIDI: 許可なし');
    $('oscLog').textContent = `MIDI接続に失敗: ${err.message || err}`;
  }
}

// ---------------- UI wiring ----------------
function setIgnition(on) {
  ctl.ignition = on;
  const b = $('ignitionBtn');
  $('ignitionLabel').textContent = on ? 'ON' : 'OFF';
  b.setAttribute('aria-label', on ? 'エンジン ON' : 'エンジン OFF');
  b.title = on ? 'エンジンを停止' : 'エンジンを始動';
  b.classList.toggle('on', on);
  b.classList.toggle('off', !on);
  sendControls();
}

function setMode(mode) {
  ctl.mode = mode;
  $('rpmMode').value = mode;
  $('extRpmRow').style.display = mode === 'ext' ? '' : 'none';
}

function setupUI() {
  const mobileMedia = window.matchMedia('(max-width: 900px)');
  const generalSettings = $('generalSettings');
  const headerStatus = document.querySelector('.header-right');
  const header = document.querySelector('header');
  const syncAdaptiveLayout = () => {
    if (mobileMedia.matches) {
      if (generalSettings.parentElement !== $('generalPanelContent')) $('generalPanelContent').appendChild(generalSettings);
      if (headerStatus.parentElement !== $('generalStatusMount')) $('generalStatusMount').appendChild(headerStatus);
    } else {
      if (generalSettings.parentElement !== $('desktopGeneralBody')) $('desktopGeneralBody').appendChild(generalSettings);
      if (headerStatus.parentElement !== header) header.appendChild(headerStatus);
    }
  };
  syncAdaptiveLayout();
  if (typeof mobileMedia.addEventListener === 'function') mobileMedia.addEventListener('change', syncAdaptiveLayout);
  else mobileMedia.addListener(syncAdaptiveLayout);

  const mobileViews = [
    { name: 'dashboard', tab: $('dashboardTab'), panel: $('dashboard') },
    { name: 'general', tab: $('generalTab'), panel: $('generalPanel') },
    { name: 'config', tab: $('configTab'), panel: $('configPanel') },
  ];
  const setMobileView = (view) => {
    const selected = mobileViews.some((item) => item.name === view) ? view : 'dashboard';
    document.body.dataset.mobileView = selected;
    for (const item of mobileViews) {
      const active = item.name === selected;
      item.tab.setAttribute('aria-selected', String(active));
      item.tab.tabIndex = active ? 0 : -1;
    }
    if (selected === 'general') document.querySelector('.general-panel-scroll').scrollTop = 0;
    else if (selected === 'config') $('configForm').scrollTop = 0;
  };
  for (const item of mobileViews) item.tab.addEventListener('click', () => setMobileView(item.name));
  $('mobileTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = Math.max(0, mobileViews.findIndex((item) => item.name === document.body.dataset.mobileView));
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = mobileViews[(current + delta + mobileViews.length) % mobileViews.length];
    setMobileView(next.name);
    next.tab.focus();
  });
  setMobileView('dashboard');

  document.addEventListener('pointerdown', () => { void resumeAudioPlayback(); }, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void resumeAudioPlayback();
  });
  window.addEventListener('pageshow', () => { void resumeAudioPlayback(); });

  $('throttle').addEventListener('input', (e) => {
    ctl.sliderThrottle = e.target.value / 100;
    $('thrVal').textContent = `${e.target.value}%`;
    sendControls();
  });
  $('brake').addEventListener('input', (e) => {
    ctl.sliderBrake = e.target.value / 100;
    $('brkVal').textContent = `${e.target.value}%`;
    sendControls();
  });
  $('volume').addEventListener('input', (e) => {
    // setTargetAtTime avoids zipper noise while dragging
    if (gainNode) gainNode.gain.setTargetAtTime(e.target.value / 100, audioCtx.currentTime, 0.03);
  });
  $('audioOutput').addEventListener('change', (e) => applyAudioOutput(e.target.value));
  $('audioOutputRefreshBtn').addEventListener('click', chooseAudioOutput);
  $('ignitionBtn').addEventListener('click', () => setIgnition(!ctl.ignition));
  $('gearUpBtn').addEventListener('click', () => sendCommand('gearUp'));
  $('gearDownBtn').addEventListener('click', () => sendCommand('gearDown'));
  $('neutralBtn').addEventListener('click', () => sendCommand('neutral'));
  $('rpmMode').addEventListener('change', (e) => { setMode(e.target.value); sendControls(); });
  $('extRpm').addEventListener('input', (e) => {
    ctl.extRpm = parseFloat(e.target.value);
    $('extRpmVal').textContent = e.target.value;
    sendControls();
  });
  $('externalInput').addEventListener('change', (e) => setExternalSource(e.target.value));
  $('midiConnectBtn').addEventListener('click', enableMidi);
  $('midiInput').addEventListener('change', (e) => selectMidiInput(e.target.value));
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') { keys.throttle = true; e.preventDefault(); }
    else if (e.code === 'KeyS' || e.code === 'ArrowDown') { keys.brake = true; e.preventDefault(); }
    else if (e.code === 'KeyE' && !e.repeat) sendCommand('gearUp');
    else if (e.code === 'KeyQ' && !e.repeat) sendCommand('gearDown');
    else if (e.code === 'KeyN' && !e.repeat) sendCommand('neutral');
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.throttle = false;
    else if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.brake = false;
  });

  $('startBtn').addEventListener('click', async () => {
    try {
      await startAudio();
      $('startOverlay').style.display = 'none';
    } catch (err) {
      $('startOverlay').style.display = '';
      alert('オーディオの初期化に失敗しました: ' + err.message);
    }
  });
}

function syncPedalUi() {
  const pedals = getEffectivePedals();
  const throttlePct = Math.round(pedals.throttle * 100);
  const brakePct = Math.round(pedals.brake * 100);
  $('throttle').value = throttlePct;
  $('brake').value = brakePct;
  $('thrVal').textContent = `${throttlePct}%`;
  $('brkVal').textContent = `${brakePct}%`;
}

buildConfigForm();
buildPresets();
setupReferenceMode();
setupUI();
refreshAudioOutputs();
setExternalSource(ctl.externalSource);
setIgnition(ctl.ignition);
connectWS();
requestAnimationFrame(loop);
// rAF is suspended in background tabs; keep controls (incl. OSC input)
// flowing to the audio thread even when the page is hidden
setInterval(sendControls, 100);
