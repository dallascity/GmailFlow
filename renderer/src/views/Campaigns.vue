<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { confirm } from '../lib/confirm.js';
import { fmtNumber, fmtDate } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import StatusBadge from '../components/StatusBadge.vue';

const { t } = useI18n();
const store = useApp();
const router = useRouter();
const route = useRoute();

const campaigns = ref(null);
const lists = ref([]);
const creating = ref(route.query.new === '1');
const form = ref({ name: '', list_id: '' });

async function load() {
  try {
    [campaigns.value, lists.value] = await Promise.all([api.get('/campaigns'), api.get('/lists')]);
    if (!form.value.list_id && lists.value.length) form.value.list_id = lists.value[0].id;
  } catch (e) {
    store.fail(e);
  }
}
onMounted(load);

const off = store.onEvent((e) => {
  if (e.type !== 'campaign' || !campaigns.value) return;
  const c = campaigns.value.find((x) => x.id === e.campaign.id);
  if (c) Object.assign(c, e.campaign);
});
onBeforeUnmount(off);

const open = (c) => router.push(c.status === 'draft' ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`);

async function create() {
  try {
    const c = await api.post('/campaigns', { name: form.value.name, list_id: form.value.list_id || null });
    router.push(`/campaigns/${c.id}/edit`);
  } catch (e) {
    store.fail(e);
  }
}

async function duplicate(c) {
  try {
    const n = await api.post(`/campaigns/${c.id}/duplicate`);
    store.toast(t('campaigns.duplicated'));
    router.push(`/campaigns/${n.id}/edit`);
  } catch (e) {
    store.fail(e);
  }
}

async function remove(c) {
  if (!(await confirm({ message: t('campaigns.deleteConfirm', { name: c.name }), confirmText: t('common.delete'), danger: true }))) return;
  try {
    await api.del(`/campaigns/${c.id}`);
    store.toast(t('campaigns.deleted'));
    load();
  } catch (e) {
    store.fail(e);
  }
}

const w = (c, k) => `${c.counts.total ? (c.counts[k] / c.counts.total) * 100 : 0}%`;
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ t('campaigns.title') }}</h1>
        <p class="sub">{{ t('campaigns.subtitle') }}</p>
      </div>
      <div class="actions">
        <button class="btn primary" @click="creating = true"><Icon name="plus" />{{ t('campaigns.new') }}</button>
      </div>
    </div>

    <div v-if="campaigns" class="card">
      <div v-if="!campaigns.length" class="empty">
        <div class="icon-wrap"><Icon name="send" :size="24" /></div>
        <h3>{{ t('campaigns.empty') }}</h3>
        <p>{{ t('campaigns.emptyHint') }}</p>
        <button class="btn primary" @click="creating = true"><Icon name="plus" />{{ t('campaigns.new') }}</button>
      </div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('campaigns.list') }}</th>
              <th>{{ t('campaigns.statusCol') }}</th>
              <th style="width: 260px">{{ t('campaigns.progress') }}</th>
              <th>{{ t('common.created') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in campaigns" :key="c.id" class="click" @click="open(c)">
              <td style="font-weight: 500">{{ c.name }}</td>
              <td class="muted small">{{ c.list?.name ?? '—' }}</td>
              <td><StatusBadge :status="c.status" /></td>
              <td>
                <template v-if="c.counts.total">
                  <div class="progress">
                    <span class="p-ok" :style="{ width: w(c, 'sent') }" />
                    <span class="p-err" :style="{ width: w(c, 'failed') }" />
                    <span class="p-skip" :style="{ width: w(c, 'skipped') }" />
                  </div>
                  <div class="small faint num" style="margin-top: 4px">
                    {{ fmtNumber(c.counts.sent) }} / {{ fmtNumber(c.counts.total) }}
                    <span v-if="c.counts.failed" style="color: var(--err)"> · {{ fmtNumber(c.counts.failed) }} {{ t('sendStatus.failed').toLowerCase() }}</span>
                  </div>
                </template>
                <span v-else-if="c.list" class="small faint">{{ t('campaigns.recipientsCount', { n: fmtNumber(c.list.valid) }) }}</span>
              </td>
              <td class="muted small nowrap">{{ fmtDate(c.created_at) }}</td>
              <td class="right nowrap" @click.stop>
                <button class="btn ghost sm icon" :title="t('campaigns.duplicate')" @click="duplicate(c)"><Icon name="copy" /></button>
                <button v-if="c.status !== 'running'" class="btn ghost sm icon danger" :title="t('common.delete')" @click="remove(c)"><Icon name="trash" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Modal v-if="creating" :title="t('campaigns.new')" @close="creating = false">
      <div class="stack">
        <div class="field">
          <label>{{ t('campaigns.name') }}</label>
          <input v-model="form.name" class="input" autofocus @keyup.enter="create" />
        </div>
        <div class="field">
          <label>{{ t('campaigns.list') }}</label>
          <select v-if="lists.length" v-model="form.list_id" class="select">
            <option v-for="l in lists" :key="l.id" :value="l.id">{{ l.name }} — {{ t('campaigns.recipientsCount', { n: fmtNumber(l.stats.valid) }) }}</option>
          </select>
          <div v-else class="alert info small">
            <Icon name="info" class="icon" />
            <span>{{ t('campaigns.noLists') }} <RouterLink to="/lists">{{ t('lists.import') }}</RouterLink></span>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="creating = false">{{ t('common.cancel') }}</button>
        <button class="btn primary" @click="create">{{ t('campaigns.create') }}</button>
      </template>
    </Modal>
  </div>
</template>
