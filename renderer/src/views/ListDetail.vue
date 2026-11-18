<script setup>
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, download } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { fmtNumber } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';

const props = defineProps({ id: String });
const { t } = useI18n();
const store = useApp();
const router = useRouter();

const list = ref(null);
const tab = ref('1');
const q = ref('');
const page = ref(0);
const data = ref({ total: 0, rows: [] });
const PAGE = 100;
const renaming = ref(false);
const newName = ref('');

async function loadList() {
  try {
    list.value = await api.get(`/lists/${props.id}`);
  } catch (e) {
    store.fail(e);
    router.replace('/lists');
  }
}
async function loadRows() {
  try {
    const params = new URLSearchParams({ valid: tab.value, q: q.value, offset: page.value * PAGE, limit: PAGE });
    data.value = await api.get(`/lists/${props.id}/recipients?${params}`);
  } catch (e) {
    store.fail(e);
  }
}
onMounted(() => {
  loadList();
  loadRows();
});
let debounce;
watch(q, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    page.value = 0;
    loadRows();
  }, 250);
});
watch([tab, page], loadRows);

async function rename() {
  try {
    list.value = await api.patch(`/lists/${props.id}`, { name: newName.value });
    renaming.value = false;
  } catch (e) {
    store.fail(e);
  }
}

async function createCampaign() {
  try {
    const c = await api.post('/campaigns', { name: list.value.name, list_id: list.value.id });
    router.push(`/campaigns/${c.id}/edit`);
  } catch (e) {
    store.fail(e);
  }
}

const adding = ref(false);
const addText = ref('');
const addBusy = ref(false);
async function addRecipients() {
  addBusy.value = true;
  try {
    const r = await api.post(`/lists/${props.id}/recipients`, { text: addText.value });
    list.value = r.list;
    store.toast(t('lists.addResult', { added: r.added, duplicates: r.duplicates, invalid: r.invalid }), r.added ? 'ok' : 'warn');
    adding.value = false;
    addText.value = '';
    loadRows();
  } catch (e) {
    store.fail(e);
  } finally {
    addBusy.value = false;
  }
}

const tag = (k) => `{{${k}}}`;
const exportRows = () => download(`/lists/${props.id}/export?valid=${tab.value}`).catch(store.fail);
</script>

<template>
  <div v-if="list" class="page">
    <div class="page-head">
      <div>
        <RouterLink to="/lists" class="small row" style="margin-bottom: 6px"><Icon name="chevronLeft" :size="14" />{{ t('lists.title') }}</RouterLink>
        <div v-if="!renaming" class="row">
          <h1>{{ list.name }}</h1>
          <button class="btn ghost sm icon" :title="t('lists.rename')" @click="(renaming = true), (newName = list.name)"><Icon name="edit" /></button>
        </div>
        <div v-else class="row">
          <input v-model="newName" class="input" style="width: 320px" @keyup.enter="rename" />
          <button class="btn primary sm" @click="rename">{{ t('common.save') }}</button>
          <button class="btn sm" @click="renaming = false">{{ t('common.cancel') }}</button>
        </div>
        <p class="sub">{{ list.source_file }}</p>
      </div>
      <div class="actions">
        <button class="btn" @click="adding = true"><Icon name="plus" />{{ t('lists.addRecipients') }}</button>
        <button class="btn primary" @click="createCampaign"><Icon name="send" />{{ t('lists.newCampaign') }}</button>
      </div>
    </div>

    <div class="stack-lg">
      <div class="grid cols-4">
        <div class="card stat"><div class="label">{{ t('lists.valid') }}</div><div class="value" style="color: var(--ok)">{{ fmtNumber(list.stats.valid) }}</div></div>
        <div class="card stat"><div class="label">{{ t('lists.invalid') }}</div><div class="value" :style="{ color: list.stats.invalid ? 'var(--err)' : '' }">{{ fmtNumber(list.stats.invalid) }}</div></div>
        <div class="card stat"><div class="label">{{ t('lists.duplicates') }}</div><div class="value">{{ fmtNumber(list.stats.duplicates) }}</div></div>
        <div class="card stat"><div class="label">{{ t('lists.emptyRows') }}</div><div class="value">{{ fmtNumber(list.stats.empty) }}</div></div>
      </div>

      <div class="card card-pad">
        <h3>{{ t('lists.variables') }}</h3>
        <p class="small muted" style="margin: 4px 0 12px">{{ t('lists.variablesHint') }}</p>
        <div class="row wrap">
          <span v-for="(col, key) in list.variables" :key="key" class="chip static" :title="col">{{ tag(key) }}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="segmented">
            <button :class="{ on: tab === '1' }" @click="(tab = '1'), (page = 0)">{{ t('lists.validTab') }} ({{ fmtNumber(list.stats.valid) }})</button>
            <button :class="{ on: tab === '0' }" @click="(tab = '0'), (page = 0)">{{ t('lists.invalidTab') }} ({{ fmtNumber(list.stats.invalid) }})</button>
          </div>
          <div class="row">
            <input v-model="q" class="input" style="width: 240px" :placeholder="t('common.search')" />
            <button class="btn" @click="exportRows"><Icon name="download" />{{ t('common.export') }}</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height: 560px">
          <table class="table small">
            <thead>
              <tr>
                <th>{{ t('lists.row') }}</th>
                <th v-if="tab === '0'">{{ t('lists.reason') }}</th>
                <th v-for="c in list.columns" :key="c">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.rows" :key="r.id">
                <td class="faint num">{{ r.row_no }}</td>
                <td v-if="tab === '0'"><span class="badge err">{{ t(`invalidReason.${r.invalid_reason}`) }}</span></td>
                <td v-for="c in list.columns" :key="c" class="nowrap" :style="c === list.email_column ? 'font-weight:500' : ''">{{ r.data[c] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="data.total > PAGE" class="row pager">
          <span class="small muted">{{ t('common.showing', { from: page * PAGE + 1, to: Math.min(data.total, (page + 1) * PAGE), total: data.total }) }}</span>
          <span class="spacer" />
          <button class="btn sm" :disabled="page === 0" @click="page--"><Icon name="chevronLeft" /></button>
          <button class="btn sm" :disabled="(page + 1) * PAGE >= data.total" @click="page++"><Icon name="chevronRight" /></button>
        </div>
      </div>
    </div>

    <Modal v-if="adding" :title="t('lists.addTitle')" @close="adding = false">
      <div class="field">
        <textarea v-model="addText" class="input mono" rows="8" placeholder="a@gmail.com, b@gmail.com:c@firma.com" spellcheck="false" autofocus />
        <span class="small faint">{{ t('importer.pasteHint') }}</span>
      </div>
      <template #footer>
        <button class="btn" @click="adding = false">{{ t('common.cancel') }}</button>
        <button class="btn primary" :disabled="addBusy || !addText.includes('@')" @click="addRecipients">{{ t('lists.addButton') }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.pager { padding: 10px 16px; border-top: 1px solid var(--border); }
</style>
