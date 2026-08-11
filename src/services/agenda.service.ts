/**
 * Agenda de reuniões — fonte de verdade da disponibilidade da IA.
 *
 * As reuniões NÃO são um sistema paralelo: continuam vivendo em `leads`
 * (status `reuniao_marcada` + `meeting_at`), igual ao fluxo do Kanban e do
 * VYNTRA Mobile (que já sincroniza a tabela `leads` via realtime).
 *
 * A configuração da agenda (disponibilidade semanal, bloqueios/exceções,
 * duração, intervalo, janela futura, durações por reunião) é persistida em
 * `agent_settings` como JSON (reuso da infraestrutura existente — sem DDL).
 *
 * Disponibilidade = semanal (agenda_slots) − exceções/bloqueios (agenda_blocks)
 * − reuniões existentes (leads.reuniao_marcada) − passado.
 *
 * Reserva atômica: serialização por fechadura em processo (slot lock). O
 * backend é a autoridade final — verifica disponibilidade antes de chamar a
 * RPC canônica `consecom_marcar_reuniao` que grava a reunião no Supabase.
 *
 * Timezone: America/Sao_Paulo (UTC−3 fixo — sem horário de verão desde 2019).
 * Datas/horas são persistidas em UTC (ISO) e resolvidas para o fuso local ao
 * gerar/interpretar horários, para nunca deslocar uma reunião.
 */
import { getSupabaseProspeccaoConfig, hasSupabaseProspeccao, getEnv } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { recordAgentOutcome } from './supabase.leads.js';
import { sendGroupText } from './evolution.service.js';
import { resolveNotificationGroupJid } from './evolution.connections.js';

// ---------------------------------------------------------------------------
// Constantes e tipos
// ---------------------------------------------------------------------------

/** Offset fixo de São Paulo (sem DST desde 2019). */
export const SAO_PAULO_OFFSET_MS = -3 * 3600_000;

export const DAY_LABELS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

export interface WeeklySlot {
  /** 0=domingo … 6=sábado */
  day: number;
  /** minutos desde 00:00 (hora local) */
  start: number;
  end: number;
}

export interface AgendaSettings {
  duration_min: number;
  gap_min: number;
  future_days: number;
  timezone: string;
}

export interface AgendaBlock {
  id: string;
  start_at: string;
  end_at: string;
  reason?: string | null;
}

export interface AgendaMeeting {
  leadId: string;
  name: string | null;
  phone: string | null;
  status: 'reuniao_marcada' | 'reuniao_cancelada' | string;
  meeting_at: string | null;
  meeting_notes: string | null;
  meeting_outcome: string | null;
  durationMin: number;
  start: number;
  end: number;
}

export interface AvailableSlot {
  /** instante de início em UTC (ISO) */
  start: string;
  end: string;
  /** dia local YYYY-MM-DD */
  day: string;
  /** hora local HH:mm */
  time: string;
}

export type ReserveReason =
  | 'indisponivel'
  | 'conflito'
  | 'fora_do_horario'
  | 'agenda_nao_configurada'
  | 'io_error'
  | 'invalid_args';

export interface ReserveResult {
  ok: boolean;
  reason?: ReserveReason;
  message?: string;
  suggestions?: string[];
  start?: string;
}

const DEFAULT_SETTINGS: AgendaSettings = {
  duration_min: 30,
  gap_min: 0,
  future_days: 14,
  timezone: 'America/Sao_Paulo',
};

const KEY_SETTINGS = 'agenda_settings';
const KEY_SLOTS = 'agenda_slots';
const KEY_BLOCKS = 'agenda_blocks';
const KEY_DURATIONS = 'agenda_durations';

// ---------------------------------------------------------------------------
// Acesso a agent_settings (JSON) via REST
// ---------------------------------------------------------------------------

function supabase() {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? cfg : null;
}

function headers(json = false): Record<string, string> {
  const cfg = getSupabaseProspeccaoConfig();
  return json
    ? { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}`, 'Content-Type': 'application/json' }
    : { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
}

async function getRow(key: string): Promise<unknown | null> {
  const res = await fetchRow(key);
  return res.ok ? res.value : null;
}

/**
 * Lê uma chave de agent_settings distinguindo "não existe" de "não consegui
 * consultar". Sem isso, um Supabase fora do ar pareceria uma agenda vazia.
 */
async function fetchRow(key: string): Promise<{ ok: boolean; value: unknown | null }> {
  const s = supabase();
  if (!s) return { ok: false, value: null };
  try {
    const res = await fetch(
      `${s.url}/rest/v1/agent_settings?select=value&key=eq.${encodeURIComponent(key)}&limit=1`,
      { headers: headers() },
    );
    if (!res.ok) return { ok: false, value: null };
    const rows = (await res.json()) as Array<{ value: unknown }>;
    if (rows.length === 0) return { ok: true, value: null };
    const raw = rows[0].value;
    if (typeof raw !== 'string') return { ok: true, value: raw ?? null };
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: true, value: raw };
    }
  } catch {
    return { ok: false, value: null };
  }
}

async function upsertRow(key: string, value: unknown): Promise<boolean> {
  const s = supabase();
  if (!s) return false;
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const exists = await getRow(key);
    if (exists !== null) {
      const res = await fetch(
        `${s.url}/rest/v1/agent_settings?key=eq.${encodeURIComponent(key)}`,
        { method: 'PATCH', headers: headers(true), body: JSON.stringify({ value: json }) },
      );
      return res.ok;
    }
    const res = await fetch(`${s.url}/rest/v1/agent_settings`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ key, value: json }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loaders / savers
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<AgendaSettings> {
  const raw = await getRow(KEY_SETTINGS);
  if (raw && typeof raw === 'object') {
    const r = raw as Partial<AgendaSettings>;
    return {
      duration_min: clampPositive(r.duration_min, DEFAULT_SETTINGS.duration_min),
      gap_min: clampNonNegative(r.gap_min, DEFAULT_SETTINGS.gap_min),
      future_days: clampPositive(r.future_days, DEFAULT_SETTINGS.future_days),
      timezone: typeof r.timezone === 'string' && r.timezone ? r.timezone : DEFAULT_SETTINGS.timezone,
    };
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(s: Partial<AgendaSettings>): Promise<boolean> {
  const current = await loadSettings();
  const next: AgendaSettings = {
    duration_min: clampPositive(s.duration_min, current.duration_min),
    gap_min: clampNonNegative(s.gap_min, current.gap_min),
    future_days: clampPositive(s.future_days, current.future_days),
    timezone: typeof s.timezone === 'string' && s.timezone ? s.timezone : current.timezone,
  };
  return upsertRow(KEY_SETTINGS, next);
}

function normalizeSlots(raw: unknown): WeeklySlot[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((x): x is WeeklySlot => !!x && typeof x === 'object')
    .map((x) => ({
      day: clamp(Number((x as WeeklySlot).day), 0, 6),
      start: clampNonNegative(Number((x as WeeklySlot).start), 0),
      end: clampPositive(Number((x as WeeklySlot).end), 1),
    }))
    .filter((s) => s.end > s.start);
}

export async function loadSlots(): Promise<WeeklySlot[]> {
  const raw = await getRow(KEY_SLOTS);
  return normalizeSlots(raw);
}

/** loadSlots com detecção de erro de consulta: null = Supabase inacessível. */
async function loadSlotsStrict(): Promise<WeeklySlot[] | null> {
  const res = await fetchRow(KEY_SLOTS);
  if (!res.ok) return null;
  return normalizeSlots(res.value);
}

export async function saveSlots(slots: WeeklySlot[]): Promise<boolean> {
  const clean = slots
    .map((s) => ({
      day: clamp(Number(s.day), 0, 6),
      start: clampNonNegative(Number(s.start), 0),
      end: clampPositive(Number(s.end), 1),
    }))
    .filter((s) => s.end > s.start && s.end <= 1440);
  return upsertRow(KEY_SLOTS, clean);
}

export async function loadBlocks(): Promise<AgendaBlock[]> {
  const raw = await getRow(KEY_BLOCKS);
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((x): x is AgendaBlock => !!x && typeof x === 'object')
    .map((b) => ({
      id: String((b as AgendaBlock).id ?? ''),
      start_at: String((b as AgendaBlock).start_at ?? ''),
      end_at: String((b as AgendaBlock).end_at ?? ''),
      reason: (b as AgendaBlock).reason ?? null,
    }))
    .filter((b) => b.id && b.start_at && b.end_at);
}

export async function addBlock(input: { start_at: string; end_at: string; reason?: string | null }): Promise<AgendaBlock | null> {
  const blocks = await loadBlocks();
  const id = crypto.randomUUID();
  const block: AgendaBlock = { id, start_at: input.start_at, end_at: input.end_at, reason: input.reason ?? null };
  blocks.push(block);
  if (!(await upsertRow(KEY_BLOCKS, blocks))) return null;
  return block;
}

export async function removeBlock(id: string): Promise<boolean> {
  const blocks = await loadBlocks();
  const next = blocks.filter((b) => b.id !== id);
  if (next.length === blocks.length) return true;
  return upsertRow(KEY_BLOCKS, next);
}

async function loadDurations(): Promise<Record<string, number>> {
  const raw = await getRow(KEY_DURATIONS);
  if (raw && typeof raw === 'object') {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) out[k] = Math.round(n);
    }
    return out;
  }
  return {};
}

async function saveDuration(leadId: string, durationMin: number): Promise<void> {
  if (!leadId || !Number.isFinite(durationMin) || durationMin <= 0) return;
  const durations = await loadDurations();
  durations[leadId] = Math.round(durationMin);
  await upsertRow(KEY_DURATIONS, durations);
}

// ---------------------------------------------------------------------------
// Timezone helpers (America/Sao_Paulo, UTC−3 fixo)
// ---------------------------------------------------------------------------

interface WallParts {
  y: number;
  m: number; // 0-based
  d: number;
  dow: number; // 0=domingo
  min: number; // minutos desde 00:00 local
}

function toWall(ms: number): WallParts {
  const w = new Date(ms + SAO_PAULO_OFFSET_MS);
  return {
    y: w.getUTCFullYear(),
    m: w.getUTCMonth(),
    d: w.getUTCDate(),
    dow: w.getUTCDay(),
    min: w.getUTCHours() * 60 + w.getUTCMinutes(),
  };
}

function wallToMs(y: number, m: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, m, d, hh, mm) - SAO_PAULO_OFFSET_MS;
}

function wallDayMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m, d) - SAO_PAULO_OFFSET_MS;
}

function isoToWall(iso: string): WallParts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return toWall(ms);
}

export function formatWallDate(iso: string): string {
  const w = isoToWall(iso);
  if (!w) return '';
  const dd = String(w.d).padStart(2, '0');
  const mm = String(w.m + 1).padStart(2, '0');
  return `${w.y}-${mm}-${dd}`;
}

/** 'YYYY-MM-DD' (local) -> ms de início do dia em UTC. */
export function wallDateToMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  return wallDayMs(y, m - 1, d);
}

/** ms -> 'YYYY-MM-DD' (local). */
export function msToWallDate(ms: number): string {
  const w = toWall(ms);
  return `${w.y}-${String(w.m + 1).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

export function formatTime(ms: number): string {
  const w = toWall(ms);
  return `${String(Math.floor(w.min / 60)).padStart(2, '0')}:${String(w.min % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Núcleo puro: cálculo de disponibilidade
// ---------------------------------------------------------------------------

interface MeetingLike {
  start: number;
  end: number;
  leadId?: string;
}

interface BlockLike {
  start: number;
  end: number;
}

export interface ComputeSlotsInput {
  now: number;
  /** ms do início do primeiro dia (local) */
  startDayMs: number;
  /** ms do início do último dia (local) */
  endDayMs: number;
  settings: AgendaSettings;
  weeklySlots: WeeklySlot[];
  blocks: BlockLike[];
  meetings: MeetingLike[];
  /** lead a ignorar ao checar conflitos (reschedule do próprio lead) */
  excludeLeadId?: string;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Gera os horários realmente reserváveis no intervalo.
 * Regras: janela semanal + duração + intervalo + bloqueios + reuniões
 * existentes (com gap) + não oferecer passado.
 */
export function computeSlots(input: ComputeSlotsInput): AvailableSlot[] {
  const { settings, weeklySlots, blocks, meetings, excludeLeadId } = input;
  const durationMs = settings.duration_min * 60_000;
  const gapMs = settings.gap_min * 60_000;
  const slots: AvailableSlot[] = [];
  const now = input.now;

  const dayMsStart = input.startDayMs;
  const dayMsEnd = input.endDayMs;

  for (let dayMs = dayMsStart; dayMs <= dayMsEnd; dayMs += 86_400_000) {
    const w = toWall(dayMs);
    const daySlots = weeklySlots.filter((s) => s.day === w.dow);
    for (const window of daySlots) {
      for (let t = window.start; t + durationMs / 60_000 <= window.end; t += settings.duration_min) {
        const startMs = wallToMs(w.y, w.m, w.d, Math.floor(t / 60), t % 60);
        const endMs = startMs + durationMs;
        if (startMs < now) continue;

        if (blocks.some((b) => overlaps(startMs, endMs, b.start, b.end))) continue;

        const meetingConflict = meetings.some(
          (m) =>
            m.leadId !== excludeLeadId &&
            m.start < startMs + durationMs &&
            m.end > startMs - gapMs,
        );
        if (meetingConflict) continue;

        slots.push({
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          day: msToWallDate(startMs),
          time: formatTime(startMs),
        });
      }
    }
  }

  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

/** Verifica se um horário exato está disponível (mesma lógica do computeSlots). */
function isSlotAvailable(opts: {
  startMs: number;
  now: number;
  settings: AgendaSettings;
  weeklySlots: WeeklySlot[];
  blocks: BlockLike[];
  meetings: MeetingLike[];
  excludeLeadId?: string;
}): boolean {
  const { startMs, settings, weeklySlots, blocks, meetings, excludeLeadId, now } = opts;
  const durationMs = settings.duration_min * 60_000;
  const gapMs = settings.gap_min * 60_000;
  if (startMs < now) return false;

  const w = toWall(startMs);
  const window = weeklySlots.find((s) => s.day === w.dow && startMs >= wallToMs(w.y, w.m, w.d, Math.floor(s.start / 60), s.start % 60) && startMs + durationMs <= wallToMs(w.y, w.m, w.d, Math.floor(s.end / 60), s.end % 60));
  if (!window) return false;

  const endMs = startMs + durationMs;
  if (blocks.some((b) => overlaps(startMs, endMs, b.start, b.end))) return false;
  if (
    meetings.some(
      (m) =>
        m.leadId !== excludeLeadId &&
        m.start < startMs + durationMs &&
        m.end > startMs - gapMs,
    )
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dados agregados (para o calendário)
// ---------------------------------------------------------------------------

async function fetchMeetings(startMs: number, endMs: number): Promise<AgendaMeeting[]> {
  const s = supabase();
  if (!s) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/leads?select=id,name,phone,status,meeting_at,meeting_notes,meeting_outcome` +
        `&status=in.("reuniao_marcada","reuniao_cancelada")` +
        `&meeting_at=gte.${encodeURIComponent(new Date(startMs).toISOString())}` +
        `&meeting_at=lte.${encodeURIComponent(new Date(endMs).toISOString())}` +
        `&order=meeting_at.asc`,
      { headers: headers() },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const settings = await loadSettings();
    const durations = await loadDurations();
    return rows.map((r) => {
      const start = Date.parse(String(r.meeting_at ?? ''));
      const leadId = String(r.id ?? '');
      const durationMin = durations[leadId] ?? settings.duration_min;
      return {
        leadId,
        name: typeof r.name === 'string' ? r.name : null,
        phone: typeof r.phone === 'string' ? r.phone : null,
        status: String(r.status ?? ''),
        meeting_at: typeof r.meeting_at === 'string' ? r.meeting_at : null,
        meeting_notes: typeof r.meeting_notes === 'string' ? r.meeting_notes : null,
        meeting_outcome: typeof r.meeting_outcome === 'string' ? r.meeting_outcome : null,
        durationMin,
        start: Number.isNaN(start) ? 0 : start,
        end: Number.isNaN(start) ? 0 : start + durationMin * 60_000,
      };
    });
  } catch {
    return [];
  }
}

export interface AgendaData {
  settings: AgendaSettings;
  slots: WeeklySlot[];
  blocks: AgendaBlock[];
  meetings: AgendaMeeting[];
  generatedAt: string;
}

export async function getAgendaData(start: string, end: string): Promise<AgendaData> {
  const settings = await loadSettings();
  const slots = await loadSlots();
  const blocks = await loadBlocks();
  const startMs = wallDateToMs(start);
  const endMs = wallDateToMs(end) + 86_400_000 - 1;
  const meetings = Number.isNaN(startMs) || Number.isNaN(endMs) ? [] : await fetchMeetings(startMs, endMs);
  return { settings, slots, blocks, meetings, generatedAt: new Date().toISOString() };
}

export interface GetSlotsOptions {
  startDate?: string;
  endDate?: string;
  durationMin?: number;
  now?: Date;
}

export async function getAvailableSlots(opts: GetSlotsOptions = {}): Promise<AvailableSlot[]> {
  if (!hasSupabaseProspeccao()) return [];
  const settings = await loadSettings();
  const weeklySlots = await loadSlots();
  if (weeklySlots.length === 0) return [];

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const todayWall = toWall(nowMs);
  const todayMs = wallDayMs(todayWall.y, todayWall.m, todayWall.d);

  const startMs = opts.startDate ? wallDateToMs(opts.startDate) : todayMs;
  const endMs = opts.endDate
    ? wallDateToMs(opts.endDate)
    : todayMs + (settings.future_days - 1) * 86_400_000;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return [];

  const blocks = (await loadBlocks())
    .map((b) => ({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

  const meetings = (await fetchMeetings(startMs, endMs + 86_400_000))
    .filter((m) => m.start > 0 && m.status === 'reuniao_marcada')
    .map((m) => ({ start: m.start, end: m.end, leadId: m.leadId }));

  const durationMin = opts.durationMin && opts.durationMin > 0 ? opts.durationMin : settings.duration_min;

  // Duração customizada: slots gerados com a duração informada.
  const settingsFor = { ...settings, duration_min: durationMin };
  return computeSlots({
    now: nowMs,
    startDayMs: startMs,
    endDayMs: endMs,
    settings: settingsFor,
    weeklySlots,
    blocks,
    meetings,
  });
}

// ---------------------------------------------------------------------------
// Reserva (atômica via slot lock + RPC canônica)
// ---------------------------------------------------------------------------

const slotLocks = new Map<string, Promise<void>>();

async function withSlotLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = slotLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const cur = new Promise<void>((r) => {
    release = r;
  });
  slotLocks.set(key, prev.then(() => cur));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    setTimeout(() => {
      if (slotLocks.get(key) === cur) slotLocks.delete(key);
    }, 0);
  }
}

export interface ReserveMeetingInput {
  leadId: string;
  startIso: string;
  durationMin?: number;
  notes?: string;
  notifyAdmin?: boolean;
  instance?: string;
}

/**
 * Reserva atômica de reunião. Backend é a autoridade: valida disponibilidade
 * (bloqueios, reuniões existentes, janela semanal, passado, gap) sob lock e,
 * se livre, grava via RPC `consecom_marcar_reuniao` (mesmo caminho do Kanban).
 */
export async function reserveMeeting(input: ReserveMeetingInput): Promise<ReserveResult> {
  const log = getLogger();
  if (!hasSupabaseProspeccao()) {
    return { ok: false, reason: 'io_error', message: 'Agenda não configurada (Supabase indisponível).' };
  }
  if (!input.leadId) {
    return { ok: false, reason: 'invalid_args', message: 'leadId é obrigatório.' };
  }
  const startMs = Date.parse(input.startIso);
  if (Number.isNaN(startMs)) {
    return { ok: false, reason: 'invalid_args', message: 'Data/hora da reunião inválida.' };
  }

  const now = new Date();
  return withSlotLock(`slot:${input.startIso}`, async () => {
    const settings = await loadSettings();
    const weeklySlots = await loadSlotsStrict();
    if (weeklySlots === null) {
      return {
        ok: false,
        reason: 'io_error',
        message: 'Não foi possível consultar a agenda de disponibilidade.',
      };
    }
    const durationMin = input.durationMin && input.durationMin > 0 ? Math.round(input.durationMin) : settings.duration_min;
    const startDayMs = wallDayMs(toWall(startMs).y, toWall(startMs).m, toWall(startMs).d);
    const endMs = startDayMs + 86_400_000;
    const blocks = (await loadBlocks())
      .map((b) => ({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) }))
      .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
    const meetings = (await fetchMeetings(startDayMs, endMs))
      .filter((m) => m.start > 0 && m.status === 'reuniao_marcada')
      .map((m) => ({ start: m.start, end: m.end, leadId: m.leadId }));

    const available = isSlotAvailable({
      startMs,
      now: now.getTime(),
      settings: { ...settings, duration_min: durationMin },
      weeklySlots,
      blocks,
      meetings,
      excludeLeadId: input.leadId,
    });

    if (!available) {
      let reason: ReserveReason = 'indisponivel';
      if (startMs < now.getTime()) reason = 'fora_do_horario';
      else if (weeklySlots.length === 0) reason = 'agenda_nao_configurada';
      const suggestions = await suggestNextSlots(startMs, durationMin);
      return {
        ok: false,
        reason,
        message:
          'Horário indisponível. ' +
          (reason === 'agenda_nao_configurada'
            ? 'A agenda de disponibilidade ainda não foi configurada no painel (aba Reuniões).'
            : 'Já está ocupado por outra reunião, bloqueado ou fora da sua disponibilidade.'),
        suggestions,
      };
    }

    // Grava via RPC canônica (mesma usada pelo Kanban/Mobile).
    const s = supabase()!;
    let recorded = false;
    try {
      const res = await fetch(`${s.url}/rest/v1/rpc/${s.rpc}`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          p_lead_id: input.leadId,
          p_meeting_at: new Date(startMs).toISOString(),
          p_notes: input.notes ?? null,
        }),
      });
      recorded = res.ok;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'network error';
      log.warn({ errMessage: msg }, 'agenda: RPC marcar_reuniao falhou');
    }
    if (!recorded) {
      return { ok: false, reason: 'io_error', message: 'Não foi possível gravar a reunião no sistema.' };
    }

    if (input.durationMin && input.durationMin > 0 && Math.round(input.durationMin) !== settings.duration_min) {
      await saveDuration(input.leadId, Math.round(input.durationMin));
    }

    if (input.notifyAdmin) {
      await notifyAdminGroup({ leadId: input.leadId, startMs, notes: input.notes ?? '', instance: input.instance });
    }

    return {
      ok: true,
      start: new Date(startMs).toISOString(),
      message: 'Reunião reservada com sucesso.',
    };
  });
}

/** Próximos horários disponíveis após `afterMs` (até 4), para sugerir alternativas. */
export async function suggestNextSlots(afterMs: number, durationMin?: number): Promise<string[]> {
  const settings = await loadSettings();
  const now = new Date(afterMs);
  const from = msToWallDate(afterMs);
  const until = msToWallDate(afterMs + (settings.future_days * 86_400_000));
  const slots = await getAvailableSlots({ startDate: from, endDate: until, durationMin, now });
  return slots
    .filter((s) => Date.parse(s.start) >= afterMs)
    .slice(0, 4)
    .map((s) => {
      const w = toWall(Date.parse(s.start));
      const dd = String(w.d).padStart(2, '0');
      const mm = String(w.m + 1).padStart(2, '0');
      return `${DAY_LABELS[w.dow]} ${dd}/${mm} às ${s.time}`;
    });
}

/** Formata os slots por dia para a IA ler de forma amigável. */
export async function formatSlotsForAgent(slots: AvailableSlot[]): Promise<string> {
  const settings = await loadSettings();
  const groups = new Map<string, string[]>();
  for (const s of slots) {
    const w = toWall(Date.parse(s.start));
    const dd = String(w.d).padStart(2, '0');
    const mm = String(w.m + 1).padStart(2, '0');
    const dayKey = `${DAY_LABELS[w.dow]} (${dd}/${mm})`;
    const arr = groups.get(dayKey) ?? [];
    arr.push(s.time);
    groups.set(dayKey, arr);
  }
  if (groups.size === 0) {
    return 'Nenhum horário disponível na janela consultada.';
  }
  const lines = [`Disponibilidade (duração padrão: ${settings.duration_min} min):`];
  for (const [day, times] of groups) {
    lines.push(`${day}: ${times.join(', ')}`);
  }
  lines.push(
    'Pergunte ao lead qual data/horário ele prefere e, quando ele escolher, ' +
      'chame marcar_reuniao com o dia e horário exatos (ex: meetingAt="amanhã às 14h").',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Edição / cancelamento
// ---------------------------------------------------------------------------

export interface EditMeetingInput {
  leadId: string;
  startIso?: string;
  durationMin?: number;
  notes?: string;
  instance?: string;
}

/** Reagenda (valida disponibilidade de novo) ou atualiza notas/duração. */
export async function editMeeting(input: EditMeetingInput): Promise<ReserveResult> {
  if (!input.leadId) return { ok: false, reason: 'invalid_args', message: 'leadId é obrigatório.' };
  if (input.startIso) {
    return reserveMeeting({
      leadId: input.leadId,
      startIso: input.startIso,
      durationMin: input.durationMin,
      notes: input.notes,
      instance: input.instance,
    });
  }
  // Só notas/duração: grava direto no lead (sem mudar o horário).
  const s = supabase();
  if (!s) return { ok: false, reason: 'io_error', message: 'Agenda não configurada.' };
  const patch: Record<string, unknown> = {};
  if (input.notes !== undefined) patch.meeting_notes = input.notes;
  if (input.durationMin && input.durationMin > 0) {
    await saveDuration(input.leadId, Math.round(input.durationMin));
  }
  try {
    const res = await fetch(`${s.url}/rest/v1/leads?id=eq.${encodeURIComponent(input.leadId)}`, {
      method: 'PATCH',
      headers: headers(true),
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, reason: 'io_error', message: 'Falha ao atualizar a reunião.' };
    return { ok: true, message: 'Reunião atualizada.' };
  } catch {
    return { ok: false, reason: 'io_error', message: 'Falha ao atualizar a reunião.' };
  }
}

/** Cancela a reunião (mantém histórico: status reuniao_cancelada, meeting_at preservado). */
export async function cancelMeeting(
  leadId: string,
  motive?: string,
): Promise<{ ok: boolean; message?: string }> {
  const ok = await recordAgentOutcome({
    leadId,
    outcome: 'reuniao_cancelada',
    motive,
    noInterestMonths: 0,
  });
  return ok
    ? { ok: true, message: 'Reunião cancelada. O horário volta a ficar disponível se não estiver bloqueado.' }
    : { ok: false, message: 'Não foi possível cancelar a reunião.' };
}

/** Marca a reunião como realizada (desfecho). */
export async function markMeetingRealized(leadId: string): Promise<{ ok: boolean; message?: string }> {
  const s = supabase();
  if (!s) return { ok: false, message: 'Agenda não configurada.' };
  try {
    const res = await fetch(`${s.url}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
      method: 'PATCH',
      headers: headers(true),
      body: JSON.stringify({ meeting_outcome: 'realizada', updated_at: new Date().toISOString() }),
    });
    return res.ok
      ? { ok: true, message: 'Reunião marcada como realizada.' }
      : { ok: false, message: 'Falha ao marcar como realizada.' };
  } catch {
    return { ok: false, message: 'Falha ao marcar como realizada.' };
  }
}

// ---------------------------------------------------------------------------
// Notificação ao grupo admin (reuso do sistema existente)
// ---------------------------------------------------------------------------

async function notifyAdminGroup(params: { leadId: string; startMs: number; notes: string; instance?: string }): Promise<void> {
  try {
    const targetGroup =
      (params.instance ? await resolveNotificationGroupJid(params.instance) : null) ??
      getEnv().AGENT_ADMIN_GROUP_JID;
    if (!targetGroup) return;
    const w = toWall(params.startMs);
    const label = `${DAY_LABELS[w.dow]}, ${String(w.d).padStart(2, '0')}/${String(w.m + 1).padStart(2, '0')} às ${formatTime(params.startMs)}`;
    const lines = [
      '📅 NOVA REUNIÃO',
      '',
      `Ref: ${params.leadId}`,
      `Data: ${label}`,
    ];
    if (params.notes) lines.push(`Obs.: ${params.notes}`);
    await sendGroupText(targetGroup, lines.join('\n'), params.instance);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Resolução de horário em linguagem natural -> ISO (São Paulo)
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  dom: 0,
  segunda: 1,
  segundaferia: 1,
  seg: 1,
  terca: 2,
  tercaferia: 2,
  terc: 2,
  ter: 2,
  quarta: 3,
  quartaferia: 3,
  qua: 3,
  quinta: 4,
  quintaferia: 4,
  qui: 4,
  sexta: 5,
  sextaferia: 5,
  sex: 5,
  sabado: 6,
  sab: 6,
};

/**
 * Resolve expressões como "amanhã às 10h", "hoje 14:30", "segunda 09h",
 * "18/08 às 15h" para um Date concreto no fuso America/Sao_Paulo.
 * Retorna null quando não consegue inferir data E hora.
 */
export function resolveMeetingTime(input: string, now = new Date()): Date | null {
  if (!input || typeof input !== 'string') return null;
  const text = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const nowMs = now.getTime();
  const today = toWall(nowMs);

  // --- Dia ---------------------------------------------------------------
  let dayOffset: number | null = null;
  let targetDow: number | null = null;
  let explicitY = today.y;
  let explicitM = today.m;
  let explicitD = today.d;

  if (/\bhoje\b/.test(text)) {
    dayOffset = 0;
  } else if (/\bamanha\b/.test(text) && !/\bdepois de amanha\b/.test(text)) {
    dayOffset = 1;
  } else if (/\bdepois de amanha\b/.test(text)) {
    dayOffset = 2;
  }

  const dateRe = /\b(\d{1,2})[/-](\d{1,2})([/-](\d{2,4}))?\b/;
  const dateMatch = text.match(dateRe);
  if (dateMatch) {
    const dd = Number(dateMatch[1]);
    const mm = Number(dateMatch[2]);
    let y = today.y;
    if (dateMatch[4]) {
      const y4 = Number(dateMatch[4]);
      y = y4 < 100 ? 2000 + y4 : y4;
    }
    const dayMs = wallDayMs(y, mm - 1, dd);
    if (dayMs >= nowMs) {
      explicitY = y;
      explicitM = mm - 1;
      explicitD = dd;
      dayOffset = Math.round((dayMs - wallDayMs(today.y, today.m, today.d)) / 86_400_000);
      targetDow = toWall(dayMs).dow;
    }
  }

  if (dayOffset === null && targetDow === null) {
    for (const [name, idx] of Object.entries(WEEKDAY_INDEX)) {
      if (new RegExp(`\\b${name}\\b`).test(text)) {
        const currentDow = toWall(nowMs).dow;
        let diff = idx - currentDow;
        if (diff <= 0) diff += 7;
        dayOffset = diff;
        break;
      }
    }
  }

  // --- Hora ---------------------------------------------------------------
  let hour: number | null = null;
  let minute = 0;

  if (/\bmeio[- ]dia\b/.test(text)) {
    hour = 12;
  } else if (/\bmeia[- ]noite\b/.test(text)) {
    hour = 0;
  } else {
    const hhmm = text.match(/(?:a[s]?\s*)?(\d{1,2})[:h](\d{2})\b/);
    if (hhmm) {
      hour = Number(hhmm[1]);
      minute = Number(hhmm[2]);
    } else {
      const hh = text.match(/(?:a[s]?\s*)?(\d{1,2})\s*(?:h(?:r|rs)?|horas)\b/);
      if (hh) {
        hour = Number(hh[1]);
        minute = 0;
      }
    }
  }

  if (hour === null || hour > 23 || minute > 59) return null;

  // --- Combina ------------------------------------------------------------
  let startMs: number;
  if (dayOffset !== null) {
    const targetDayMs = wallDayMs(today.y, today.m, today.d) + dayOffset * 86_400_000;
    const tw = toWall(targetDayMs);
    startMs = wallToMs(tw.y, tw.m, tw.d, hour, minute);
  } else if (explicitM !== today.m || explicitD !== today.d || explicitY !== today.y) {
    startMs = wallToMs(explicitY, explicitM, explicitD, hour, minute);
  } else {
    // Só hora informada: hoje se ainda for futuro, senão amanhã.
    startMs = wallToMs(today.y, today.m, today.d, hour, minute);
    if (startMs < nowMs) startMs += 86_400_000;
  }

  if (startMs < nowMs) return null;
  return new Date(startMs);
}

// ---------------------------------------------------------------------------
// Helpers pequenos
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
function clampPositive(n: number | undefined, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}
function clampNonNegative(n: number | undefined, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback;
}
