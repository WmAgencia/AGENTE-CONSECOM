/**
 * Unit tests for the campaign schedule conflict rule (pure logic — no network).
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findConflicts,
  computeNextAvailableStart,
  type CampaignScheduleConfig,
  type CampaignTimeWindow,
} from '../services/campaign.schedule.service.js';

const CONFIG: CampaignScheduleConfig = {
  interval_min: 20,
  avg_seconds_per_msg: 30,
  min_duration_min: 10,
};

function window(startMs: number, endMs: number, campaignId = 'c'): CampaignTimeWindow {
  return {
    campaignId,
    name: campaignId,
    status: 'agendada',
    startMs,
    endMs,
    durationMin: (endMs - startMs) / 60_000,
    scheduledAt: null,
  };
}

const H = 3_600_000; // 1h em ms
const M = 60_000; // 1min em ms

test('findConflicts: início antes da janela não conflita', () => {
  // Janela 10:00-11:00, intervalo 20min => janela efetiva até 11:20.
  const w = window(10 * H, 11 * H);
  // 09:00-09:30 termina antes de 10:00 -> livre.
  const conflicts = findConflicts({ startMs: 9 * H, durationMin: 30, config: CONFIG, windows: [w] });
  assert.equal(conflicts.length, 0);
});

test('findConflicts: início dentro da janela efetiva conflita', () => {
  const w = window(10 * H, 11 * H);
  // 10:30-11:00 cai dentro de [10:00, 11:20] -> conflito.
  const conflicts = findConflicts({ startMs: 10 * H + 30 * M, durationMin: 30, config: CONFIG, windows: [w] });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].campaignId, 'c');
});

test('findConflicts: fim da anterior + interval_min é o primeiro livre', () => {
  const w = window(10 * H, 11 * H);
  // 11:20-11:50: começa exatamente em fim+intervalo -> livre.
  const conflicts = findConflicts({ startMs: 11 * H + 20 * M, durationMin: 30, config: CONFIG, windows: [w] });
  assert.equal(conflicts.length, 0);
});

test('findConflicts: excludeCampaignId ignora a própria campanha', () => {
  const w = window(10 * H, 11 * H, 'c1');
  const conflicts = findConflicts({
    startMs: 10 * H + 30 * M,
    durationMin: 30,
    config: CONFIG,
    windows: [w],
    excludeCampaignId: 'c1',
  });
  assert.equal(conflicts.length, 0);
});

test('computeNextAvailableStart: sem conflito retorna afterMs', () => {
  const w = window(10 * H, 11 * H);
  assert.equal(computeNextAvailableStart({ afterMs: 9 * H, durationMin: 30, config: CONFIG, windows: [w] }), 9 * H);
});

test('computeNextAvailableStart: pula para fim+intervalo quando conflita', () => {
  const w = window(10 * H, 11 * H);
  // 10:30 conflita -> primeiro livre = 11:20.
  assert.equal(
    computeNextAvailableStart({ afterMs: 10 * H + 30 * M, durationMin: 30, config: CONFIG, windows: [w] }),
    11 * H + 20 * M,
  );
});

test('computeNextAvailableStart: atravessa janelas consecutivas', () => {
  const w1 = window(10 * H, 11 * H, 'c1'); // efetiva até 11:20
  const w2 = window(11 * H + 30 * M, 12 * H + 30 * M, 'c2'); // efetiva até 12:50
  // 11:20-11:50 conflita com w2 (11:50 > 11:30) -> pula para 12:50.
  assert.equal(
    computeNextAvailableStart({ afterMs: 10 * H + 30 * M, durationMin: 30, config: CONFIG, windows: [w1, w2] }),
    12 * H + 50 * M,
  );
});

test('computeNextAvailableStart: lead longo atravessa várias janelas', () => {
  const w1 = window(10 * H, 11 * H, 'c1');
  const w2 = window(12 * H, 13 * H, 'c2');
  // Duração de 3h: nenhum início entre as janelas cabe, sobra depois de w2.
  const start = computeNextAvailableStart({ afterMs: 9 * H, durationMin: 180, config: CONFIG, windows: [w1, w2] });
  assert.equal(start, 13 * H + 20 * M);
});

test('computeNextAvailableStart: excludeCampaignId libera a própria janela', () => {
  const w = window(10 * H, 11 * H, 'c1');
  const start = computeNextAvailableStart({
    afterMs: 10 * H + 30 * M,
    durationMin: 30,
    config: CONFIG,
    windows: [w],
    excludeCampaignId: 'c1',
  });
  assert.equal(start, 10 * H + 30 * M);
});
