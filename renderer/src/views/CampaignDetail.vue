<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, download } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { confirm } from '../lib/confirm.js';
import { fmtNumber, fmtDate, fmtTime, fmtDuration } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import StatusBadge from '../components/StatusBadge.vue';

const props = defineProps({ id: String });
const { t, te } = useI18n();
const store = useApp();
const router = useRouter();

const c = ref(null);
const filter = ref('');
const q = ref('');
const page = ref(0);
const PAGE = 100;
const sends = ref({ total: 0, rows: [] });
const unknown = ref([]);
const busy = ref(false);
const delay = ref(10);
const lastSentAt = ref(null);
const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 1000);

async function load() {
  try {
    const data = await api.get(`/campaigns/${props.id}`);
    if (data.status === 'draft') return router.replace(`/campaigns/${props.id}/edit`);
    c.value = data;
    delay.value = data.delay_sec;
  } catch (e) {
    store.fail(e);
    router.replace('/campaigns');
  }
}
async function loadSends() {
  try {
    const p = new URLSearchParams({ status: filter.value, q: q.value, offset: page.value * PAGE, limit: PAGE });
    sends.value = await api.get(`/campaigns/${props.id}/sends?${p}`);
    unknown.value = c.value?.counts.unknown ? (await api.get(`/campaigns/${props.id}/sends?status=unknown&limit=200`)).rows : [];
  } catch (e) {
    store.fail(e);
  }
}
onMounted(async () => {
  await load();
  loadSends();
});

let refreshTimer;
const off = store.onEvent((e) => {
  if (e.type === 'campaign' && e.campaign.id === Number(props.id) && c.value) {
    const wasUnknown = c.value.counts.unknown;
    Object.assign(c.value, e.campaign);
    if (e.campaign.counts.unknown !== wasUnknown) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(loadSends, 300);
    }
  }
  if (e.type === 'send' && e.send.campaign_id === Number(props.id)) {
    if (e.send.status === 'sent') lastSentAt.value = Date.now();
    const row = sends.value.rows.find((r) => r.id === e.send.id);
    if (row) Object.assign(row, e.send);
  }
});
onBeforeUnmount(() => {
  off();
  clearInterval(clock);
  clearTimeout(refreshTimer);
});

let debounce;
watch(q, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    page.value = 0;
    loadSends();
  }, 250);
});
watch([filter, page], loadSends);

const counts = computed(() => c.value?.counts ?? {});
const done = computed(() => counts.value.sent + counts.value.failed + counts.value.skipped + counts.value.unknown);
const pct = (n) => `${counts.value.total ? (n / counts.value.total) * 100 : 0}%`;
const eta = computed(() => (c.value ? (counts.value.pending + counts.value.sending) * (c.value.delay_sec + 1.5) : 0));
const nextIn = computed(() => {
  if (c.value?.status !== 'running' || !lastSentAt.value) return null;
  return Math.max(0, Math.ceil((lastSentAt.value + c.value.delay_sec * 1000 - now.value) / 1000));
});

async function act(action, confirmMsg) {
  if (confirmMsg && !(await confirm({ message: confirmMsg, confirmText: t('detail.cancel'), danger: true }))) return;
  busy.value = true;
  try {
    await api.post(`/campaigns/${props.id}/${action}`);
    await load();
  } catch (e) {
    store.fail(e);
  } finally {
    busy.value = false;
  }
}

async function saveDelay() {
  try {
    c.value = { ...c.value, ...(await api.put(`/campaigns/${props.id}`, { delay_sec: delay.value })) };
    delay.value = c.value.delay_sec;
    store.toast(t('detail.delayUpdated'), 'ok', 1800);
  } catch (e) {
    store.fail(e);
  }
}

async function retryFailed() {
  try {
    const r = await api.post(`/campaigns/${props.id}/retry-failed`);
    store.toast(t('detail.retried', { n: r.count }));
    await load();
    loadSends();
  } catch (e) {
    store.fail(e);
  }
}

async function resolve(row, action) {
  try {
    await api.post(`/campaigns/${props.id}/sends/${row.id}/resolve`, { action });
    await load();
    loadSends();
  } catch (e) {
    store.fail(e);
  }
}

async function duplicate() {
  try {
    const n = await api.post(`/campaigns/${props.id}/duplicate`);
    store.toast(t('campaigns.duplicated'));
    router.push(`/campaigns/${n.id}/edit`);
  } catch (e) {
    store.fail(e);
  }
}

async function remove() {
  if (!(await confirm({ message: t('campaigns.deleteConfirm', { name: c.value.name }), confirmText: t('common.delete'), danger: true }))) return;
  try {
    await api.del(`/campaigns/${props.id}`);
    router.replace('/campaigns');
  } catch (e) {
    store.fail(e);
  }
}

const exportCsv = (status = '') => download(`/campaigns/${props.id}/export${status ? `?status=${status}` : ''}`).catch(store.fail);
const errorText = (r) => (r.error_code && te(`skipReason.${r.error_code}`) ? t(`skipReason.${r.error_code}`) : r.error_message || r.error_code || '');
const filters = ['', 'pending', 'sent', 'failed', 'skipped', 'unknown', 'replied', 'bounced'];
const filterLabel = (f) => (!f ? t('detail.all') : ['replied', 'bounced'].includes(f) ? t(`detail.${f}`) : t(`sendStatus.${f}`));
const openReply = (r) => router.push({ path: '/mail/ALL', query: { thread: r.gmail_thread_id } });
</script>

<template>
  <div v-if="c" class="page">
    <div class="page-head">
      <div style="min-width: 0">
        <RouterLink to="/campaigns" class="small row" style="margin-bottom: 6px"><Icon name="chevronLeft" :size="14" />{{ t('campaigns.title') }}</RouterLink>
        <div class="row">
          <h1 class="truncate">{{ c.name }}</h1>
          <StatusBadge :status="c.status" />
        </div>
        <p class="sub">{{ c.list?.name }} · {{ c.subject }}</p>
      </div>
      <div class="actions">
        <button v-if="c.status === 'running'" class="btn" :disabled="busy" @click="act('pause')"><Icon name="pause" />{{ t('detail.pause') }}</button>
        <button v-if="c.status === 'paused'" class="btn primary" :disabled="busy" @click="act('start')"><Icon name="play" />{{ t('detail.resume') }}</button>
        <button v-if="['running', 'paused'].includes(c.status)" class="btn danger" :disabled="busy" @click="act('cancel', t('detail.cancelConfirm'))">
          <Icon name="stop" />{{ t('detail.cancel') }}
        </button>
        <button class="btn ghost icon" :title="t('campaigns.duplicate')" @click="duplicate"><Icon name="copy" /></button>
        <button v-if="c.status !== 'running'" class="btn ghost icon danger" :title="t('common.delete')" @click="remove"><Icon name="trash" /></button>
      </div>
    </div>

    <div class="stack-lg">
      <div v-if="c.status === 'paused' && c.pause_reason" class="alert" :class="c.pause_reason === 'user' || c.pause_reason === 'retry' ? 'info' : 'warn'">
        <Icon :name="c.pause_reason === 'user' ? 'pause' : 'alert'" class="icon" />
        <div class="spacer">
          <div>{{ t(`pauseReason.${c.pause_reason}`) }}</div>
          <div v-if="c.resume_after" class="small muted">{{ t('detail.resumeAfter') }}: <b>{{ fmtDate(c.resume_after) }}</b></div>
        </div>
        <RouterLink v-if="c.pause_reason === 'auth'" to="/account" class="btn sm">{{ t('account.reconnect') }}</RouterLink>
      </div>

      <div class="card card-pad">
        <div class="row" style="margin-bottom: 12px">
          <span class="big num">{{ fmtNumber(done) }}</span>
          <span class="muted num">/ {{ fmtNumber(counts.total) }}</span>
          <span class="spacer" />
          <span v-if="nextIn !== null && counts.pending" class="small muted row"><Icon name="clock" :size="14" />{{ t('detail.nextIn') }}: <b class="num">{{ nextIn }} {{ t('common.seconds') }}</b></span>
          <span v-if="['running', 'paused'].includes(c.status) && counts.pending" class="small muted" style="margin-left: 16px">
            {{ t('detail.eta') }}: <b>{{ fmtDuration(eta) }}</b>
          </span>
        </div>
        <div class="progress lg">
          <span class="p-ok" :style="{ width: pct(counts.sent) }" />
          <span class="p-err" :style="{ width: pct(counts.failed) }" />
          <span class="p-skip" :style="{ width: pct(counts.skipped) }" />
        </div>
        <div class="tiles">
          <div v-for="k in ['sent', 'failed', 'skipped', 'pending', 'unknown']" :key="k" class="tile" :class="k">
            <span class="small muted">{{ t(`sendStatus.${k}`) }}</span>
            <b class="num">{{ fmtNumber(counts[k] + (k === 'pending' ? counts.sending : 0)) }}</b>
          </div>
        </div>
        <div v-if="c.tracking && counts.sent" class="tiles track">
          <div class="tile replied" :title="t('detail.trackingHint')">
            <span class="small muted row"><Icon name="reply" :size="13" />{{ t('detail.replied') }}</span>
            <b class="num">{{ fmtNumber(c.tracking.replied) }}</b>
          </div>
          <div class="tile bounced" :title="t('detail.trackingHint')">
            <span class="small muted row"><Icon name="ban" :size="13" />{{ t('detail.bounced') }}</span>
            <b class="num">{{ fmtNumber(c.tracking.bounced) }}</b>
          </div>
          <div class="track-hint small faint">{{ store.auth?.mailReady ? t('detail.trackingHint') : t('mail.reconnectText') }}</div>
        </div>
        <div v-if="c.status === 'paused' || c.status === 'running'" class="row delay">
          <span class="small muted">{{ t('editor.delay') }}</span>
          <input v-model.number="delay" type="number" min="1" max="3600" class="input num" style="width: 90px; height: 30px" :disabled="c.status !== 'paused'" />
          <span class="small muted">{{ t('common.seconds') }}</span>
          <button v-if="c.status === 'paused' && delay !== c.delay_sec" class="btn sm" @click="saveDelay">{{ t('common.save') }}</button>
        </div>
      </div>

      <div v-if="unknown.length" class="card">
        <div class="card-head">
          <div>
            <h2 class="row"><Icon name="alert" style="color: var(--warn)" />{{ t('detail.unknownTitle') }}</h2>
            <div class="sub">{{ t('detail.unknownText') }}</div>
          </div>
        </div>
        <table class="table small">
          <tbody>
            <tr v-for="r in unknown" :key="r.id">
              <td style="font-weight: 500">{{ r.email }}</td>
              <td class="muted">{{ fmtDate(r.attempted_at) }}</td>
              <td class="muted">{{ errorText(r) }}</td>
              <td class="right nowrap">
                <button class="btn sm" @click="resolve(r, 'mark_sent')"><Icon name="check" />{{ t('detail.markSent') }}</button>
                <button class="btn sm" style="margin-left: 6px" @click="resolve(r, 'retry')"><Icon name="refresh" />{{ t('detail.retry') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="segmented">
            <button v-for="f in filters" :key="f" :class="{ on: filter === f }" @click="(filter = f), (page = 0)">
              {{ filterLabel(f) }}
            </button>
          </div>
          <div class="row">
            <input v-model="q" class="input" style="width: 200px" :placeholder="t('common.search')" />
            <button v-if="counts.failed && c.status !== 'running' && c.status !== 'cancelled'" class="btn" @click="retryFailed">
              <Icon name="refresh" />{{ t('detail.retryFailed', { n: counts.failed }) }}
            </button>
            <button class="btn" @click="exportCsv(filter)"><Icon name="download" />{{ t('common.export') }}</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height: 560px">
          <table class="table small">
            <thead>
              <tr>
                <th style="width: 60px">#</th>
                <th>{{ t('detail.email') }}</th>
                <th>{{ t('campaigns.statusCol') }}</th>
                <th>{{ t('detail.sentAt') }}</th>
                <th>{{ t('detail.error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in sends.rows" :key="r.id">
                <td class="faint num">{{ r.seq }}</td>
                <td style="font-weight: 500">{{ r.email }}</td>
                <td class="nowrap">
                  <StatusBadge :status="r.status" kind="send" />
                  <span v-if="r.bounced_at" class="badge err" style="margin-left: 4px" :title="r.bounce_reason">{{ t('detail.bouncedBadge') }}</span>
                  <button v-else-if="r.replied_at" class="badge ok reply-badge" :title="t('detail.openReply')" @click="openReply(r)">
                    <Icon name="reply" :size="11" />{{ t('detail.repliedBadge') }}
                  </button>
                </td>
                <td class="muted nowrap num">{{ r.sent_at ? fmtTime(r.sent_at) : r.attempted_at ? fmtTime(r.attempted_at) : '' }}</td>
                <td class="muted err-cell" :title="r.error_message">{{ errorText(r) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="sends.total > PAGE" class="row pager">
          <span class="small muted">{{ t('common.showing', { from: page * PAGE + 1, to: Math.min(sends.total, (page + 1) * PAGE), total: sends.total }) }}</span>
          <span class="spacer" />
          <button class="btn sm" :disabled="page === 0" @click="page--"><Icon name="chevronLeft" /></button>
          <button class="btn sm" :disabled="(page + 1) * PAGE >= sends.total" @click="page++"><Icon name="chevronRight" /></button>
        </div>
      </div>

      <div class="row small">
        <RouterLink :to="`/logs?campaign=${c.id}`" class="row"><Icon name="logs" :size="14" />{{ t('detail.viewLogs') }}</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.big { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
.tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 16px; }
.card-head { flex-wrap: wrap; }
.tiles.track { grid-template-columns: 1fr 1fr 3fr; margin-top: 10px; }
.track-hint { align-self: center; padding-left: 6px; }
.tile.replied b { color: var(--ok); }
.tile.bounced b { color: var(--err); }
.reply-badge { margin-left: 4px; border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; }
.reply-badge:hover { text-decoration: underline; }
.tile { display: flex; flex-direction: column; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); }
.tile b { font-size: 20px; }
.tile.sent b { color: var(--ok); }
.tile.failed b { color: var(--err); }
.tile.unknown b { color: var(--warn); }
.delay { margin-top: 14px; }
.pager { padding: 10px 16px; border-top: 1px solid var(--border); }
.err-cell { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
