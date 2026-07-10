#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const RUNS = 3;
const ROUNDS = 7;
const MIN_SAMPLE_MS = 100;
const MIN_WARMUP_MS = 1000;
const CALIBRATION_TARGET_MS = 1000;
const MAX_CV = 0.1;
const MIN_HEAD_BASE_RATIO = 0.85;
const SCHEMA_VERSION = 2;

const resultsDirectory = process.argv[2];
if (!resultsDirectory || process.argv.length !== 3) {
  throw new Error('usage: compare-frontend-benchmarks.mjs <results-directory>');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function coefficientOfVariation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function requireFinitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite and greater than zero`);
  }
}

async function loadRun(side, run) {
  const path = resolve(resultsDirectory, `${side}-${run}.json`);
  let result;
  try {
    result = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`missing or invalid benchmark result ${path}`, { cause: error });
  }

  if (
    result.schemaVersion !== SCHEMA_VERSION ||
    result.rounds !== ROUNDS ||
    result.minSampleMs !== MIN_SAMPLE_MS ||
    result.minWarmupMs !== MIN_WARMUP_MS ||
    result.calibrationTargetMs !== CALIBRATION_TARGET_MS ||
    result.maxCv !== MAX_CV ||
    !result.cases ||
    typeof result.cases !== 'object' ||
    Array.isArray(result.cases)
  ) {
    throw new Error(`${path} does not match the benchmark result contract`);
  }

  for (const [name, benchmark] of Object.entries(result.cases)) {
    if (benchmark.name !== name || !Number.isSafeInteger(benchmark.iterations)) {
      throw new Error(`${path}: malformed case ${name}`);
    }
    requireFinitePositive(benchmark.iterations, `${path}: ${name} iterations`);
    requireFinitePositive(benchmark.opsPerSec, `${path}: ${name} median throughput`);
    requireFinitePositive(benchmark.ms, `${path}: ${name} median duration`);
    if (!Array.isArray(benchmark.samples) || benchmark.samples.length !== ROUNDS) {
      throw new Error(`${path}: ${name} must contain exactly ${ROUNDS} rounds`);
    }
    const throughputs = benchmark.samples.map((sample, index) => {
      requireFinitePositive(sample?.opsPerSec, `${path}: ${name} round ${index + 1} throughput`);
      requireFinitePositive(sample?.ms, `${path}: ${name} round ${index + 1} duration`);
      if (sample.ms < MIN_SAMPLE_MS) {
        throw new Error(
          `${path}: ${name} round ${index + 1} measured ${sample.ms.toFixed(1)} ms; minimum is ${MIN_SAMPLE_MS} ms`,
        );
      }
      return sample.opsPerSec;
    });
    const cv = coefficientOfVariation(throughputs);
    if (!Number.isFinite(benchmark.cv) || Math.abs(benchmark.cv - cv) > 1e-12) {
      throw new Error(`${path}: ${name} reports an invalid coefficient of variation`);
    }
    if (cv > MAX_CV) {
      throw new Error(`${path}: ${name} CV ${(cv * 100).toFixed(2)}% exceeds 10%`);
    }
  }
  return result.cases;
}

const baseRuns = [];
const headRuns = [];
for (let run = 1; run <= RUNS; run += 1) {
  baseRuns.push(await loadRun('base', run));
  headRuns.push(await loadRun('head', run));
}

const caseNames = Object.keys(baseRuns[0]).sort();
if (caseNames.length === 0) throw new Error('benchmark produced zero cases');
const expectedNames = JSON.stringify(caseNames);
for (const [side, runs] of [
  ['base', baseRuns],
  ['head', headRuns],
]) {
  runs.forEach((run, index) => {
    if (JSON.stringify(Object.keys(run).sort()) !== expectedNames) {
      throw new Error(`${side}-${index + 1} benchmark case set differs from base-1`);
    }
  });
}

const regressions = [];
for (const name of caseNames) {
  const baseSamples = baseRuns.flatMap((run) =>
    run[name].samples.map((sample) => sample.opsPerSec),
  );
  const headSamples = headRuns.flatMap((run) =>
    run[name].samples.map((sample) => sample.opsPerSec),
  );
  // `loadRun` has already rejected a CV above 10% for every independent
  // seven-round process. Do not pool raw rates from separate processes here:
  // their CPU frequency/thermal state is deliberately independent, and a
  // pooled CV would turn that host-level difference into a false sample-CV
  // failure. Keep it visible as a diagnostic while the contract stays strict
  // at the required 3 x 7 measurement granularity.
  const baseAcrossProcessCv = coefficientOfVariation(baseSamples);
  const headAcrossProcessCv = coefficientOfVariation(headSamples);
  const baseRunCvs = baseRuns.map((run) => run[name].cv);
  const headRunCvs = headRuns.map((run) => run[name].cv);

  const baseMedian = median(baseSamples);
  const headMedian = median(headSamples);
  requireFinitePositive(baseMedian, `${name} base median`);
  requireFinitePositive(headMedian, `${name} head median`);
  const ratio = headMedian / baseMedian;
  process.stdout.write(
    `${name}: base=${baseMedian.toFixed(2)} head=${headMedian.toFixed(2)} ratio=${ratio.toFixed(4)} ` +
      `run-cv=${baseRunCvs.map((cv) => `${(cv * 100).toFixed(2)}%`).join(',')}/` +
      `${headRunCvs.map((cv) => `${(cv * 100).toFixed(2)}%`).join(',')} ` +
      `across-process-cv=${(baseAcrossProcessCv * 100).toFixed(2)}%/${(headAcrossProcessCv * 100).toFixed(2)}%\n`,
  );
  if (ratio < MIN_HEAD_BASE_RATIO) regressions.push(`${name} (${(ratio * 100).toFixed(2)}%)`);
}

if (regressions.length > 0) {
  throw new Error(`frontend benchmark regression below 85%: ${regressions.join(', ')}`);
}
