import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, isDesktop } from '../lib/api.js';
import { useApp } from './app.js';
import { i18n } from '../i18n/index.js';

export const SYSTEM_FOLDERS = [
  { id: 'INBOX', icon: 'inbox', count: 'threads_unread' },
  { id: 'STARRED', icon: 'star' },
  { id: 'SNOOZED', icon: 'clock', disabled: true },
  { id: 'IMPORTANT', icon: 'important' },
  { id: 'SENT', icon: 'send' },
  { id: 'DRAFT', icon: 'file', count: 'messages_total' },
  { id: 'ALL', icon: 'mail' },
  { id: 'SPAM', icon: 'alertCircle', count: 'messages_unread' },
  { id: 'TRASH', icon: 'trash' },
];
export const CATEGORY_FOLDERS = ['CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].map((id) => ({
  id,
  icon: 'tag',
  count: 'threads_unread',
}));

let composerSeq = 0;

export const useMail = defineStore('mail', () => {
  const app = useApp();
  const labels = ref([]);
  const status = ref(null);
  const composers = ref([]);
  const listeners = new Set();
  let labelTimer;
  let started = false;

  const ready = computed(() => Boolean(app.auth?.mailReady));
  const byId = computed(() => Object.fromEntries(labels.value.map((l) => [l.id, l])));
  const inboxUnread = computed(() => byId.value.INBOX?.threads_unread ?? 0);
  const userLabels = computed(() => labels.value.filter((l) => l.type === 'user'));

  async function loadLabels() {
    if (!ready.value) return;
    try {
      labels.value = await api.get('/mail/labels');
    } catch {
      /* sessiz */
    }
  }
  async function loadStatus() {
    try {
      status.value = await api.get('/mail/status');
    } catch {
      /* sessiz */
    }
  }

  async function sync(full = false) {
    try {
      status.value = await api.post('/mail/sync', { full });
      await loadLabels();
    } catch (e) {
      app.fail(e);
    }
  }

  function init() {
    if (started) return;
    started = true;
    loadStatus();
    loadLabels();
    app.onEvent((e) => {
      if (e.type === 'mail:sync') status.value = e.status;
      if (e.type === 'mail:changed' || e.type === 'mail:labels') {
        clearTimeout(labelTimer);
        labelTimer = setTimeout(loadLabels, 400);
      }
      if (e.type === 'auth') {
        loadStatus();
        loadLabels();
      }
      if (e.type === 'mail:new' && !isDesktop) {
        app.toast(i18n.global.t('mail.newMailToast', { from: e.message.from?.name || e.message.from?.email }), 'ok', 5000);
      }
      for (const fn of listeners) fn(e);
    });
  }

  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Oluşturucu açar. init: { mode: new|reply|replyAll|forward|draft, to, cc, bcc, subject, html, threadId, … } */
  function compose(init = {}) {
    // Aynı taslak zaten açıksa öne getir
    if (init.draftId) {
      const open = composers.value.find((c) => c.init.draftId === init.draftId);
      if (open) {
        open.minimized = false;
        return;
      }
    }
    if (composers.value.length >= 3) composers.value.shift();
    composers.value.push({ id: ++composerSeq, init, minimized: false });
  }
  function closeComposer(id) {
    composers.value = composers.value.filter((c) => c.id !== id);
  }

  return { labels, status, composers, ready, byId, inboxUnread, userLabels, loadLabels, loadStatus, sync, init, onEvent, compose, closeComposer };
});
