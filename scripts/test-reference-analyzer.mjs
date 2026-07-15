import assert from 'node:assert/strict';

await import('../public/reference-analyzer.js');

function syntheticEngine(cylinders, rpm, seconds = 2.5, sampleRate = 12000) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  const firingHz = rpm / 60 * cylinders / 2;
  let noiseState = 0.1234;
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    let value = 0;
    for (let harmonic = 1; harmonic <= 7; harmonic++) {
      value += Math.sin(2 * Math.PI * firingHz * harmonic * time + harmonic * 0.17) / Math.pow(harmonic, 0.82);
    }
    noiseState = (noiseState * 3.987654 + 0.12345) % 1;
    samples[i] = value * 0.34 + (noiseState - 0.5) * 0.025;
  }
  return { samples, sampleRate };
}

for (const testCase of [
  { cylinders: 6, rpm: 6000 },
  { cylinders: 8, rpm: 4200 },
]) {
  const source = syntheticEngine(testCase.cylinders, testCase.rpm);
  const result = globalThis.ReferenceEngineAnalyzer.analyze(
    [source.samples],
    source.sampleRate,
    { rpm: testCase.rpm, speedKmh: 100, currentConfig: {} },
  );
  assert.equal(result.candidate.cylinders, testCase.cylinders);
  assert.ok(result.confidence > 0.4);
  assert.equal(result.configPatch.cylinders, testCase.cylinders);
}

console.log('Reference analyzer tests passed.');
