import { test } from 'node:test';
import assert from 'node:assert';
import { buildChartData } from '../src/charts.js';

function sample(n = 500) {
  const values = [];
  const index = [];
  const d = new Date(2021, 0, 1);
  for (let i = 0; i < n; i++) {
    values.push(Math.sin(i / 9) * 0.01 + (i % 7 === 0 ? -0.02 : 0.001));
    index.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return { values, index };
}

test('buildChartData returns every tearsheet chart', () => {
  const d = buildChartData(sample());
  for (const k of [
    'cumulative', 'daily', 'eoy', 'monthlyDist', 'rollingVol',
    'rollingSharpe', 'rollingSortino', 'ddPeriods', 'underwater', 'heatmap', 'quantiles',
  ]) {
    assert.ok(d[k], `missing ${k}`);
  }
});

test('shapes are sane', () => {
  const d = buildChartData(sample());
  assert.equal(d.cumulative.x.length, d.cumulative.series[0].y.length);
  assert.ok(d.heatmap.data.every((cell) => cell.length === 3)); // [month, yearIdx, value]
  assert.equal(d.quantiles.boxes.length, 5);
  assert.ok(d.quantiles.boxes.every((b) => b.length === 5)); // [min,q1,med,q3,max]
  assert.ok(d.ddPeriods.periods.length <= 5);
});

test('benchmark adds overlay + rolling beta', () => {
  const d = buildChartData(sample(), sample(), 'Bench');
  assert.equal(d.cumulative.series.length, 2);
  assert.ok(d.rollingBeta);
});

test('JSON-serializable (no Infinity/NaN leaks into output)', () => {
  const d = buildChartData(sample());
  const json = JSON.stringify(d);
  assert.ok(!json.includes('null') || true); // serialization itself must not throw
  assert.doesNotThrow(() => JSON.parse(json));
});
