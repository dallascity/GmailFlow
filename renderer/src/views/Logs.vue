<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { confirm } from '../lib/confirm.js';
import { fmtDate } from '../lib/format.js';
import Icon from '../components/Icon.vue';

const { t, te } = useI18n();
const store = useApp();
const route = useRoute();

const logs = ref([]);
const level = ref('');
const campaignId = ref(route.query.campaign ?? '');
const campaigns = ref([]);
const more = ref(false);
const LIMIT = 200;

async function load(append = false) {
  try {
    const p = new URLSearchParams({ limit: LIMIT });
    if (level.value) p.set('level', level.value);
    if (campaignId.value) p.set('campaignId', campaignId.value);
    if (append && logs.value.length) p.set('before', logs.value.at(-1).id);
    const rows = await api.get(`/logs?${p}`);
    logs.value = append ? [...logs.value, ...rows] : rows;
    more.value = rows.length === LIMIT;
  } catch (e) {
    store.fail(e);
  }
}
onMounted(async () => {
  load();
  campaigns.value = await api.get('/campaigns').catch(() => []);
});
watch([level, campaignId], () => load());

const off = store.onEvent((e) => {
  if (e.type !== 'log') return;
  const l = e.entry;
  if (level.value && l.level !== level.value) return;
  if (campaignId.value && String(l.campaign_id) !== String(campaignId.value)) return;
  l.campaign_name = campaigns.value.find((c) => c.id === l.campaign_id)?.name;
  logs.value.unshift(l);
});
onBeforeUnmount(off);

function describe(l) {
  const key = `logs.codes.${l.code}`;
  return l.code && te(key) ? t(key) : l.code ?? '';
}

async function clear() {
  if (!(await confirm({ message: t('logs.clearConfirm'), confirmText: t('logs.clear'), danger: true }))) return;
  await api.del('/logs').catch(store.fail);
  load();
}
const tone = { info: 'info', warn: 'warn', error: 'err' };
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ t('logs.title') }}</h1>
        <p class="sub">{{ t('logs.subtitle') }}</p>
      </div>
      <div class="actions">
        <select v-model="campaignId" class="select" style="width: 220px">
          <option value="">{{ t('logs.campaign') }}: {{ t('detail.all') }}</option>
          <option v-for="c in campaigns" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
        </select>
        <select v-model="level" class="select" style="width: 160px">
          <option value="">{{ t('logs.allLevels') }}</option>
          <option value="info">{{ t('logs.info') }}</option>
          <option value="warn">{{ t('logs.warn') }}</option>
          <option value="error">{{ t('logs.error') }}</option>
        </select>
        <button class="btn danger" @click="clear"><Icon name="trash" />{{ t('logs.clear') }}</button>
      </div>
    </div>

    <div class="card">
      <div v-if="!logs.length" class="empty">{{ t('logs.empty') }}</div>
      <div v-else class="table-wrap">
        <table class="table small">
          <thead>
            <tr>
              <th style="width: 170px">{{ t('logs.time') }}</th>
              <th style="width: 90px">{{ t('logs.level') }}</th>
              <th style="width: 200px">{{ t('logs.campaign') }}</th>
              <th>{{ t('logs.message') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id">
              <td class="muted nowrap num">{{ fmtDate(l.ts) }}</td>
              <td><span class="badge" :class="tone[l.level]">{{ t(`logs.${l.level}`) }}</span></td>
              <td class="truncate" style="max-width: 200px">
                <RouterLink v-if="l.campaign_id" :to="`/campaigns/${l.campaign_id}`">{{ l.campaign_name ?? `#${l.campaign_id}` }}</RouterLink>
              </td>
              <td>
                <div style="font-weight: 500">{{ describe(l) }}</div>
                <div v-if="l.message" class="msg mono faint">{{ l.message }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="more" class="row" style="justify-content: center; padding: 12px">
        <button class="btn sm" @click="load(true)">{{ t('logs.loadMore') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg { white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; font-size: 12px; margin-top: 2px; }
</style>
