<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { fmtNumber, fmtPercent, fmtDate } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import DailyChart from '../components/DailyChart.vue';

const { t } = useI18n();
const store = useApp();
const router = useRouter();
const stats = ref(null);

async function load() {
  try {
    stats.value = await api.get('/stats');
  } catch (e) {
    store.fail(e);
  }
}

let timer;
const off = store.onEvent((e) => {
  if (e.type === 'campaign') {
    clearTimeout(timer);
    timer = setTimeout(load, 600);
  }
});
onMounted(load);
onBeforeUnmount(() => {
  off();
  clearTimeout(timer);
});

const steps = computed(() => [
  { done: store.auth?.connected, label: t('dashboard.stepConnect'), to: '/account' },
  { done: (stats.value?.totals.lists ?? 0) > 0, label: t('dashboard.stepImport'), to: '/lists' },
  { done: Object.values(stats.value?.campaigns ?? {}).reduce((a, b) => a + b, 0) > 0, label: t('dashboard.stepCampaign'), to: '/campaigns' },
]);
const showSetup = computed(() => stats.value && steps.value.some((s) => !s.done));
const quota = computed(() => store.quota ?? stats.value?.quota);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ t('dashboard.title') }}</h1>
        <p class="sub">{{ t('dashboard.subtitle') }}</p>
      </div>
      <div class="actions">
        <button class="btn primary" @click="router.push('/campaigns?new=1')"><Icon name="plus" />{{ t('campaigns.new') }}</button>
      </div>
    </div>

    <div v-if="stats" class="stack-lg">
      <div v-if="showSetup" class="card card-pad setup">
        <h2>{{ t('dashboard.gettingStarted') }}</h2>
        <div class="steps">
          <RouterLink v-for="(s, i) in steps" :key="i" :to="s.to" class="step" :class="{ done: s.done }">
            <span class="num-badge">
              <Icon v-if="s.done" name="check" :size="14" />
              <template v-else>{{ i + 1 }}</template>
            </span>
            <span>{{ s.label }}</span>
            <Icon name="chevronRight" class="faint" />
          </RouterLink>
        </div>
      </div>

      <div class="grid cols-3">
        <div class="card stat">
          <div class="label">{{ t('dashboard.sent') }}</div>
          <div class="value">{{ fmtNumber(stats.totals.sent) }}</div>
        </div>
        <div class="card stat">
          <div class="label">{{ t('dashboard.failed') }}</div>
          <div class="value" :style="{ color: stats.totals.failed ? 'var(--err)' : '' }">{{ fmtNumber(stats.totals.failed) }}</div>
        </div>
        <div class="card stat">
          <div class="label">{{ t('dashboard.successRate') }}</div>
          <div class="value">{{ fmtPercent(stats.successRate) }}</div>
        </div>
        <div class="card stat">
          <div class="label">{{ t('dashboard.replyRate') }}</div>
          <div class="value" :style="{ color: stats.tracking.replied ? 'var(--ok)' : '' }">{{ fmtPercent(stats.tracking.replyRate) }}</div>
          <div class="foot">{{ t('dashboard.replyHint', { n: fmtNumber(stats.tracking.replied) }) }}</div>
        </div>
        <div class="card stat">
          <div class="label">{{ t('dashboard.bounceRate') }}</div>
          <div class="value" :style="{ color: stats.tracking.bounced ? 'var(--err)' : '' }">{{ fmtPercent(stats.tracking.bounceRate) }}</div>
          <div class="foot">{{ t('dashboard.bounceHint', { n: fmtNumber(stats.tracking.bounced) }) }}</div>
        </div>
        <div v-if="quota" class="card stat">
          <div class="label">{{ t('dashboard.quotaToday') }}</div>
          <div class="value">{{ fmtNumber(quota.used) }}<span class="faint" style="font-size: 16px"> / {{ fmtNumber(quota.limit) }}</span></div>
          <div class="progress" style="margin-top: 8px">
            <span class="p-accent" :style="{ width: `${Math.min(100, (quota.used / quota.limit) * 100)}%` }" />
          </div>
          <div class="foot">{{ t('dashboard.quotaHint', { limit: quota.limit, google: quota.googleLimit }) }}</div>
        </div>
      </div>

      <div class="grid" style="grid-template-columns: 1.4fr 1fr">
        <div class="card">
          <div class="card-head"><h2>{{ t('dashboard.last14') }}</h2></div>
          <div class="card-body"><DailyChart :days="stats.daily" /></div>
        </div>
        <div class="card">
          <div class="card-head">
            <h2>{{ t('dashboard.recent') }}</h2>
            <RouterLink to="/campaigns" class="small">{{ t('dashboard.viewAll') }}</RouterLink>
          </div>
          <div v-if="!stats.recent.length" class="empty small">{{ t('dashboard.noCampaigns') }}</div>
          <div v-else class="recent">
            <RouterLink
              v-for="c in stats.recent"
              :key="c.id"
              :to="c.status === 'draft' ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`"
              class="recent-item"
            >
              <div class="row">
                <span class="truncate" style="font-weight: 500">{{ c.name }}</span>
                <span class="spacer" />
                <StatusBadge :status="c.status" />
              </div>
              <div class="row small faint">
                <span>{{ fmtDate(c.started_at ?? c.created_at) }}</span>
                <span class="spacer" />
                <span v-if="c.counts.total" class="num">{{ c.counts.sent }} / {{ c.counts.total }}</span>
              </div>
              <div v-if="c.counts.total" class="progress">
                <span class="p-ok" :style="{ width: `${(c.counts.sent / c.counts.total) * 100}%` }" />
                <span class="p-err" :style="{ width: `${(c.counts.failed / c.counts.total) * 100}%` }" />
                <span class="p-skip" :style="{ width: `${(c.counts.skipped / c.counts.total) * 100}%` }" />
              </div>
            </RouterLink>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup h2 { margin-bottom: 14px; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.step { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); text-decoration: none; }
.step:hover { border-color: var(--accent); text-decoration: none; }
.step > span:nth-child(2) { flex: 1; }
.num-badge { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); font-weight: 700; font-size: 13px; flex: none; }
.step.done { opacity: 0.65; }
.step.done .num-badge { background: var(--ok-soft); color: var(--ok); }
.recent { display: flex; flex-direction: column; }
.recent-item { display: flex; flex-direction: column; gap: 6px; padding: 12px 20px; border-bottom: 1px solid var(--border); color: var(--text); text-decoration: none; }
.recent-item:last-child { border-bottom: 0; }
.recent-item:hover { background: var(--surface-2); text-decoration: none; }
</style>
