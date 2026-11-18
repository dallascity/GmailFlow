import { i18n } from '../i18n/index.js';

const loc = () => (i18n.global.locale.value === 'tr' ? 'tr-TR' : 'en-GB');

export const fmtNumber = (n) => new Intl.NumberFormat(loc()).format(n ?? 0);

export const fmtPercent = (v) => (v == null ? '—' : new Intl.NumberFormat(loc(), { style: 'percent', maximumFractionDigits: 1 }).format(v));

export function fmtDate(iso, { time = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  return new Intl.DateTimeFormat(loc(), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
}

export function fmtTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(loc(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
}

export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const tr = i18n.global.locale.value === 'tr';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const u = tr ? { h: 'sa', m: 'dk', s: 'sn' } : { h: 'h', m: 'min', s: 's' };
  if (h) return `${h} ${u.h} ${m} ${u.m}`;
  if (m) return `${m} ${u.m}${s ? ` ${s} ${u.s}` : ''}`;
  return `${s} ${u.s}`;
}

export const statusTone = {
  draft: '',
  running: 'accent',
  paused: 'warn',
  completed: 'ok',
  cancelled: '',
};

export const sendTone = {
  pending: '',
  sending: 'accent',
  sent: 'ok',
  failed: 'err',
  skipped: '',
  unknown: 'warn',
};
