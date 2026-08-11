/**
 * Unit tests for the agenda service (pure logic — no Supabase/network).
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSlots,
  resolveMeetingTime,
  formatTime,
  msToWallDate,
  wallDateToMs,
  type AgendaSettings,
  type WeeklySlot,
} from '../services/agenda.service.js';

const SETTINGS: AgendaSettings = {
  duration_min: 30,
  gap_min: 15,
  future_days: 7,
  timezone: 'America/Sao_Paulo',
};

const WEEKDAYS: WeeklySlot[] = [
  { day: 1, start: 540, end: 720 }, // seg 09:00-12:00
  { day: 2, start: 780, end: 960 }, // ter 13:00-16:00
];

// 2026-08-11 é uma terça-feira. Âncora: seg 2026-08-10 / ter 2026-08-11.
const MON_MS = wallDateToMs('2026-08-10');
const TUE_MS = wallDateToMs('2026-08-11');

test('computeSlots gera slots dentro da janela semanal', () => {
  const slots = computeSlots({
    settings: SETTINGS,
    weeklySlots: WEEKDAYS,
    blocks: [],
    meetings: [],
    now: MON_MS,
    startDayMs: MON_MS,
    endDayMs: TUE_MS,
  });
  // Seg: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30 (6) + Ter: 13:00..15:30 (6)
  assert.equal(slots.length, 12);
  assert.ok(slots.every((s) => s.time >= '09:00' && s.time <= '15:30'));
  assert.ok(slots[0].day === '2026-08-10');
});

test('computeSlots ignora slots no passado', () => {
  // "now" no meio da manhã de terça -> só 13:00 em diante aparece.
  const nowMs = TUE_MS + 11 * 3_600_000 + 30 * 60_000; // 11:30 terça
  const slots = computeSlots({
    settings: SETTINGS,
    weeklySlots: WEEKDAYS,
    blocks: [],
    meetings: [],
    now: nowMs,
    startDayMs: MON_MS,
    endDayMs: TUE_MS,
  });
  assert.equal(slots.length, 6);
  assert.ok(slots.every((s) => s.day === '2026-08-11' && s.time >= '13:00'));
});

test('computeSlots remove horários bloqueados', () => {
  const block = {
    start: TUE_MS + 13 * 3_600_000, // ter 13:00
    end: TUE_MS + 15 * 3_600_000, // ter 15:00
  };
  const slots = computeSlots({
    settings: SETTINGS,
    weeklySlots: WEEKDAYS,
    blocks: [block],
    meetings: [],
    now: MON_MS,
    startDayMs: MON_MS,
    endDayMs: TUE_MS,
  });
  // Ter só sobra 15:00 e 15:30 (13:00-15:00 bloqueado) + os 6 de seg.
  assert.equal(slots.filter((s) => s.day === '2026-08-11').length, 2);
});

test('computeSlots remove horários já reservados (com gap)', () => {
  const meeting = {
    start: TUE_MS + 13 * 3_600_000, // ter 13:00-13:30
    end: TUE_MS + 13 * 3_600_000 + 30 * 60_000,
    leadId: 'outro-lead',
  };
  const slots = computeSlots({
    settings: SETTINGS,
    weeklySlots: WEEKDAYS,
    blocks: [],
    meetings: [meeting],
    now: MON_MS,
    startDayMs: MON_MS,
    endDayMs: TUE_MS,
  });
  const tue = slots.filter((s) => s.day === '2026-08-11');
  // 13:00 ocupado; com gap 15min 13:30 e 13:45 inviáveis => 14:00 é o primeiro.
  assert.equal(tue[0].time, '14:00');
  assert.equal(tue.length, 4);
});

test('computeSlots ignora reuniões do próprio lead (reagendamento)', () => {
  const meeting = {
    start: TUE_MS + 13 * 3_600_000,
    end: TUE_MS + 13 * 3_600_000 + 30 * 60_000,
    leadId: 'lead-1',
  };
  const slots = computeSlots({
    settings: SETTINGS,
    weeklySlots: WEEKDAYS,
    blocks: [],
    meetings: [meeting],
    now: MON_MS,
    startDayMs: MON_MS,
    endDayMs: TUE_MS,
    excludeLeadId: 'lead-1',
  });
  // O próprio lead "pode" usar o próprio horário de novo na listagem.
  assert.ok(slots.some((s) => s.day === '2026-08-11' && s.time === '13:00'));
});

test('resolveMeetingTime resolve datas relativas em São Paulo', () => {
  const now = new Date('2026-08-11T14:00:00.000Z'); // 11h em SP (UTC-3)
  const amanha = resolveMeetingTime('amanhã às 10h', now);
  assert.ok(amanha);
  assert.equal(amanha.toISOString(), '2026-08-12T13:00:00.000Z'); // 10h SP = 13h UTC
});

test('resolveMeetingTime retorna null sem data e hora juntas', () => {
  const now = new Date('2026-08-11T14:00:00.000Z'); // 11:00 SP
  assert.equal(resolveMeetingTime('amanhã', now), null); // só dia, sem hora
  assert.equal(resolveMeetingTime('', now), null);
});

test('resolveMeetingTime com só hora escolhe hoje ou amanhã', () => {
  const now = new Date('2026-08-11T14:00:00.000Z'); // 11:00 SP
  // 10h de hoje já passou -> resolve para amanhã 10h.
  assert.equal(resolveMeetingTime('às 10h', now)?.toISOString(), '2026-08-12T13:00:00.000Z');
});

test('formatTime usa hora local de São Paulo', () => {
  assert.equal(formatTime(Date.UTC(2026, 7, 11, 13, 0)), '10:00'); // 13h UTC = 10h SP
  assert.equal(formatTime(Date.UTC(2026, 7, 11, 16, 30)), '13:30');
});

test('msToWallDate / wallDateToMs são inversos', () => {
  const iso = '2026-08-11';
  assert.equal(msToWallDate(wallDateToMs(iso)), iso);
});
