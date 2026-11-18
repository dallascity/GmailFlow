import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, eventsUrl } from '../lib/api.js';
import { setLocale, errorMessage } from '../i18n/index.js';

export const useApp = defineStore('app', () => {
  const auth = ref(null);
  const settings = ref(null);
  const info = ref(null);
  const quota = ref(null);
  const toasts = ref([]);
  const listeners = new Set();
  let source = null;
  let toastId = 0;

  function toast(message, type = 'ok', timeout = 4000) {
    const id = ++toastId;
    toasts.value.push({ id, message, type });
    if (timeout) setTimeout(() => dismiss(id), timeout);
  }
  function dismiss(id) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }
  /** Bir API hatasını kullanıcıya bildirir. */
  function fail(err) {
    console.error(err);
    toast(errorMessage(err), 'err', 7000);
  }

  function applyTheme() {
    const pref = settings.value?.theme ?? 'system';
    const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  async function load() {
    const [a, s, i, q] = await Promise.all([api.get('/auth/status'), api.get('/settings'), api.get('/info'), api.get('/quota')]);
    auth.value = a;
    settings.value = s;
    info.value = i;
    quota.value = q;
    setLocale(s.language);
    applyTheme();
    connectEvents();
  }

  async function refreshAuth() {
    auth.value = await api.get('/auth/status');
  }

  async function saveSettings(patch) {
    settings.value = await api.put('/settings', patch);
    setLocale(settings.value.language);
    applyTheme();
    quota.value = await api.get('/quota');
  }

  function connectEvents() {
    if (source) return;
    source = new EventSource(eventsUrl());
    source.onmessage = (msg) => {
      let e;
      try {
        e = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (e.type === 'auth') auth.value = e.status;
      if (e.quota) quota.value = e.quota;
      for (const fn of listeners) fn(e);
    };
  }

  /** Sunucu olaylarına abone olur; aboneliği kaldıran fonksiyonu döner. */
  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { auth, settings, info, quota, toasts, toast, dismiss, fail, load, refreshAuth, saveSettings, onEvent };
});
