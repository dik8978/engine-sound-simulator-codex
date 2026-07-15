(function attachReferenceEngineAnalyzer(global) {
  'use strict';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const EPSILON = 1e-12;

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function rms(values) {
    if (!values.length) return 0;
    let energy = 0;
    for (const value of values) energy += value * value;
    return Math.sqrt(energy / values.length);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
  }

  function roundTo(value, step) {
    return Math.round(value / step) * step;
  }

  function mixAndDownsample(channels, sourceRate, maxRate = 12000) {
    if (!Array.isArray(channels) || !channels.length || !channels[0]?.length) {
      throw new Error('音声データを読み取れませんでした。');
    }
    const channelCount = channels.length;
    const sourceLength = Math.min(...channels.map((channel) => channel.length));
    const stride = Math.max(1, Math.ceil(sourceRate / maxRate));
    const outputRate = sourceRate / stride;
    const outputLength = Math.floor(sourceLength / stride);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const sourceStart = i * stride;
      let value = 0;
      for (let channel = 0; channel < channelCount; channel++) {
        let block = 0;
        for (let j = 0; j < stride; j++) block += channels[channel][sourceStart + j] || 0;
        value += block / stride;
      }
      output[i] = value / channelCount;
    }
    return { samples: output, sampleRate: outputRate };
  }

  function normalizeAndSelect(samples, sampleRate) {
    if (samples.length < sampleRate * 0.4) {
      throw new Error('0.4秒以上の音声を使用してください。');
    }
    let dc = 0;
    for (const value of samples) dc += value;
    dc /= samples.length;

    const centered = new Float32Array(samples.length);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      centered[i] = samples[i] - dc;
      peak = Math.max(peak, Math.abs(centered[i]));
    }
    if (peak < 1e-5) throw new Error('音量が小さすぎるため解析できません。');
    for (let i = 0; i < centered.length; i++) centered[i] /= peak;

    const targetLength = Math.min(centered.length, Math.round(sampleRate * 6));
    if (centered.length <= targetLength) return centered;

    const blockLength = Math.max(1, Math.round(sampleRate * 0.5));
    let strongestBlock = 0;
    let strongestEnergy = -Infinity;
    for (let start = 0; start + blockLength <= centered.length; start += blockLength) {
      let energy = 0;
      for (let i = start; i < start + blockLength; i++) energy += centered[i] * centered[i];
      if (energy > strongestEnergy) {
        strongestEnergy = energy;
        strongestBlock = start;
      }
    }
    const center = strongestBlock + blockLength * 0.5;
    const start = Math.round(clamp(center - targetLength * 0.5, 0, centered.length - targetLength));
    return centered.slice(start, start + targetLength);
  }

  function buildFrames(samples, frameSize = 4096, maxFrames = 18) {
    const size = Math.min(frameSize, samples.length);
    const hop = Math.max(1, Math.floor(size * 0.5));
    const possible = Math.max(1, Math.floor((samples.length - size) / hop) + 1);
    const count = Math.min(possible, maxFrames);
    const starts = [];
    for (let i = 0; i < count; i++) {
      const position = count === 1 ? 0 : Math.round(i * (samples.length - size) / (count - 1));
      starts.push(position);
    }
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, size - 1));
    return { size, starts, window };
  }

  function goertzelPower(samples, start, size, window, frequency, sampleRate) {
    const omega = 2 * Math.PI * frequency / sampleRate;
    const coefficient = 2 * Math.cos(omega);
    let previous = 0;
    let previous2 = 0;
    for (let i = 0; i < size; i++) {
      const current = samples[start + i] * window[i] + coefficient * previous - previous2;
      previous2 = previous;
      previous = current;
    }
    return Math.max(EPSILON, previous2 * previous2 + previous * previous - coefficient * previous * previous2);
  }

  function averagedPower(samples, frames, frequency, sampleRate) {
    if (frequency <= 0 || frequency >= sampleRate * 0.48) return EPSILON;
    let total = 0;
    for (const start of frames.starts) {
      total += goertzelPower(samples, start, frames.size, frames.window, frequency, sampleRate);
    }
    return total / frames.starts.length;
  }

  function normalizedAutocorrelation(samples, lag) {
    const roundedLag = Math.max(1, Math.round(lag));
    const stride = Math.max(1, Math.floor(samples.length / 40000));
    let cross = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = roundedLag; i < samples.length; i += stride) {
      const a = samples[i];
      const b = samples[i - roundedLag];
      cross += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    return clamp(cross / Math.sqrt(Math.max(EPSILON, energyA * energyB)), -1, 1);
  }

  function layoutFor(cylinders, roughness, unevenness) {
    if (cylinders === 2 && (roughness > 0.42 || unevenness > 0.25)) return 'vtwin';
    if (cylinders === 8 && roughness > 0.42) return 'crossplane';
    if (cylinders >= 6 && cylinders % 2 === 0) return cylinders === 8 ? 'v90' : 'v60';
    return 'inline';
  }

  function analyze(channels, sourceRate, options = {}) {
    const rpm = clamp(finite(options.rpm), 400, 20000);
    const speedKmh = clamp(finite(options.speedKmh), 0, 450);
    if (!rpm) throw new Error('基準RPMを入力してください。');

    const mixed = mixAndDownsample(channels, sourceRate);
    const samples = normalizeAndSelect(mixed.samples, mixed.sampleRate);
    const sampleRate = mixed.sampleRate;
    const crankHz = rpm / 60;
    const frames = buildFrames(samples);
    const maxOrder = Math.max(8, Math.min(24, Math.floor(sampleRate * 0.46 / crankHz * 2) / 2));
    const orderPowers = new Map();
    for (let order = 0.5; order <= maxOrder + 1e-6; order += 0.5) {
      orderPowers.set(order.toFixed(1), averagedPower(samples, frames, order * crankHz, sampleRate));
    }
    const orderPower = (order) => orderPowers.get((Math.round(order * 2) / 2).toFixed(1)) || EPSILON;
    const orderProminence = (order) => {
      const center = orderPower(order);
      const local = Math.sqrt(orderPower(order - 0.5) * orderPower(order + 0.5));
      const db = 10 * Math.log10((center + EPSILON) / (local + EPSILON));
      return clamp((db - 0.5) / 13, 0, 1);
    };

    const candidates = [];
    for (let cylinders = 1; cylinders <= 16; cylinders++) {
      const firingOrder = cylinders * 0.5;
      if (firingOrder > maxOrder) continue;
      const fundamental = orderProminence(firingOrder);
      const harmonics = [];
      for (let harmonic = 2; harmonic <= 5 && firingOrder * harmonic <= maxOrder; harmonic++) {
        harmonics.push(orderProminence(firingOrder * harmonic) / Math.sqrt(harmonic));
      }
      const harmonicScore = harmonics.length ? mean(harmonics) * 1.5 : 0;
      const lag = sampleRate / Math.max(1, firingOrder * crankHz);
      const periodicity = clamp((normalizedAutocorrelation(samples, lag) + 0.1) / 1.1, 0, 1);
      const subharmonic = firingOrder >= 1 ? orderProminence(firingOrder * 0.5) : 0;
      const score = clamp(0.56 * fundamental + 0.25 * harmonicScore + 0.19 * periodicity - 0.12 * subharmonic, 0, 1);
      candidates.push({ cylinders, firingOrder, score, fundamental, periodicity });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const runnerUp = candidates[1] || { score: 0 };

    const nyquistLimit = Math.min(5500, sampleRate * 0.45);
    const spectralBins = [];
    const binCount = 64;
    for (let i = 0; i < binCount; i++) {
      const ratio = i / (binCount - 1);
      const frequency = 35 * Math.pow(nyquistLimit / 35, ratio);
      spectralBins.push({ frequency, power: averagedPower(samples, frames, frequency, sampleRate) });
    }
    const totalSpectralPower = spectralBins.reduce((sum, bin) => sum + bin.power, 0) + EPSILON;
    const centroid = spectralBins.reduce((sum, bin) => sum + bin.frequency * bin.power, 0) / totalSpectralPower;
    const arithmeticPower = totalSpectralPower / spectralBins.length;
    const geometricPower = Math.exp(mean(spectralBins.map((bin) => Math.log(bin.power + EPSILON))));
    const flatness = clamp(geometricPower / Math.max(EPSILON, arithmeticPower), 0, 1);
    const brightness = clamp(Math.log2(Math.max(centroid, 180) / 180) / 4.8, 0, 1);

    const frameLevels = frames.starts.map((start) => {
      let energy = 0;
      let peak = 0;
      for (let i = 0; i < frames.size; i++) {
        const value = samples[start + i];
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      return { rms: Math.sqrt(energy / frames.size), peak };
    });
    const averageRms = mean(frameLevels.map((frame) => frame.rms));
    const levelVariation = clamp(rms(frameLevels.map((frame) => frame.rms - averageRms)) / Math.max(0.01, averageRms), 0, 1);
    const crestFactor = Math.max(...frameLevels.map((frame) => frame.peak)) / Math.max(0.01, averageRms);
    const transientStrength = clamp((crestFactor - 2.2) / 6, 0, 1);

    const harmonicProminences = [];
    for (let harmonic = 1; harmonic <= 6 && best.firingOrder * harmonic <= maxOrder; harmonic++) {
      harmonicProminences.push(orderProminence(best.firingOrder * harmonic));
    }
    const harmonicity = clamp(0.7 * mean(harmonicProminences) + 0.3 * best.periodicity, 0, 1);
    const halfOrderEnergy = mean([...orderPowers.entries()]
      .filter(([order]) => Number(order) % 1 !== 0)
      .map(([, power]) => power));
    const wholeOrderEnergy = mean([...orderPowers.entries()]
      .filter(([order]) => Number(order) % 1 === 0)
      .map(([, power]) => power));
    const halfOrderRatio = clamp(halfOrderEnergy / Math.max(EPSILON, wholeOrderEnergy), 0, 1);
    const roughness = clamp(0.48 * levelVariation + 0.30 * halfOrderRatio + 0.22 * transientStrength, 0, 1);
    const roadBias = clamp(speedKmh / 260, 0, 1);
    const broadband = clamp(0.58 * Math.sqrt(flatness) + 0.42 * (1 - harmonicity) - 0.16 * roadBias, 0, 1);

    let offOrderTone = 0;
    let lowResonanceFrequency = 0;
    let lowResonancePower = 0;
    for (let i = 1; i < spectralBins.length - 1; i++) {
      const bin = spectralBins[i];
      const local = Math.sqrt(spectralBins[i - 1].power * spectralBins[i + 1].power);
      const prominence = clamp(Math.log10((bin.power + EPSILON) / (local + EPSILON)) / 1.2, 0, 1);
      const order = bin.frequency / crankHz;
      const halfOrderDistance = Math.abs(order * 2 - Math.round(order * 2));
      if (bin.frequency > 700 && halfOrderDistance > 0.18) offOrderTone = Math.max(offOrderTone, prominence);
      if (bin.frequency >= 40 && bin.frequency <= 340 && bin.power > lowResonancePower) {
        lowResonancePower = bin.power;
        lowResonanceFrequency = bin.frequency;
      }
    }

    const bandLevel = (low, high) => {
      const values = spectralBins.filter((bin) => bin.frequency >= low && bin.frequency < high).map((bin) => bin.power);
      return mean(values) + EPSILON;
    };
    const bandLevels = [
      bandLevel(35, 140),
      bandLevel(140, 600),
      bandLevel(600, 2800),
      bandLevel(2800, nyquistLimit + 1),
    ];
    const bandDb = bandLevels.map((level) => 10 * Math.log10(level));
    const centerDb = mean(bandDb);
    const eq = bandDb.map((db) => clamp((db - centerDb) * 0.62, -9, 9));

    const unevenness = clamp(0.62 * halfOrderRatio + 0.38 * levelVariation, 0, 1);
    const highRevFactor = clamp((rpm - 4500) / 9000, 0, 1);
    const displacement = clamp(best.cylinders * (0.52 - 0.23 * highRevFactor), 0.1, 9);
    const estimatedRedline = rpm < 2200
      ? Math.max(5500, rpm * 2.8)
      : rpm < 6000
        ? Math.max(6500, rpm * 1.65)
        : rpm * 1.28;
    const redline = roundTo(clamp(estimatedRedline, rpm + 500, 20000), 50);
    const idleRpm = roundTo(clamp(Math.min(rpm * 0.34, 650 + brightness * 850), 450, redline - 500), 50);
    const turboWhine = clamp(offOrderTone * (0.45 + brightness * 0.65), 0, 1);
    const pipeLength = lowResonanceFrequency
      ? clamp(343 / (4 * lowResonanceFrequency), 0.4, 6)
      : clamp(3.8 - brightness * 2.8, 0.4, 6);
    const muffler = clamp(0.82 - brightness * 0.58 - harmonicity * 0.18, 0.02, 0.92);
    const drive = clamp(0.14 + roughness * 0.42 + brightness * 0.26 + harmonicity * 0.12, 0, 1);
    const intakeNoise = clamp(0.12 + brightness * 0.34 + harmonicity * 0.28, 0, 1);
    const mechanicalNoise = clamp(0.10 + broadband * 0.48 + brightness * 0.28, 0, 1);
    const crackle = clamp(0.06 + transientStrength * 0.58 + roughness * 0.18, 0, 1);
    const camLope = clamp(levelVariation * 0.62 + halfOrderRatio * 0.30, 0, 1);
    const maxTorque = roundTo(clamp(displacement * (82 + turboWhine * 58), 20, 1200), 5);
    const current = options.currentConfig || {};
    const maxSpeedKmh = roundTo(clamp(Math.max(finite(current.maxSpeedKmh, 180), speedKmh * 1.45), 60, 450), 5);

    const confidence = clamp(
      0.16 + best.score * 0.56 + Math.max(0, best.score - runnerUp.score) * 0.75
        - broadband * 0.16 - (samples.length < sampleRate * 1.2 ? 0.12 : 0),
      0.08,
      0.96,
    );

    const maxOrderPower = Math.max(...orderPowers.values());
    const orderSpectrum = [...orderPowers.entries()].map(([order, power]) => ({
      order: Number(order),
      db: clamp(10 * Math.log10((power + EPSILON) / (maxOrderPower + EPSILON)), -48, 0),
    }));

    return {
      version: 1,
      rpm,
      speedKmh,
      confidence,
      candidate: {
        cylinders: best.cylinders,
        firingOrder: best.firingOrder,
        layout: layoutFor(best.cylinders, roughness, unevenness),
      },
      features: {
        centroidHz: centroid,
        harmonicity,
        broadband,
        brightness,
        roughness,
        transientStrength,
        turboTone: turboWhine,
      },
      configPatch: {
        displacement: roundTo(displacement, 0.05),
        cylinders: best.cylinders,
        layout: layoutFor(best.cylinders, roughness, unevenness),
        firingUnevenness: roundTo(unevenness * 0.72, 0.01),
        idleRpm,
        redline,
        maxTorque,
        peakTorqueRpm: roundTo(clamp(redline * (turboWhine > 0.35 ? 0.52 : 0.68), 1000, redline - 200), 50),
        maxSpeedKmh,
        engineInertia: roundTo(clamp(displacement * 0.045 * (1 - highRevFactor * 0.48), 0.03, 1.5), 0.01),
        engineBrake: roundTo(clamp(0.72 + displacement * 0.08 + roughness * 0.35, 0, 3), 0.05),
        pipeLength: roundTo(pipeLength, 0.05),
        muffler: roundTo(muffler, 0.01),
        drive: roundTo(drive, 0.01),
        intakeNoise: roundTo(intakeNoise, 0.01),
        crackle: roundTo(crackle, 0.01),
        turboWhine: roundTo(turboWhine, 0.01),
        mechanicalNoise: roundTo(mechanicalNoise, 0.01),
        camLope: roundTo(camLope, 0.01),
        eqLow: roundTo(eq[0], 0.5),
        eqLowMid: roundTo(eq[1], 0.5),
        eqPresence: roundTo(eq[2], 0.5),
        eqHigh: roundTo(eq[3], 0.5),
      },
      orderSpectrum,
      analysis: {
        durationSeconds: samples.length / sampleRate,
        sampleRate,
        sourceDurationSeconds: channels[0].length / sourceRate,
      },
    };
  }

  global.ReferenceEngineAnalyzer = Object.freeze({ analyze });
})(typeof globalThis !== 'undefined' ? globalThis : window);
