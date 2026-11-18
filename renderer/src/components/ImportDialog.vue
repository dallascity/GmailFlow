<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { fmtNumber } from '../lib/format.js';
import Modal from './Modal.vue';
import Icon from './Icon.vue';

const emit = defineEmits(['close', 'saved']);
const { t, locale } = useI18n();
const store = useApp();

const step = ref('pick');
const dragging = ref(false);
const preview = ref(null);
const stats = ref(null);
const name = ref('');
const emailColumn = ref('');
const saving = ref(false);
const input = ref(null);
const mode = ref('file'); // file | paste
const pasteText = ref('');
const PASTE_PLACEHOLDER = 'ornek1@gmail.com, ornek2@gmail.com\nornek3@firma.com:ornek4@firma.com:';
// Sunucudaki ayrıştırmayla aynı kural: ayırıcılara göre böl, '@' içerenleri say.
const detected = computed(() => pasteText.value.split(/[\s,;:|<>"'()[\]]+/).filter((t) => t.includes('@')).length);

/** Excel'de doğrudan açılabilen örnek şablon (UTF-8 BOM + ';'). */
function downloadSample() {
  const tr = locale.value === 'tr';
  const rows = tr
    ? ['Ad Soyad;E-posta;Şirket;Şehir', 'Ayşe Yılmaz;ayse@ornek.com;Yılmaz Ltd;İstanbul', 'Mehmet Kaya;mehmet@firma.com.tr;Kaya AŞ;Ankara']
    : ['Name;Email;Company;City', 'Jane Doe;jane@example.com;Doe Ltd;London', 'John Smith;john@company.com;Smith Inc;Leeds'];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  a.download = t('importer.sampleFile');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function applyPreview(res) {
  preview.value = res;
  stats.value = res.preview;
  emailColumn.value = res.emailColumn;
  name.value = res.filename.replace(/\.(xlsx|csv|txt)$/i, '');
  step.value = 'review';
}

async function handlePaste() {
  step.value = 'reading';
  try {
    applyPreview(await api.post('/lists/paste', { text: pasteText.value }));
  } catch (e) {
    store.fail(e);
    step.value = 'pick';
  }
}

async function handleFile(file) {
  if (!file) return;
  step.value = 'reading';
  try {
    applyPreview(await api.upload('/lists/import', file));
  } catch (e) {
    store.fail(e);
    step.value = 'pick';
  }
}

function onDrop(e) {
  dragging.value = false;
  handleFile(e.dataTransfer.files?.[0]);
}

async function changeColumn() {
  try {
    stats.value = await api.post(`/lists/import/${preview.value.importId}/analyze`, { emailColumn: emailColumn.value });
  } catch (e) {
    store.fail(e);
  }
}

async function save() {
  saving.value = true;
  try {
    const list = await api.post('/lists', { importId: preview.value.importId, name: name.value, emailColumn: emailColumn.value });
    store.toast(t('importer.saved', { name: list.name }));
    emit('saved', list);
  } catch (e) {
    store.fail(e);
  } finally {
    saving.value = false;
  }
}

const statItems = computed(() =>
  stats.value
    ? [
        { label: t('lists.valid'), value: stats.value.valid, tone: 'ok' },
        { label: t('lists.invalid'), value: stats.value.invalid, tone: stats.value.invalid ? 'err' : '' },
        { label: t('lists.duplicates'), value: stats.value.duplicates, tone: stats.value.duplicates ? 'warn' : '' },
        { label: t('lists.emptyRows'), value: stats.value.empty, tone: '' },
      ]
    : [],
);
</script>

<template>
  <Modal :title="t('importer.title')" :width="step === 'review' ? '900px' : '560px'" @close="emit('close')">
    <div v-if="step !== 'review'" class="segmented mode">
      <button :class="{ on: mode === 'file' }" @click="mode = 'file'"><Icon name="sheet" :size="14" />{{ t('importer.fromFile') }}</button>
      <button :class="{ on: mode === 'paste' }" @click="mode = 'paste'"><Icon name="edit" :size="14" />{{ t('importer.fromPaste') }}</button>
    </div>

    <div v-if="step !== 'review' && mode === 'paste'" class="stack">
      <div class="field">
        <label>{{ t('importer.pasteLabel') }}</label>
        <textarea v-model="pasteText" class="input mono" rows="9" :placeholder="PASTE_PLACEHOLDER" spellcheck="false" autofocus />
        <span class="hint">{{ t('importer.pasteHint') }}</span>
      </div>
      <div class="row">
        <span class="small muted">{{ t('importer.detected', { n: fmtNumber(detected) }) }}</span>
        <span class="spacer" />
        <button class="btn primary" :disabled="!detected || step === 'reading'" @click="handlePaste">
          <Icon :name="step === 'reading' ? 'loader' : 'chevronRight'" :class="{ spin: step === 'reading' }" />{{ t('importer.continue') }}
        </button>
      </div>
    </div>

    <div
      v-else-if="step !== 'review'"
      class="drop"
      :class="{ dragging }"
      @click="input.click()"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <input ref="input" type="file" accept=".xlsx,.csv,.xls,.txt" hidden @change="handleFile($event.target.files[0])" />
      <div class="drop-icon">
        <Icon :name="step === 'reading' ? 'loader' : 'sheet'" :size="26" :class="{ spin: step === 'reading' }" />
      </div>
      <b>{{ step === 'reading' ? t('importer.reading') : t('importer.drop') }}</b>
      <span class="small faint">{{ t('importer.dropHint') }}</span>
    </div>

    <div v-if="step !== 'review' && mode === 'file'" class="format small">
      <div class="label" style="margin-bottom: 6px">{{ t('importer.formatTitle') }}</div>
      <ul>
        <li>{{ t('importer.format1') }}</li>
        <li>{{ t('importer.format2') }}</li>
        <li>{{ t('importer.format3') }}</li>
        <li>{{ t('importer.format4') }}</li>
      </ul>
      <table class="example">
        <tbody>
          <tr><th>{{ t('importer.exName') }}</th><th>{{ t('importer.exEmail') }}</th><th>{{ t('importer.exCompany') }}</th></tr>
          <tr><td>Ayşe Yılmaz</td><td>ayse@ornek.com</td><td>Yılmaz Ltd</td></tr>
          <tr><td>Mehmet Kaya</td><td>mehmet@firma.com.tr</td><td>Kaya AŞ</td></tr>
        </tbody>
      </table>
      <button class="btn sm" style="margin-top: 10px" @click.stop="downloadSample"><Icon name="download" :size="14" />{{ t('importer.downloadSample') }}</button>
    </div>

    <div v-if="step === 'review' && preview" class="stack-lg">
      <div class="grid cols-2">
        <div class="field">
          <label>{{ t('importer.listName') }}</label>
          <input v-model="name" class="input" />
        </div>
        <div class="field">
          <label>{{ t('importer.emailColumn') }}</label>
          <select v-model="emailColumn" class="select" @change="changeColumn">
            <option v-for="c in preview.columns" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>

      <div v-if="!preview.hasHeader" class="alert info small"><Icon name="info" class="icon" />{{ t('importer.noHeader') }}</div>

      <div class="stats">
        <div v-for="s in statItems" :key="s.label" class="mini" :class="s.tone">
          <span class="small muted">{{ s.label }}</span>
          <b class="num">{{ fmtNumber(s.value) }}</b>
        </div>
        <div class="mini">
          <span class="small muted">{{ t('common.total') }}</span>
          <b class="num">{{ fmtNumber(preview.rowCount) }}</b>
        </div>
      </div>

      <div>
        <div class="label" style="margin-bottom: 8px">{{ t('importer.sample') }}</div>
        <div class="card table-wrap sample">
          <table class="table small">
            <thead>
              <tr>
                <th v-for="c in preview.columns" :key="c" :class="{ hl: c === emailColumn }">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in preview.sample" :key="i">
                <td v-for="c in preview.columns" :key="c" class="nowrap" :class="{ hl: c === emailColumn }">{{ r[c] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <template v-if="step === 'review'" #footer>
      <button class="btn ghost" @click="step = 'pick'">{{ mode === 'paste' ? t('importer.back') : t('importer.changeFile') }}</button>
      <span class="spacer" />
      <span class="small muted" style="align-self: center">{{ t('importer.willImport', { n: fmtNumber(stats?.valid ?? 0) }) }}</span>
      <button class="btn primary" :disabled="saving || !stats?.valid" @click="save">{{ t('importer.save') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.format { margin-top: 14px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-2); }
.format ul { margin: 0 0 10px; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.example { border-collapse: collapse; font-size: 12px; }
.example th, .example td { border: 1px solid var(--border-strong); padding: 3px 9px; text-align: left; }
.example th { background: var(--accent-soft); color: var(--accent-text); }
.mode { margin-bottom: 16px; display: flex; }
.mode button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.hint { color: var(--text-3); font-size: 12.5px; }
.drop { border: 2px dashed var(--border-strong); border-radius: 12px; padding: 44px 20px; display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; text-align: center; transition: all 0.12s; }
.drop:hover, .drop.dragging { border-color: var(--accent); background: var(--accent-soft); }
.drop-icon { width: 56px; height: 56px; border-radius: 14px; background: var(--accent-soft); color: var(--accent-text); display: grid; place-items: center; margin-bottom: 8px; }
.stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
.mini { display: flex; flex-direction: column; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); }
.mini b { font-size: 20px; }
.mini.ok b { color: var(--ok); }
.mini.err b { color: var(--err); }
.mini.warn b { color: var(--warn); }
.sample { max-height: 300px; box-shadow: none; }
th.hl, td.hl { background: var(--accent-soft) !important; color: var(--accent-text); }
</style>
