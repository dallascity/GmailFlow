<script setup>
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, download } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { confirm } from '../lib/confirm.js';
import { fmtNumber, fmtDate } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';

const { t } = useI18n();
const store = useApp();
const router = useRouter();

const PAGE = 100;
const filter = reactive({ q: '', status: '', listId: '', sort: 'created' });
const page = ref(0);
const data = ref({ total: 0, rows: [] });
const stats = ref(null);
const lists = ref([]);
const loading = ref(false);

// Seçim: tek tek id'ler veya "filtreye uyan tümü"
const selected = ref(new Set());
const allMatching = ref(false);

const params = () => {
  const p = new URLSearchParams({ offset: page.value * PAGE, limit: PAGE, sort: filter.sort });
  if (filter.q) p.set('q', filter.q);
  if (filter.status) p.set('status', filter.status);
  if (filter.listId) p.set('listId', filter.listId);
  return p;
};

async function load() {
  loading.value = true;
  try {
    data.value = await api.get(`/contacts?${params()}`);
  } catch (e) {
    store.fail(e);
  } finally {
    loading.value = false;
  }
}
async function loadStats() {
  try {
    [stats.value, lists.value] = await Promise.all([api.get('/contacts/stats'), api.get('/lists')]);
  } catch (e) {
    store.fail(e);
  }
}
onMounted(() => {
  load();
  loadStats();
});

function clearSelection() {
  selected.value = new Set();
  allMatching.value = false;
}
let debounce;
watch(
  () => filter.q,
  () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      page.value = 0;
      clearSelection();
      load();
    }, 250);
  },
);
watch(
  () => [filter.status, filter.listId, filter.sort],
  () => {
    page.value = 0;
    clearSelection();
    load();
  },
);
watch(page, load);

// ---- seçim
const pageIds = computed(() => data.value.rows.map((r) => r.id));
const pageAllSelected = computed(() => pageIds.value.length > 0 && pageIds.value.every((id) => selected.value.has(id)));
const selectedCount = computed(() => (allMatching.value ? data.value.total : selected.value.size));
const isChecked = (id) => allMatching.value || selected.value.has(id);

function toggle(id) {
  if (allMatching.value) {
    // "tümü" modundan tek bir satır çıkarılırsa yalnızca bu sayfanın seçimine dönülür
    allMatching.value = false;
    selected.value = new Set(pageIds.value);
  }
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
}
function togglePage() {
  if (allMatching.value || pageAllSelected.value) return clearSelection();
  selected.value = new Set([...selected.value, ...pageIds.value]);
}
const selection = () => (allMatching.value ? { filter: { q: filter.q, status: filter.status, listId: filter.listId } } : { ids: [...selected.value] });

// ---- elle ekleme
const adding = ref(false);
const addText = ref('');
async function addContacts() {
  try {
    const r = await api.post('/contacts', { text: addText.value });
    store.toast(t('contacts.addResult', r), r.added ? 'ok' : 'warn');
    adding.value = false;
    addText.value = '';
    load();
    loadStats();
  } catch (e) {
    store.fail(e);
  }
}

// ---- listeye dönüştürme
const toList = reactive({ open: false, mode: 'new', name: '', listId: '', busy: false });
function openToList() {
  Object.assign(toList, { open: true, mode: 'new', name: '', listId: lists.value[0]?.id ?? '', busy: false });
}
async function submitToList() {
  toList.busy = true;
  try {
    const body = { ...selection(), ...(toList.mode === 'new' ? { name: toList.name } : { listId: toList.listId }) };
    const r = await api.post('/contacts/to-list', body);
    store.toast(
      toList.mode === 'new'
        ? t('contacts.listCreated', { name: r.list.name, n: fmtNumber(r.added) })
        : t('contacts.addedToList', { name: r.list.name, n: fmtNumber(r.added), d: fmtNumber(r.duplicates) }),
    );
    toList.open = false;
    router.push(`/lists/${r.list.id}`);
  } catch (e) {
    store.fail(e);
  } finally {
    toList.busy = false;
  }
}

async function removeSelected() {
  if (!(await confirm({ message: t('contacts.deleteConfirm', { n: fmtNumber(selectedCount.value) }), confirmText: t('common.delete'), danger: true }))) return;
  try {
    const r = await api.post('/contacts/delete', selection());
    store.toast(t('contacts.deleted', { n: fmtNumber(r.deleted) }));
    clearSelection();
    load();
    loadStats();
  } catch (e) {
    store.fail(e);
  }
}

// ---- isim düzenleme
const editing = ref(null);
const editName = ref('');
const editInput = ref(null);
function startEdit(row) {
  editing.value = row.id;
  editName.value = row.name ?? '';
  nextTick(() => {
    const el = editInput.value?.[0];
    el?.focus();
    el?.select();
  });
}
async function saveName(row) {
  if (editing.value !== row.id) return;
  editing.value = null;
  if ((row.name ?? '') === editName.value.trim()) return;
  try {
    Object.assign(row, await api.patch(`/contacts/${row.id}`, { name: editName.value }));
  } catch (e) {
    store.fail(e);
  }
}

const exportCsv = () => {
  const p = params();
  p.delete('offset');
  p.delete('limit');
  download(`/contacts/export?${p}`).catch(store.fail);
};

const statusTabs = computed(() => [
  { key: '', label: t('contacts.all'), n: stats.value?.total },
  { key: 'never_sent', label: t('contacts.neverSent'), n: stats.value?.never_sent },
  { key: 'sent', label: t('contacts.sent'), n: stats.value?.sent },
  { key: 'failed', label: t('contacts.failed'), n: stats.value?.failed },
  { key: 'replied', label: t('contacts.replied'), n: stats.value?.replied },
  { key: 'bounced', label: t('contacts.bounced'), n: stats.value?.bounced },
  { key: 'unsubscribed', label: t('contacts.unsubscribed'), n: stats.value?.unsubscribed },
  { key: 'suppressed', label: t('contacts.suppressedTab'), n: stats.value?.suppressed },
]);

async function setSuppressed(on) {
  try {
    const r = await api.post(on ? '/contacts/suppress' : '/contacts/unsuppress', selection());
    store.toast(t(on ? 'contacts.suppressedDone' : 'contacts.unsuppressedDone', { n: fmtNumber(r.count) }));
    clearSelection();
    load();
    loadStats();
  } catch (e) {
    store.fail(e);
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ t('contacts.title') }}</h1>
        <p class="sub">{{ t('contacts.subtitle') }}</p>
      </div>
      <div class="actions">
        <button class="btn" @click="exportCsv"><Icon name="download" />{{ t('common.export') }}</button>
        <button class="btn primary" @click="adding = true"><Icon name="plus" />{{ t('contacts.add') }}</button>
      </div>
    </div>

    <div class="stack-lg">
      <div class="card">
        <div class="card-head toolbar">
          <div class="segmented">
            <button v-for="s in statusTabs" :key="s.key" :class="{ on: filter.status === s.key }" @click="filter.status = s.key">
              {{ s.label }} <span v-if="s.n != null" class="count num">{{ fmtNumber(s.n) }}</span>
            </button>
          </div>
          <div class="row">
            <select v-model="filter.listId" class="select" style="width: 200px">
              <option value="">{{ t('contacts.allLists') }}</option>
              <option v-for="l in lists" :key="l.id" :value="String(l.id)">{{ l.name }}</option>
            </select>
            <select v-model="filter.sort" class="select" style="width: 170px">
              <option value="created">{{ t('contacts.sortNew') }}</option>
              <option value="email">{{ t('contacts.sortEmail') }}</option>
              <option value="name">{{ t('contacts.sortName') }}</option>
              <option value="last_sent">{{ t('contacts.sortLastSent') }}</option>
            </select>
            <input v-model="filter.q" class="input" style="width: 220px" :placeholder="t('contacts.search')" />
          </div>
        </div>

        <!-- Seçim çubuğu -->
        <div v-if="selectedCount" class="selbar">
          <b class="num">{{ t('contacts.selected', { n: fmtNumber(selectedCount) }) }}</b>
          <template v-if="!allMatching && pageAllSelected && data.total > data.rows.length">
            <span class="muted">·</span>
            <button class="linkish" @click="allMatching = true">{{ t('contacts.selectAllMatching', { n: fmtNumber(data.total) }) }}</button>
          </template>
          <span class="spacer" />
          <button class="btn sm primary" @click="openToList"><Icon name="list" :size="14" />{{ t('contacts.makeList') }}</button>
          <button v-if="filter.status !== 'suppressed'" class="btn sm" :title="t('contacts.suppressHint')" @click="setSuppressed(true)"><Icon name="ban" :size="14" />{{ t('contacts.suppress') }}</button>
          <button v-else class="btn sm" @click="setSuppressed(false)"><Icon name="check" :size="14" />{{ t('contacts.unsuppress') }}</button>
          <button class="btn sm danger" @click="removeSelected"><Icon name="trash" :size="14" />{{ t('common.delete') }}</button>
          <button class="btn sm ghost" @click="clearSelection">{{ t('contacts.clearSelection') }}</button>
        </div>

        <div v-if="!data.total && !loading" class="empty">
          <div class="icon-wrap"><Icon name="book" :size="24" /></div>
          <h3>{{ filter.q || filter.status || filter.listId ? t('contacts.noMatch') : t('contacts.empty') }}</h3>
          <p v-if="!(filter.q || filter.status || filter.listId)">{{ t('contacts.emptyHint') }}</p>
          <button v-if="!(filter.q || filter.status || filter.listId)" class="btn primary" @click="adding = true"><Icon name="plus" />{{ t('contacts.add') }}</button>
        </div>

        <div v-else class="table-wrap" style="max-height: calc(100vh - 330px)">
          <table class="table small">
            <thead>
              <tr>
                <th style="width: 36px"><input type="checkbox" class="cb" :checked="allMatching || pageAllSelected" @change="togglePage" /></th>
                <th>{{ t('detail.email') }}</th>
                <th>{{ t('contacts.name') }}</th>
                <th>{{ t('contacts.lists') }}</th>
                <th class="right">{{ t('contacts.sentCount') }}</th>
                <th>{{ t('contacts.lastSent') }}</th>
                <th>{{ t('contacts.added') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.rows" :key="r.id" :class="{ sel: isChecked(r.id) }" @click="toggle(r.id)">
                <td @click.stop><input type="checkbox" class="cb" :checked="isChecked(r.id)" @change="toggle(r.id)" /></td>
                <td style="font-weight: 500">
                  {{ r.email }}
                  <span v-if="r.suppressed" class="badge err" style="margin-left: 6px"><Icon name="ban" :size="11" />{{ t(`contacts.suppressedBadge.${r.suppressed}`) }}</span>
                  <span v-else-if="r.failed_count" class="badge err" style="margin-left: 6px">{{ t('contacts.failedBadge') }}</span>
                  <span v-if="r.replied_at" class="badge ok" style="margin-left: 6px"><Icon name="reply" :size="11" />{{ t('contacts.repliedBadge') }}</span>
                </td>
                <td class="name-cell" @click.stop="startEdit(r)">
                  <input
                    v-if="editing === r.id"
                    ref="editInput"
                    v-model="editName"
                    class="input"
                    style="height: 28px"
                    @keyup.enter="saveName(r)"
                    @keyup.esc="editing = null"
                    @blur="saveName(r)"
                  />
                  <span v-else-if="r.name">{{ r.name }}</span>
                  <span v-else class="faint add-name"><Icon name="edit" :size="12" /> {{ t('contacts.addName') }}</span>
                </td>
                <td>
                  <span v-for="l in r.lists.slice(0, 2)" :key="l.id" class="badge list-badge" :title="l.name" @click.stop="router.push(`/lists/${l.id}`)">{{ l.name }}</span>
                  <span v-if="r.lists.length > 2" class="faint small" :title="r.lists.map((l) => l.name).join(', ')"> +{{ r.lists.length - 2 }}</span>
                  <span v-if="!r.lists.length" class="faint">—</span>
                </td>
                <td class="right num">
                  <span v-if="r.sent_count" style="color: var(--ok); font-weight: 600">{{ fmtNumber(r.sent_count) }}</span>
                  <span v-else class="faint">0</span>
                </td>
                <td class="muted nowrap">{{ r.last_sent_at ? fmtDate(r.last_sent_at) : '—' }}</td>
                <td class="muted nowrap">
                  {{ fmtDate(r.created_at, { time: false }) }}
                  <span v-if="r.source === 'manual'" class="faint" :title="t('contacts.manual')"> · <Icon name="edit" :size="11" /></span>
                </td>
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

    <!-- Elle adres ekleme -->
    <Modal v-if="adding" :title="t('contacts.addTitle')" @close="adding = false">
      <div class="field">
        <textarea v-model="addText" class="input mono" rows="9" placeholder="a@gmail.com, b@gmail.com:c@firma.com" spellcheck="false" autofocus />
        <span class="small faint">{{ t('importer.pasteHint') }}</span>
      </div>
      <template #footer>
        <button class="btn" @click="adding = false">{{ t('common.cancel') }}</button>
        <button class="btn primary" :disabled="!addText.includes('@')" @click="addContacts">{{ t('contacts.addButton') }}</button>
      </template>
    </Modal>

    <!-- Seçilenlerden liste -->
    <Modal v-if="toList.open" :title="t('contacts.makeListTitle', { n: fmtNumber(selectedCount) })" width="480px" @close="toList.open = false">
      <div class="stack-lg">
        <label class="opt" :class="{ on: toList.mode === 'new' }">
          <input v-model="toList.mode" type="radio" value="new" />
          <div class="spacer stack" style="gap: 8px">
            <b>{{ t('contacts.newList') }}</b>
            <input v-if="toList.mode === 'new'" v-model="toList.name" class="input" :placeholder="t('contacts.newListPlaceholder')" @click.stop />
          </div>
        </label>
        <label class="opt" :class="{ on: toList.mode === 'existing' }" :style="!lists.length ? 'opacity:.5;pointer-events:none' : ''">
          <input v-model="toList.mode" type="radio" value="existing" :disabled="!lists.length" />
          <div class="spacer stack" style="gap: 8px">
            <b>{{ t('contacts.existingList') }}</b>
            <select v-if="toList.mode === 'existing'" v-model="toList.listId" class="select" @click.stop>
              <option v-for="l in lists" :key="l.id" :value="l.id">{{ l.name }} — {{ t('campaigns.recipientsCount', { n: fmtNumber(l.stats.valid) }) }}</option>
            </select>
            <span v-if="toList.mode === 'existing'" class="small faint">{{ t('contacts.existingHint') }}</span>
          </div>
        </label>
      </div>
      <template #footer>
        <button class="btn" @click="toList.open = false">{{ t('common.cancel') }}</button>
        <button class="btn primary" :disabled="toList.busy || (toList.mode === 'existing' && !toList.listId)" @click="submitToList">
          {{ toList.mode === 'new' ? t('contacts.createList') : t('contacts.addToList') }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.toolbar { flex-wrap: wrap; }
.count { margin-left: 4px; font-size: 11.5px; opacity: 0.75; }
.selbar { display: flex; align-items: center; gap: 10px; padding: 10px 20px; background: var(--accent-soft); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 2; }
.linkish { background: none; border: 0; padding: 0; color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; }
.cb { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; vertical-align: middle; }
tbody tr { cursor: pointer; }
tbody tr:hover td { background: var(--surface-2); }
tbody tr.sel td { background: color-mix(in srgb, var(--accent-soft) 65%, transparent); }
.name-cell { min-width: 160px; cursor: text; }
.add-name { opacity: 0; transition: opacity 0.1s; display: inline-flex; align-items: center; gap: 4px; }
tr:hover .add-name { opacity: 1; }
.list-badge { margin-right: 4px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; cursor: pointer; font-weight: 500; }
.list-badge:hover { background: var(--accent-soft); color: var(--accent-text); }
.pager { padding: 10px 16px; border-top: 1px solid var(--border); }
.opt { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: pointer; }
.opt.on { border-color: var(--accent); background: var(--accent-soft); }
.opt input[type='radio'] { margin-top: 3px; accent-color: var(--accent); }
</style>
