<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { confirm } from '../lib/confirm.js';
import { fmtNumber, fmtDate } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import ImportDialog from '../components/ImportDialog.vue';

const { t } = useI18n();
const store = useApp();
const router = useRouter();
const lists = ref(null);
const importing = ref(false);

async function load() {
  try {
    lists.value = await api.get('/lists');
  } catch (e) {
    store.fail(e);
  }
}
onMounted(load);

function onSaved(list) {
  importing.value = false;
  router.push(`/lists/${list.id}`);
}

async function remove(list) {
  if (!(await confirm({ message: t('lists.deleteConfirm', { name: list.name }), confirmText: t('common.delete'), danger: true }))) return;
  try {
    await api.del(`/lists/${list.id}`);
    store.toast(t('lists.deleted'));
    load();
  } catch (e) {
    store.fail(e);
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ t('lists.title') }}</h1>
        <p class="sub">{{ t('lists.subtitle') }}</p>
      </div>
      <div class="actions">
        <button class="btn primary" @click="importing = true"><Icon name="upload" />{{ t('lists.import') }}</button>
      </div>
    </div>

    <div v-if="lists" class="card">
      <div v-if="!lists.length" class="empty">
        <div class="icon-wrap"><Icon name="sheet" :size="24" /></div>
        <h3>{{ t('lists.empty') }}</h3>
        <p>{{ t('lists.emptyHint') }}</p>
        <button class="btn primary" @click="importing = true"><Icon name="upload" />{{ t('lists.import') }}</button>
      </div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('lists.source') }}</th>
              <th class="right">{{ t('lists.valid') }}</th>
              <th class="right">{{ t('lists.invalid') }}</th>
              <th class="right">{{ t('lists.duplicates') }}</th>
              <th>{{ t('common.created') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in lists" :key="l.id" class="click" @click="router.push(`/lists/${l.id}`)">
              <td style="font-weight: 500">{{ l.name }}</td>
              <td class="muted small">{{ l.source_file }}</td>
              <td class="right num" style="color: var(--ok); font-weight: 600">{{ fmtNumber(l.stats.valid) }}</td>
              <td class="right num" :style="{ color: l.stats.invalid ? 'var(--err)' : '' }">{{ fmtNumber(l.stats.invalid) }}</td>
              <td class="right num muted">{{ fmtNumber(l.stats.duplicates) }}</td>
              <td class="muted small nowrap">{{ fmtDate(l.created_at) }}</td>
              <td class="right" @click.stop>
                <button class="btn ghost sm icon danger" :title="t('common.delete')" @click="remove(l)"><Icon name="trash" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <ImportDialog v-if="importing" @close="importing = false" @saved="onSaved" />
  </div>
</template>
