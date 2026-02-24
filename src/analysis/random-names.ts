import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// --- Types ---

interface ResultRecord {
  index: number;
  params: {
    model: string;
    gender: string;
    elaborate: boolean;
    seedParagraph: string;
    seedType: string;
  };
  result: { name: string };
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
}

interface NameFrequency {
  name: string;
  count: number;
  pct: number;
}

interface SliceAnalysis {
  sampleCount: number;
  uniqueNames: number;
  shannonEntropy: number;
  topNames: NameFrequency[];
}

// --- Pricing (per million tokens) ---

const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-5-20251101':     { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-6':              { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-6':            { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-5-20250929':   { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':             { input: 0.80,  output: 4.00,  cacheWrite: 1.00,  cacheRead: 0.08 },
};
const DEFAULT_PRICING = { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 };

function estimateCost(records: ResultRecord[]): number {
  let cost = 0;
  for (const r of records) {
    const p = MODEL_PRICING[r.params.model] || DEFAULT_PRICING;
    cost += (r.usage.input_tokens / 1_000_000) * p.input
          + (r.usage.output_tokens / 1_000_000) * p.output
          + ((r.usage.cache_creation_input_tokens || 0) / 1_000_000) * p.cacheWrite
          + ((r.usage.cache_read_input_tokens || 0) / 1_000_000) * p.cacheRead;
  }
  return cost;
}

// --- Utilities ---

function shannonEntropy(names: string[]): number {
  const freq = new Map<string, number>();
  for (const n of names) {
    freq.set(n, (freq.get(n) || 0) + 1);
  }
  const total = names.length;
  let h = 0;
  for (const count of freq.values()) {
    const p = count / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

function nameFrequencies(names: string[], topN: number): NameFrequency[] {
  const freq = new Map<string, number>();
  for (const n of names) {
    freq.set(n, (freq.get(n) || 0) + 1);
  }
  const total = names.length;
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name, count]) => ({ name, count, pct: round((count / total) * 100) }));
}

function analyzeSlice(records: ResultRecord[], topN: number): SliceAnalysis {
  const names = records.map(r => r.result.name);
  const unique = new Set(names);
  return {
    sampleCount: records.length,
    uniqueNames: unique.size,
    shannonEntropy: round(shannonEntropy(names)),
    topNames: nameFrequencies(names, topN),
  };
}

function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(item);
  }
  return map;
}

// --- Console formatting ---

function printHeader(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function printSubHeader(title: string) {
  console.log(`\n--- ${title} ---`);
}

function printNameTable(names: NameFrequency[], indent = '  ') {
  const maxNameLen = Math.max(...names.map(n => n.name.length), 4);
  for (const n of names) {
    console.log(`${indent}${n.name.padEnd(maxNameLen)}  ${String(n.count).padStart(5)}  (${n.pct.toFixed(1)}%)`);
  }
}

function printSliceSummary(label: string, analysis: SliceAnalysis) {
  console.log(`  ${label}: n=${analysis.sampleCount}, unique=${analysis.uniqueNames}, entropy=${analysis.shannonEntropy.toFixed(3)}`);
}

// --- Main ---

function main() {
  const outputDir = join(import.meta.dirname, '../../output/random-names');
  const files = readdirSync(outputDir).filter(f => f.endsWith('.json'));

  console.log(`Loading ${files.length} result files...`);

  const records: ResultRecord[] = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(outputDir, file), 'utf-8'));
    records.push(data);
  }

  console.log(`Loaded ${records.length} records.`);

  // ===== Overall Summary =====

  const allNames = records.map(r => r.result.name);
  const uniqueNames = new Set(allNames);
  const overall = analyzeSlice(records, 25);

  const totalInputTokens = records.reduce((s, r) => s + r.usage.input_tokens, 0);
  const totalOutputTokens = records.reduce((s, r) => s + r.usage.output_tokens, 0);
  const totalCacheWrite = records.reduce((s, r) => s + (r.usage.cache_creation_input_tokens || 0), 0);
  const totalCacheRead = records.reduce((s, r) => s + (r.usage.cache_read_input_tokens || 0), 0);

  const estimatedCost = estimateCost(records);

  printHeader('OVERALL SUMMARY');
  console.log(`  Total records:      ${records.length}`);
  console.log(`  Unique names:       ${uniqueNames.size}`);
  console.log(`  Shannon entropy:    ${overall.shannonEntropy.toFixed(3)}`);
  console.log(`  Input tokens:       ${totalInputTokens.toLocaleString()}`);
  console.log(`  Output tokens:      ${totalOutputTokens.toLocaleString()}`);
  console.log(`  Cache write tokens: ${totalCacheWrite.toLocaleString()}`);
  console.log(`  Cache read tokens:  ${totalCacheRead.toLocaleString()}`);
  console.log(`  Estimated cost:     $${estimatedCost.toFixed(2)}`);

  printSubHeader('Top 25 Names');
  printNameTable(overall.topNames);

  // Least common (names that appear only once)
  const freq = new Map<string, number>();
  for (const n of allNames) freq.set(n, (freq.get(n) || 0) + 1);
  const singletons = [...freq.entries()].filter(([, c]) => c === 1);
  console.log(`\n  Names appearing only once: ${singletons.length} (of ${uniqueNames.size} unique)`);
  console.log(`  Sample singletons: ${singletons.slice(0, 15).map(([n]) => n).join(', ')}`);

  // ===== Gender Crossover Analysis =====

  printHeader('GENDER CROSSOVER ANALYSIS');

  const maleRecords = records.filter(r => r.params.gender === 'male');
  const femaleRecords = records.filter(r => r.params.gender === 'female');

  const maleNameFreq = new Map<string, number>();
  for (const r of maleRecords) maleNameFreq.set(r.result.name, (maleNameFreq.get(r.result.name) || 0) + 1);

  const femaleNameFreq = new Map<string, number>();
  for (const r of femaleRecords) femaleNameFreq.set(r.result.name, (femaleNameFreq.get(r.result.name) || 0) + 1);

  const maleOnlyNames = [...maleNameFreq.keys()].filter(n => !femaleNameFreq.has(n));
  const femaleOnlyNames = [...femaleNameFreq.keys()].filter(n => !maleNameFreq.has(n));
  const sharedNames = [...maleNameFreq.keys()].filter(n => femaleNameFreq.has(n));

  console.log(`  Male-only names:   ${maleOnlyNames.length}`);
  console.log(`  Female-only names: ${femaleOnlyNames.length}`);
  console.log(`  Shared names:      ${sharedNames.length}`);

  // Show top names that crossed gender lines
  const crossoverDetails: { name: string; maleCount: number; femaleCount: number }[] = [];
  for (const name of sharedNames) {
    crossoverDetails.push({
      name,
      maleCount: maleNameFreq.get(name) || 0,
      femaleCount: femaleNameFreq.get(name) || 0,
    });
  }
  crossoverDetails.sort((a, b) => (b.maleCount + b.femaleCount) - (a.maleCount + a.femaleCount));

  printSubHeader('Top 25 Shared Names (appeared in both genders)');
  const maxCrossNameLen = Math.max(...crossoverDetails.slice(0, 25).map(n => n.name.length), 4);
  console.log(`  ${'Name'.padEnd(maxCrossNameLen)}  ${'Male'.padStart(6)}  ${'Female'.padStart(6)}  ${'Total'.padStart(6)}`);
  console.log(`  ${'-'.repeat(maxCrossNameLen)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}`);
  for (const c of crossoverDetails.slice(0, 25)) {
    console.log(`  ${c.name.padEnd(maxCrossNameLen)}  ${String(c.maleCount).padStart(6)}  ${String(c.femaleCount).padStart(6)}  ${String(c.maleCount + c.femaleCount).padStart(6)}`);
  }

  // Check if any overall top 25 names appear exclusively in one gender
  printSubHeader('Overall Top 25 — Gender Breakdown');
  const maxTopNameLen = Math.max(...overall.topNames.map(n => n.name.length), 4);
  console.log(`  ${'Name'.padEnd(maxTopNameLen)}  ${'Total'.padStart(6)}  ${'Male'.padStart(6)}  ${'Female'.padStart(6)}`);
  console.log(`  ${'-'.repeat(maxTopNameLen)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}`);
  for (const n of overall.topNames) {
    const mc = maleNameFreq.get(n.name) || 0;
    const fc = femaleNameFreq.get(n.name) || 0;
    console.log(`  ${n.name.padEnd(maxTopNameLen)}  ${String(n.count).padStart(6)}  ${String(mc).padStart(6)}  ${String(fc).padStart(6)}`);
  }

  // ===== Per-Parameter Breakdowns =====

  const paramKeys = ['model', 'gender', 'elaborate', 'seedParagraph', 'seedType'] as const;
  const paramBreakdowns: Record<string, Record<string, SliceAnalysis>> = {};

  for (const paramKey of paramKeys) {
    printHeader(`BREAKDOWN BY: ${paramKey.toUpperCase()}`);
    const groups = groupBy(records, r => String(r.params[paramKey]));
    const breakdown: Record<string, SliceAnalysis> = {};

    const sortedKeys = [...groups.keys()].sort();
    for (const value of sortedKeys) {
      const slice = groups.get(value)!;
      const analysis = analyzeSlice(slice, 10);
      breakdown[value] = analysis;

      printSubHeader(`${paramKey} = ${value}`);
      console.log(`  Sample count:   ${analysis.sampleCount}`);
      console.log(`  Unique names:   ${analysis.uniqueNames}`);
      console.log(`  Shannon entropy: ${analysis.shannonEntropy.toFixed(3)}`);
      console.log(`  Top 10 names:`);
      printNameTable(analysis.topNames, '    ');
    }
    paramBreakdowns[paramKey] = breakdown;
  }

  // ===== Model × Elaborate Breakdown =====

  printHeader('MODEL × ELABORATE BREAKDOWN');

  const modelElaborateBreakdown: Record<string, SliceAnalysis> = {};
  const modelElaborateGroups = groupBy(records, r => `${r.params.model}|${r.params.elaborate}`);

  for (const [key, slice] of [...modelElaborateGroups.entries()].sort()) {
    const [model, elaborate] = key.split('|');
    const analysis = analyzeSlice(slice, 25);
    modelElaborateBreakdown[key] = analysis;

    printSubHeader(`${model} | elaborate=${elaborate}`);
    console.log(`  Sample count:   ${analysis.sampleCount}`);
    console.log(`  Unique names:   ${analysis.uniqueNames}`);
    console.log(`  Shannon entropy: ${analysis.shannonEntropy.toFixed(3)}`);
    console.log(`  Top 25 names:`);
    printNameTable(analysis.topNames, '    ');
  }

  // ===== Cross-Parameter Combos =====

  printHeader('CROSS-PARAMETER COMBINATIONS');

  interface ComboResult {
    model: string;
    gender: string;
    elaborate: string;
    seedParagraph: string;
    seedType: string;
    analysis: SliceAnalysis;
  }

  const combos: ComboResult[] = [];
  const comboGroups = groupBy(records, r =>
    `${r.params.model}|${r.params.gender}|${r.params.elaborate}|${r.params.seedParagraph}|${r.params.seedType}`
  );

  for (const [key, slice] of [...comboGroups.entries()].sort()) {
    const [model, gender, elaborate, seedParagraph, seedType] = key.split('|');
    const analysis = analyzeSlice(slice, 5);
    combos.push({ model, gender, elaborate, seedParagraph, seedType, analysis });

    printSubHeader(`${model} | ${gender} | elab=${elaborate} | seed=${seedParagraph} | seedType=${seedType}`);
    console.log(`  n=${analysis.sampleCount}, unique=${analysis.uniqueNames}, entropy=${analysis.shannonEntropy.toFixed(3)}`);
    if (analysis.topNames.length > 0) {
      console.log(`  Top 5: ${analysis.topNames.map(n => `${n.name}(${n.count})`).join(', ')}`);
    }
  }

  // ===== Entropy Comparison Table =====

  printHeader('ENTROPY COMPARISON (sorted by Shannon entropy)');

  const sorted = [...combos].sort((a, b) => b.analysis.shannonEntropy - a.analysis.shannonEntropy);

  const labelWidth = 75;
  console.log(
    `  ${'Combination'.padEnd(labelWidth)}  ${'n'.padStart(5)}  ${'Uniq'.padStart(5)}  ${'Entropy'.padStart(8)}`
  );
  console.log(`  ${'-'.repeat(labelWidth)}  ${'-'.repeat(5)}  ${'-'.repeat(5)}  ${'-'.repeat(8)}`);

  for (const combo of sorted) {
    const label = `${combo.model} | ${combo.gender} | elab=${combo.elaborate} | seed=${combo.seedParagraph} | ${combo.seedType}`;
    console.log(
      `  ${label.padEnd(labelWidth)}  ${String(combo.analysis.sampleCount).padStart(5)}  ${String(combo.analysis.uniqueNames).padStart(5)}  ${combo.analysis.shannonEntropy.toFixed(3).padStart(8)}`
    );
  }

  // ===== Write JSON Report =====

  const report = {
    generatedAt: new Date().toISOString(),
    overall: {
      totalRecords: records.length,
      uniqueNames: uniqueNames.size,
      shannonEntropy: overall.shannonEntropy,
      topNames: overall.topNames,
      singletonsCount: singletons.length,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheWriteTokens: totalCacheWrite,
        cacheReadTokens: totalCacheRead,
        estimatedCostUSD: round(estimatedCost, 2),
      },
    },
    genderCrossover: {
      maleOnlyCount: maleOnlyNames.length,
      femaleOnlyCount: femaleOnlyNames.length,
      sharedCount: sharedNames.length,
      topSharedNames: crossoverDetails.slice(0, 25).map(c => ({
        name: c.name,
        maleCount: c.maleCount,
        femaleCount: c.femaleCount,
      })),
      topNamesGenderBreakdown: overall.topNames.map(n => ({
        name: n.name,
        total: n.count,
        maleCount: maleNameFreq.get(n.name) || 0,
        femaleCount: femaleNameFreq.get(n.name) || 0,
      })),
    },
    paramBreakdowns,
    modelElaborateBreakdown,
    crossParameterCombos: combos.map(c => ({
      model: c.model,
      gender: c.gender,
      elaborate: c.elaborate,
      seedParagraph: c.seedParagraph,
      seedType: c.seedType,
      ...c.analysis,
    })),
    entropyRanking: sorted.map(c => ({
      label: `${c.model} | ${c.gender} | elab=${c.elaborate} | seed=${c.seedParagraph} | ${c.seedType}`,
      sampleCount: c.analysis.sampleCount,
      uniqueNames: c.analysis.uniqueNames,
      shannonEntropy: c.analysis.shannonEntropy,
    })),
  };

  const reportPath = join(import.meta.dirname, '../../output/random-names-analysis.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nJSON report written to: ${reportPath}`);
}

main();
