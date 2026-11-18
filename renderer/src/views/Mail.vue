<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, openExternal } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { useMail, SYSTEM_FOLDERS, CATEGORY_FOLDERS } from '../stores/mail.js';
import { fmtNumber, fmtTime } from '../lib/format.js';
import { fmtMailDate } from '../lib/mailFormat.js';
import Icon from '../components/Icon.vue';
import ThreadView from '../components/mail/ThreadView.vue';

const { t } = useI18n();
const app = useApp();
const mail = useMail();
const route = useRoute();
const router = useRouter();

const label = computed(() => String(route.params.label || 'INBOX'));
const openThread = computed(() => (route.query.thread ? String(route.query.thread) : null));

const PAGE = 50;
const list = ref({ total: 0, threads: [] });
const loading = ref(false);
const q = ref(String(route.query.q ?? ''));
const remote = ref(false); // Tüm Gmail araması sonuçları gösteriliyor
const remoteBusy = ref(false);
const olderBusy = ref(false);
const noOlder = ref(false);
const selected = ref(new Set());
const cursor = ref(-1); // klavye ile gezinme
const showCategories = ref(true);
const searchEl = ref(null);
const tv = ref(null);

mail.init();

// ------------------------------------------------------------ liste
async function load({ append = false } = {}) {
  if (!mail.ready) return;
  loading.value = true;
  try {
    const offset = append ? list.value.threads.length : 0;
    const p = new URLSearchParams({ label: label.value, q: q.value, offset, limit: PAGE });
    const r = await api.get(`/mail/threads?${p}`);
    list.value = append ? { total: r.total, threads: [...list.value.threads, ...r.threads] } : r;
  } catch (e) {
    app.fail(e);
  } finally {
    loading.value = false;
  }
}
/** Etiket değişikliğinden sonra listeyi kaydırma konumunu bozmadan tazeler. */
async function refreshList() {
  if (remote.value || !mail.ready) return;
  const limit = Math.max(PAGE, list.value.threads.length);
  const p = new URLSearchParams({ label: label.value, q: q.value, offset: 0, limit });
  try {
    list.value = await api.get(`/mail/threads?${p}`);
  } catch {
    /* sessiz */
  }
}

watch(label, () => {
  selected.value = new Set();
  remote.value = false;
  noOlder.value = false;
  cursor.value = -1;
  load();
});
let qTimer;
watch(q, () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    remote.value = false;
    load();
  }, 250);
});
watch(() => mail.ready, (r) => r && load());
onMounted(load);

let refreshTimer;
const off = mail.onEvent((e) => {
  if (e.type === 'mail:changed' || e.type === 'mail:sync') {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshList, 300);
  }
});
onBeforeUnmount(off);

function onScroll(e) {
  const el = e.target;
  if (!loading.value && !remote.value && list.value.threads.length < list.value.total && el.scrollTop + el.clientHeight > el.scrollHeight - 200) load({ append: true });
}

async function loadOlder() {
  olderBusy.value = true;
  try {
    const r = await api.post('/mail/threads/older', { label: label.value });
    if (!r.fetched) noOlder.value = true;
    await refreshList();
  } catch (e) {
    app.fail(e);
  } finally {
    olderBusy.value = false;
  }
}

async function searchGmail() {
  remoteBusy.value = true;
  try {
    list.value = await api.get(`/mail/search/remote?q=${encodeURIComponent(q.value)}`);
    remote.value = true;
  } catch (e) {
    app.fail(e);
  } finally {
    remoteBusy.value = false;
  }
}

// ------------------------------------------------------------ açma
function open(th) {
  // Taslaklar klasöründe yalnızca taslaktan oluşan bir konuşma → oluşturucuda aç
  if (label.value === 'DRAFT' && th.labels.includes('DRAFT') && th.count === 1) {
    return api
      .get(`/mail/threads/${th.id}`)
      .then((full) => {
        const m = full.messages[0];
        mail.compose({ mode: 'draft', messageId: m.id, draftId: m.draftId });
      })
      .catch(app.fail);
  }
  cursor.value = list.value.threads.findIndex((x) => x.id === th.id);
  th.unread = false;
  router.replace({ query: { ...route.query, thread: th.id } });
}
const closeThread = () => router.replace({ query: { ...route.query, thread: undefined } });

// ------------------------------------------------------------ işlemler
const ACTIONS = {
  archive: { remove: ['INBOX'], leaves: ['INBOX'] },
  inbox: { add: ['INBOX'] },
  spam: { add: ['SPAM'], remove: ['INBOX'], leaves: ['*'] },
  notspam: { add: ['INBOX'], remove: ['SPAM'], leaves: ['SPAM'] },
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'], leaves: ['STARRED'] },
  important: { add: ['IMPORTANT'] },
  unimportant: { remove: ['IMPORTANT'], leaves: ['IMPORTANT'] },
};

async function doAction({ action, threadIds, label: lbl }) {
  if (!threadIds.length) return;
  try {
    let leaves = false;
    if (action === 'trash' || action === 'untrash') {
      await api.post(`/mail/${action}`, { threadIds });
      leaves = action === 'trash' || label.value === 'TRASH';
    } else if (action === 'label' || action === 'unlabel') {
      await api.post('/mail/modify', { threadIds, [action === 'label' ? 'add' : 'remove']: [lbl] });
      leaves = action === 'unlabel' && label.value === lbl;
    } else {
      const a = ACTIONS[action];
      await api.post('/mail/modify', { threadIds, add: a.add ?? [], remove: a.remove ?? [] });
      leaves = a.leaves?.includes('*') || a.leaves?.includes(label.value);
    }
    if (leaves) {
      list.value.threads = list.value.threads.filter((x) => !threadIds.includes(x.id));
      list.value.total -= threadIds.length;
      if (openThread.value && threadIds.includes(openThread.value)) closeThread();
    }
    if (action === 'unread' && openThread.value && threadIds.includes(openThread.value)) closeThread();
    selected.value = new Set();
    refreshList();
  } catch (e) {
    app.fail(e);
  }
}

const sel = computed(() => [...selected.value]);
const allSelected = computed(() => list.value.threads.length > 0 && list.value.threads.every((x) => selected.value.has(x.id)));
function toggleSel(id) {
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
}
const toggleAll = () => (selected.value = allSelected.value ? new Set() : new Set(list.value.threads.map((x) => x.id)));
const selThreads = computed(() => list.value.threads.filter((x) => selected.value.has(x.id)));
const anyUnread = computed(() => selThreads.value.some((x) => x.unread));

function starToggle(th) {
  th.starred = !th.starred;
  doAction({ action: th.starred ? 'star' : 'unstar', threadIds: [th.id] });
}

// ------------------------------------------------------------ klasörler
const count = (f) => {
  if (!f.count) return 0;
  return mail.byId[f.id]?.[f.count] ?? 0;
};
const go = (id) => router.push({ path: `/mail/${id}` });

const statusText = computed(() => {
  const s = mail.status;
  if (!s) return '';
  if (s.throttledUntil && Date.parse(s.throttledUntil) > Date.now()) return t('mail.throttled', { time: fmtTime(s.throttledUntil) });
  if (s.phase === 'initial') return t('mail.syncProgress', { done: fmtNumber(s.done), total: fmtNumber(s.total) });
  if (s.phase === 'incremental') return t('mail.syncing');
  if (s.phase === 'error') return `${t('mail.syncError')}: ${s.error}`;
  const base = s.lastSyncAt ? t('mail.syncedAt', { time: fmtTime(s.lastSyncAt) }) : '';
  return s.pending ? `${base} · ${t('mail.pending', { n: fmtNumber(s.pending) })}` : base;
});

async function reconnect() {
  try {
    const { url } = await api.post('/auth/start');
    openExternal(url);
  } catch (e) {
    app.fail(e);
  }
}

const isSentView = computed(() => ['SENT', 'DRAFT'].includes(label.value));
const who = (th) => {
  if (isSentView.value) return `${t('mail.to')}: ${th.to.map((a) => a.name || a.email).join(', ') || '—'}`;
  return th.people.map((p) => (p === app.auth?.email ? t('mail.me') : p.split(' ')[0])).join(', ') || '—';
};
const chipLabels = (th) => mail.userLabels.filter((l) => th.labels.includes(l.id));

// ------------------------------------------------------------ klavye
function onKey(e) {
  if (e.target.closest?.('input, textarea, [contenteditable="true"], .composer')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const threads = list.value.threads;
  const current = openThread.value;
  const k = e.key;
  if (k === 'c') mail.compose({ mode: 'new' });
  else if (k === '/') {
    e.preventDefault();
    searchEl.value?.focus();
  } else if (k === 'j' || k === 'k') {
    const next = Math.max(0, Math.min(threads.length - 1, cursor.value + (k === 'j' ? 1 : -1)));
    if (threads[next]) open(threads[next]);
  } else if (current && k === 'e') doAction({ action: label.value === 'INBOX' ? 'archive' : 'inbox', threadIds: [current] });
  else if (current && k === '#') doAction({ action: 'trash', threadIds: [current] });
  else if (current && k === 's') {
    const th = threads.find((x) => x.id === current);
    if (th) starToggle(th);
  } else if (current && k === 'r') tv.value?.reply();
  else if (current && k === 'a') tv.value?.replyAll();
  else if (current && k === 'f') tv.value?.forward();
  else if (k === 'Escape' && current) closeThread();
  else return;
  e.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
watch(openThread, async () => {
  await nextTick();
  document.querySelector('.th.current')?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <div class="mailview">
    <!-- Klasörler -->
    <aside class="folders">
      <button class="btn primary compose" :disabled="!mail.ready" @click="mail.compose({ mode: 'new' })"><Icon name="pen" />{{ t('mail.compose') }}</button>
      <nav>
        <button
          v-for="f in SYSTEM_FOLDERS"
          :key="f.id"
          class="folder"
          :class="{ on: label === f.id, disabled: f.disabled }"
          :title="f.disabled ? t('mail.snoozedNote') : ''"
          :disabled="f.disabled"
          @click="go(f.id)"
        >
          <Icon :name="f.icon" :size="16" /><span class="truncate">{{ t(`mail.folders.${f.id}`) }}</span>
          <b v-if="count(f)" class="cnt">{{ fmtNumber(count(f)) }}</b>
        </button>
        <button class="group" @click="showCategories = !showCategories">
          <Icon :name="showCategories ? 'chevronDown' : 'chevronRight'" :size="13" />{{ t('mail.categories') }}
        </button>
        <template v-if="showCategories">
          <button v-for="f in CATEGORY_FOLDERS" :key="f.id" class="folder" :class="{ on: label === f.id }" @click="go(f.id)">
            <Icon name="tag" :size="15" /><span class="truncate">{{ t(`mail.folders.${f.id}`) }}</span>
            <b v-if="count(f)" class="cnt">{{ fmtNumber(count(f)) }}</b>
          </button>
        </template>
        <template v-if="mail.userLabels.length">
          <div class="group static">{{ t('mail.labels') }}</div>
          <button v-for="l in mail.userLabels" :key="l.id" class="folder" :class="{ on: label === l.id }" @click="go(l.id)">
            <span class="ldot" :style="{ background: l.color_bg || 'var(--text-3)' }" /><span class="truncate">{{ l.name }}</span>
            <b v-if="l.threads_unread" class="cnt">{{ fmtNumber(l.threads_unread) }}</b>
          </button>
        </template>
      </nav>
      <div class="syncbar small faint">
        <Icon v-if="mail.status?.phase === 'initial' || mail.status?.phase === 'incremental'" name="loader" :size="13" class="spin" />
        <span class="truncate spacer" :title="statusText">{{ statusText }}</span>
        <button class="btn ghost sm icon" :title="t('mail.refresh')" :disabled="!mail.ready" @click="mail.sync()"><Icon name="refresh" :size="14" /></button>
      </div>
    </aside>

    <!-- Bağlantı / izin durumu -->
    <div v-if="!app.auth?.connected" class="center-state">
      <div class="empty">
        <div class="icon-wrap"><Icon name="inbox" :size="24" /></div>
        <h3>{{ t('mail.notConnected') }}</h3>
        <RouterLink to="/account" class="btn primary">{{ t('account.connect') }}</RouterLink>
      </div>
    </div>
    <div v-else-if="!mail.ready" class="center-state">
      <div class="card card-pad reconnect">
        <div class="icon-wrap"><Icon name="key" :size="22" /></div>
        <h3>{{ t('mail.reconnectTitle') }}</h3>
        <p class="muted">{{ t('mail.reconnectText') }}</p>
        <button class="btn primary" @click="reconnect"><Icon name="refresh" />{{ t('mail.reconnect') }}</button>
      </div>
    </div>

    <template v-else>
      <!-- Liste -->
      <section class="listpane" :class="{ narrow: openThread }">
        <div class="searchbar">
          <input ref="searchEl" v-model="q" class="input" :placeholder="t('mail.search')" @keydown.esc="(q = ''), $event.target.blur()" @keydown.enter="q && searchGmail()" />
        </div>
        <div class="toolbar">
          <input type="checkbox" class="cb" :checked="allSelected" :title="t('mail.selectAll')" @change="toggleAll" />
          <template v-if="sel.length">
            <span class="small muted">{{ t('mail.selected', { n: sel.length }) }}</span>
            <button v-if="label === 'INBOX'" class="btn ghost sm icon" :title="t('mail.archive')" @click="doAction({ action: 'archive', threadIds: sel })"><Icon name="archive" /></button>
            <button v-if="label !== 'TRASH'" class="btn ghost sm icon" :title="t('mail.trash')" @click="doAction({ action: 'trash', threadIds: sel })"><Icon name="trash" /></button>
            <button v-else class="btn ghost sm icon" :title="t('mail.untrash')" @click="doAction({ action: 'untrash', threadIds: sel })"><Icon name="undoArrow" /></button>
            <button class="btn ghost sm icon" :title="label === 'SPAM' ? t('mail.notSpam') : t('mail.spam')" @click="doAction({ action: label === 'SPAM' ? 'notspam' : 'spam', threadIds: sel })"><Icon name="ban" /></button>
            <button class="btn ghost sm icon" :title="anyUnread ? t('mail.markRead') : t('mail.markUnread')" @click="doAction({ action: anyUnread ? 'read' : 'unread', threadIds: sel })"><Icon name="mailOpen" /></button>
            <button class="btn ghost sm icon" :title="t('mail.star')" @click="doAction({ action: 'star', threadIds: sel })"><Icon name="star" /></button>
          </template>
          <template v-else>
            <button class="btn ghost sm icon" :title="t('mail.refresh')" @click="mail.sync()"><Icon name="refresh" /></button>
          </template>
          <span class="spacer" />
          <span class="small faint num">{{ fmtNumber(list.total) }}</span>
        </div>

        <div v-if="q && !remote" class="searchnote small">
          <span class="faint">{{ t('mail.searchLocalNote') }}</span>
          <button class="linkish" :disabled="remoteBusy" @click="searchGmail">{{ remoteBusy ? t('mail.searchingGmail') : t('mail.searchGmail') }}</button>
        </div>

        <div class="threads" @scroll="onScroll">
          <div
            v-for="th in list.threads"
            :key="th.id"
            class="th"
            :class="{ unread: th.unread, current: th.id === openThread, sel: selected.has(th.id) }"
            @click="open(th)"
          >
            <input type="checkbox" class="cb" :checked="selected.has(th.id)" @click.stop @change="toggleSel(th.id)" />
            <button class="star" :class="{ on: th.starred }" @click.stop="starToggle(th)"><Icon name="star" :size="15" :filled="th.starred" /></button>
            <div class="th-main">
              <div class="row">
                <span class="who truncate">{{ who(th) }}</span>
                <span v-if="th.count > 1" class="faint small">{{ th.count }}</span>
                <span v-if="th.labels.includes('DRAFT') && !isSentView" class="draft small">{{ t('mail.draft') }}</span>
                <span class="spacer" />
                <Icon v-if="th.hasAttachments" name="clip" :size="13" class="faint" />
                <span class="date small">{{ fmtMailDate(th.date) }}</span>
              </div>
              <div class="row">
                <span class="subj truncate">{{ th.subject || '(—)' }}</span>
              </div>
              <div class="row">
                <span class="snip truncate faint small">{{ th.snippet }}</span>
                <span v-for="l in chipLabels(th)" :key="l.id" class="lchip" :style="{ background: l.color_bg, color: l.color_text }">{{ l.name }}</span>
              </div>
            </div>
          </div>

          <div v-if="!list.threads.length && !loading" class="empty small">{{ q ? t('mail.noResults') : t('mail.empty') }}</div>
          <div v-if="!remote && !q && list.threads.length >= list.total && label !== 'DRAFT'" class="older">
            <button v-if="!noOlder" class="btn sm" :disabled="olderBusy" @click="loadOlder">
              <Icon :name="olderBusy ? 'loader' : 'clock'" :class="{ spin: olderBusy }" :size="14" />{{ olderBusy ? t('mail.loadingOlder') : t('mail.loadOlder') }}
            </button>
            <span v-else class="small faint">{{ t('mail.noOlder') }}</span>
          </div>
        </div>
      </section>

      <!-- Okuma -->
      <section class="readpane">
        <ThreadView v-if="openThread" ref="tv" :key="openThread" :thread-id="openThread" :label="label" @close="closeThread" @action="doAction" />
        <div v-else class="center-state faint">
          <div class="empty">
            <div class="icon-wrap"><Icon name="mail" :size="24" /></div>
            <p>{{ t('mail.selectThread') }}</p>
            <p class="small faint" style="margin-top: 14px">{{ t('mail.shortcuts') }}</p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.mailview { display: grid; grid-template-columns: 212px minmax(300px, 380px) 1fr; height: 100vh; background: var(--surface); }
.folders { display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--bg); min-height: 0; }
.compose { margin: 14px 12px 10px; height: 40px; justify-content: flex-start; padding: 0 16px; border-radius: 12px; }
nav { flex: 1; overflow: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 1px; }
.folder { display: flex; align-items: center; gap: 10px; border: 0; background: none; color: var(--text); font: inherit; padding: 7px 10px; border-radius: 0 16px 16px 0; cursor: pointer; text-align: left; }
.folder:hover:not(:disabled) { background: var(--muted-soft); }
.folder.on { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.folder.disabled { opacity: 0.45; cursor: help; }
.folder .truncate { flex: 1; }
.cnt { font-size: 12px; font-variant-numeric: tabular-nums; }
.group { display: flex; align-items: center; gap: 6px; border: 0; background: none; color: var(--text-3); font: inherit; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; padding: 12px 10px 4px; cursor: pointer; text-align: left; }
.group.static { cursor: default; }
.ldot { width: 10px; height: 10px; border-radius: 3px; flex: none; margin: 0 3px; }
.syncbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); }
.listpane { display: flex; flex-direction: column; border-right: 1px solid var(--border); min-height: 0; min-width: 0; }
.searchbar { padding: 10px 12px 6px; }
.toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 12px 6px 16px; border-bottom: 1px solid var(--border); min-height: 40px; }
.cb { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; margin-right: 6px; flex: none; }
.searchnote { display: flex; gap: 8px; align-items: center; padding: 6px 16px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.linkish { border: 0; background: none; color: var(--accent-text); cursor: pointer; font: inherit; font-weight: 600; padding: 0; }
.threads { flex: 1; overflow: auto; }
.th { display: flex; align-items: flex-start; gap: 2px; padding: 9px 12px 9px 16px; border-bottom: 1px solid var(--border); cursor: pointer; position: relative; }
.th:hover { background: var(--surface-2); }
.th.sel { background: var(--accent-soft); }
.th.current { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.th .cb { margin-top: 3px; }
.star { border: 0; background: none; padding: 1px 4px 0 0; color: var(--text-3); cursor: pointer; flex: none; }
.star.on { color: #e3a008; }
.th-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.th-main .row { gap: 6px; }
.who { font-size: 13.5px; }
.subj { font-size: 13px; color: var(--text); }
.th.unread .who, .th.unread .subj, .th.unread .date { font-weight: 700; }
.th:not(.unread) .who, .th:not(.unread) .subj { color: var(--text-2); }
.date { color: var(--text-3); white-space: nowrap; }
.th.unread .date { color: var(--text); }
.snip { flex: 1; }
.draft { color: var(--err); font-weight: 600; }
.lchip { font-size: 11px; padding: 0 6px; border-radius: 4px; background: var(--muted-soft); white-space: nowrap; max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
.older { padding: 14px; display: flex; justify-content: center; }
.readpane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.center-state { display: grid; place-items: center; height: 100%; grid-column: span 2; }
.readpane .center-state { grid-column: auto; }
.reconnect { max-width: 460px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.reconnect .icon-wrap, .empty .icon-wrap { width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); margin: 0 auto 6px; }
@media (max-width: 1250px) {
  .mailview { grid-template-columns: 190px minmax(280px, 330px) 1fr; }
}
</style>
