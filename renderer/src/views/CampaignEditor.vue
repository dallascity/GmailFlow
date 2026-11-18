<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { fmtNumber, fmtBytes, fmtDuration } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import RichEditor from '../components/RichEditor.vue';

const props = defineProps({ id: String });
const { t } = useI18n();
const store = useApp();
const router = useRouter();

const campaign = ref(null);
const lists = ref([]);
const form = reactive({ name: '', list_id: null, subject: '', body_html: '', body_text: '', format: 'html', delay_sec: 10, order_mode: 'list', skip_previously_sent: true, list_unsubscribe: true });
const attachments = ref([]);
const saveState = ref('saved'); // saved | dirty | saving
const htmlMode = ref('visual');
const lastFocus = ref('body');
const subjectEl = ref(null);
const bodyEl = ref(null);
const rte = ref(null);
const fileInput = ref(null);
const uploading = ref(false);
const preview = ref(null);
const previewIndex = ref(0);
const testing = ref(false);
const summary = ref(null);
const starting = ref(false);
let ready = false;

const tag = (k) => `{{${k}}}`;

async function load() {
  try {
    const [c, l] = await Promise.all([api.get(`/campaigns/${props.id}`), api.get('/lists')]);
    if (c.status !== 'draft') return router.replace(`/campaigns/${c.id}`);
    campaign.value = c;
    lists.value = l;
    for (const k of Object.keys(form)) form[k] = c[k];
    attachments.value = c.attachments;
    await nextTick();
    ready = true;
    refreshPreview();
  } catch (e) {
    store.fail(e);
    router.replace('/campaigns');
  }
}
onMounted(load);

// ---- otomatik kaydetme
let saveTimer;
let pendingSave = null;
watch(form, () => {
  if (!ready) return;
  saveState.value = 'dirty';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
  schedulePreview();
});
async function save() {
  clearTimeout(saveTimer);
  if (saveState.value === 'saved') return;
  saveState.value = 'saving';
  pendingSave = api.put(`/campaigns/${props.id}`, { ...form });
  try {
    const c = await pendingSave;
    campaign.value = { ...campaign.value, ...c };
    if (saveState.value === 'saving') saveState.value = 'saved';
  } catch (e) {
    saveState.value = 'dirty';
    store.fail(e);
  } finally {
    pendingSave = null;
  }
}
onBeforeUnmount(() => {
  if (saveState.value !== 'saved') save();
  clearTimeout(previewTimer);
});

// ---- değişkenler
const list = computed(() => lists.value.find((l) => l.id === form.list_id) ?? null);
const variables = computed(() => ({ ...(list.value?.variables ?? {}), email: 'E-posta / Email' }));
const usedUnknown = computed(() => {
  const known = new Set([...Object.keys(variables.value), 'eposta']);
  const text = `${form.subject} ${form.format === 'html' ? form.body_html : form.body_text}`;
  const found = [...text.matchAll(/\{\{\s*([\p{L}\p{N}_.-]+)\s*(?:\|[^}]*)?\}\}/gu)].map((m) => m[1].toLowerCase());
  return [...new Set(found)].filter((v) => !known.has(v));
});

function insertAtCursor(el, key, text) {
  const start = el.selectionStart ?? form[key].length;
  const end = el.selectionEnd ?? start;
  form[key] = form[key].slice(0, start) + text + form[key].slice(end);
  nextTick(() => {
    el.focus();
    el.setSelectionRange(start + text.length, start + text.length);
  });
}

function insertVar(k) {
  const text = tag(k);
  if (lastFocus.value === 'subject') return insertAtCursor(subjectEl.value, 'subject', text);
  if (form.format === 'text') return insertAtCursor(bodyEl.value, 'body_text', text);
  if (htmlMode.value === 'source') return insertAtCursor(bodyEl.value, 'body_html', text);
  rte.value?.insert(text);
}

function setFormat(f) {
  if (f === form.format) return;
  // Biçim değiştirirken içerik boşsa diğerinden basit bir dönüşüm yapılır.
  if (f === 'text' && !form.body_text.trim() && form.body_html) {
    const div = document.createElement('div');
    div.innerHTML = form.body_html.replace(/<\/(p|h\d|li|blockquote)>/g, '\n').replace(/<br\s*\/?>/g, '\n');
    form.body_text = div.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (f === 'html' && !form.body_html.trim() && form.body_text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    form.body_html = form.body_text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  }
  form.format = f;
}

// ---- ekler
const totalSize = computed(() => attachments.value.reduce((s, a) => s + a.size, 0));
async function upload(files) {
  uploading.value = true;
  try {
    for (const f of files) attachments.value = await api.upload(`/campaigns/${props.id}/attachments`, f);
  } catch (e) {
    store.fail(e);
  } finally {
    uploading.value = false;
    fileInput.value.value = '';
  }
}
async function removeAttachment(a) {
  try {
    attachments.value = await api.del(`/campaigns/${props.id}/attachments/${a.id}`);
  } catch (e) {
    store.fail(e);
  }
}

// ---- önizleme
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 450);
}
async function refreshPreview() {
  try {
    preview.value = await api.post(`/campaigns/${props.id}/preview`, {
      subject: form.subject,
      body_html: form.body_html,
      body_text: form.body_text,
      format: form.format,
      list_id: form.list_id,
      index: previewIndex.value,
    });
    previewIndex.value = preview.value.index;
  } catch {
    /* önizleme hatası sessizce yok sayılır */
  }
}
function step(d) {
  previewIndex.value = Math.max(0, Math.min((preview.value?.total ?? 1) - 1, previewIndex.value + d));
  refreshPreview();
}

// ---- test ve başlatma
const problems = computed(() => {
  const p = [];
  if (!store.auth?.connected) p.push(t('editor.notConnected'));
  if (!form.list_id) p.push(t('editor.noList'));
  if (!form.subject.trim()) p.push(t('editor.noSubject'));
  const body = form.format === 'html' ? form.body_html.replace(/<[^>]+>/g, '').trim() : form.body_text.trim();
  if (!body) p.push(t('editor.noBody'));
  return p;
});

async function sendTest() {
  testing.value = true;
  try {
    await save();
    const r = await api.post(`/campaigns/${props.id}/test`);
    store.toast(t('editor.testSent', { to: r.to }));
  } catch (e) {
    store.fail(e);
  } finally {
    testing.value = false;
  }
}

async function openStart() {
  try {
    await save();
    if (pendingSave) await pendingSave;
    summary.value = await api.get(`/campaigns/${props.id}/summary`);
  } catch (e) {
    store.fail(e);
  }
}
async function start() {
  starting.value = true;
  try {
    await api.post(`/campaigns/${props.id}/start`);
    router.push(`/campaigns/${props.id}`);
  } catch (e) {
    store.fail(e);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div v-if="campaign" class="page wide">
    <div class="page-head">
      <div style="flex: 1; min-width: 0">
        <RouterLink to="/campaigns" class="small row" style="margin-bottom: 6px"><Icon name="chevronLeft" :size="14" />{{ t('campaigns.title') }}</RouterLink>
        <input v-model="form.name" class="title-input" :placeholder="t('campaigns.name')" />
      </div>
      <div class="actions" style="align-items: center">
        <span class="small faint row save-state">
          <Icon :name="saveState === 'saved' ? 'check' : 'loader'" :size="14" :class="{ spin: saveState === 'saving' }" />
          {{ saveState === 'saved' ? t('common.saved') : t('common.saving') }}
        </span>
        <button class="btn" :disabled="testing || problems.length > 0" @click="sendTest">
          <Icon :name="testing ? 'loader' : 'mail'" :class="{ spin: testing }" />{{ t('editor.sendTest') }}
        </button>
        <button class="btn primary" :disabled="problems.length > 0" :title="problems.join('\n')" @click="openStart">
          <Icon name="send" />{{ t('editor.start') }}
        </button>
      </div>
    </div>

    <div v-if="problems.length" class="alert warn small" style="margin-bottom: 16px">
      <Icon name="alert" class="icon" />
      <span>{{ problems.join(' · ') }}</span>
      <RouterLink v-if="!store.auth?.connected" to="/account" class="btn sm" style="margin-left: auto">{{ t('account.connect') }}</RouterLink>
    </div>

    <div class="layout">
      <!-- Sol: içerik -->
      <div class="stack-lg">
        <div class="card card-pad stack-lg">
          <div class="field">
            <label>{{ t('campaigns.list') }}</label>
            <select v-model="form.list_id" class="select">
              <option :value="null" disabled>{{ t('campaigns.chooseList') }}</option>
              <option v-for="l in lists" :key="l.id" :value="l.id">{{ l.name }} — {{ t('campaigns.recipientsCount', { n: fmtNumber(l.stats.valid) }) }}</option>
            </select>
          </div>

          <div class="field">
            <label>{{ t('editor.subject') }}</label>
            <input ref="subjectEl" v-model="form.subject" class="input" :placeholder="t('editor.subjectPlaceholder')" maxlength="900" @focus="lastFocus = 'subject'" />
          </div>

          <div class="field">
            <div class="row">
              <label class="label">{{ t('editor.body') }}</label>
              <span class="spacer" />
              <button v-if="form.format === 'html'" class="btn ghost sm" @click="htmlMode = htmlMode === 'visual' ? 'source' : 'visual'">
                <Icon :name="htmlMode === 'visual' ? 'code' : 'eye'" :size="14" />{{ htmlMode === 'visual' ? t('editor.htmlSource') : t('editor.visual') }}
              </button>
              <div class="segmented">
                <button :class="{ on: form.format === 'html' }" @click="setFormat('html')">{{ t('editor.formatHtml') }}</button>
                <button :class="{ on: form.format === 'text' }" @click="setFormat('text')">{{ t('editor.formatText') }}</button>
              </div>
            </div>
            <div @focusin="lastFocus = 'body'">
              <RichEditor v-if="form.format === 'html' && htmlMode === 'visual'" ref="rte" v-model="form.body_html" />
              <template v-else-if="form.format === 'html'">
                <textarea ref="bodyEl" v-model="form.body_html" class="input mono" rows="16" spellcheck="false" />
                <span class="hint small faint">{{ t('editor.htmlSourceWarn') }}</span>
              </template>
              <textarea v-else ref="bodyEl" v-model="form.body_text" class="input" rows="16" />
            </div>
          </div>

          <div class="field">
            <label>{{ t('editor.variables') }}</label>
            <div class="row wrap">
              <button v-for="(col, key) in variables" :key="key" class="chip" :title="col" @mousedown.prevent @click="insertVar(key)">{{ tag(key) }}</button>
            </div>
            <span class="hint">
              {{ t('editor.variablesHint') }}
              <code class="example">{{ tag(`${Object.keys(variables)[0] ?? 'ad'}|…`) }}</code>
            </span>
            <div v-if="usedUnknown.length" class="alert warn small">
              <Icon name="alert" class="icon" />
              <span>{{ t('editor.unknownVars') }}: <code v-for="v in usedUnknown" :key="v" class="unk">{{ tag(v) }}</code></span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <h2>{{ t('editor.attachments') }}</h2>
              <div class="sub">{{ t('editor.attachmentsHint') }}</div>
            </div>
            <button class="btn" :disabled="uploading" @click="fileInput.click()">
              <Icon :name="uploading ? 'loader' : 'clip'" :class="{ spin: uploading }" />{{ t('editor.addAttachment') }}
            </button>
            <input
              ref="fileInput"
              type="file"
              multiple
              hidden
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.zip"
              @change="upload([...$event.target.files])"
            />
          </div>
          <div v-if="attachments.length" class="atts">
            <div v-for="a in attachments" :key="a.id" class="att">
              <Icon name="file" class="faint" />
              <span class="truncate spacer">{{ a.filename }}</span>
              <span class="small faint num">{{ fmtBytes(a.size) }}</span>
              <button class="btn ghost sm icon danger" @click="removeAttachment(a)"><Icon name="x" /></button>
            </div>
            <div class="small faint num" style="padding: 8px 20px">{{ fmtBytes(totalSize) }} / 25 MB</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>{{ t('editor.sending') }}</h2></div>
          <div class="card-body stack-lg">
            <div class="grid cols-2">
              <div class="field">
                <label>{{ t('editor.delay') }}</label>
                <div class="row">
                  <input v-model.number="form.delay_sec" type="number" min="1" max="3600" class="input num" style="width: 120px" />
                  <span class="muted">{{ t('common.seconds') }}</span>
                </div>
                <span class="hint">{{ t('editor.delayHint') }}</span>
              </div>
              <div class="field">
                <label>{{ t('editor.order') }}</label>
                <select v-model="form.order_mode" class="select">
                  <option value="list">{{ t('editor.orderList') }}</option>
                  <option value="alpha">{{ t('editor.orderAlpha') }}</option>
                  <option value="random">{{ t('editor.orderRandom') }}</option>
                </select>
              </div>
            </div>
            <label class="check">
              <input v-model="form.skip_previously_sent" type="checkbox" />
              <span>
                <b>{{ t('editor.skipPrev') }}</b>
                <div class="small faint">{{ t('editor.skipPrevHint') }}</div>
              </span>
            </label>
            <label class="check">
              <input v-model="form.list_unsubscribe" type="checkbox" />
              <span>
                <b>{{ t('editor.listUnsub') }}</b>
                <div class="small faint">{{ t('editor.listUnsubHint') }}</div>
              </span>
            </label>
          </div>
        </div>
      </div>

      <!-- Sağ: önizleme -->
      <div class="preview-col">
        <div class="card preview">
          <div class="card-head">
            <h2>{{ t('editor.preview') }}</h2>
            <div v-if="preview?.total" class="row">
              <button class="btn sm icon" :disabled="previewIndex === 0" @click="step(-1)"><Icon name="chevronLeft" /></button>
              <span class="small num muted">{{ previewIndex + 1 }} / {{ fmtNumber(preview.total) }}</span>
              <button class="btn sm icon" :disabled="previewIndex >= preview.total - 1" @click="step(1)"><Icon name="chevronRight" /></button>
            </div>
          </div>
          <div v-if="preview" class="meta">
            <div class="row"><span class="k">{{ t('editor.to') }}</span><span class="truncate">{{ preview.to }}</span></div>
            <div class="row"><span class="k">{{ t('editor.subject') }}</span><b class="truncate">{{ preview.subject || '—' }}</b></div>
            <div v-if="attachments.length" class="row"><span class="k"><Icon name="clip" :size="13" /></span><span class="small muted truncate">{{ attachments.map((a) => a.filename).join(', ') }}</span></div>
          </div>
          <div v-if="preview?.missing.length" class="alert warn small" style="margin: 0 16px 12px">
            <Icon name="alert" class="icon" />
            <span>{{ t('editor.missingVars') }}: <code v-for="v in preview.missing" :key="v" class="unk">{{ tag(v) }}</code></span>
          </div>
          <iframe v-if="preview?.html" class="frame" sandbox="" :srcdoc="preview.html" title="preview" />
          <pre v-else-if="preview" class="text-preview">{{ preview.text }}</pre>
        </div>
      </div>
    </div>

    <Modal v-if="summary" :title="t('editor.confirmTitle')" width="480px" @close="summary = null">
      <div class="stack-lg">
        <dl class="kv">
          <dt>{{ t('editor.confirmRecipients') }}</dt>
          <dd>{{ fmtNumber(summary.recipients) }}</dd>
          <template v-if="summary.duplicates">
            <dt>{{ t('editor.confirmDuplicates') }}</dt>
            <dd>−{{ fmtNumber(summary.duplicates) }}</dd>
          </template>
          <template v-if="summary.suppressed">
            <dt>{{ t('editor.confirmSuppressed') }}</dt>
            <dd>−{{ fmtNumber(summary.suppressed) }}</dd>
          </template>
          <template v-if="summary.previouslySent">
            <dt>{{ t('editor.confirmSkipped') }}</dt>
            <dd>−{{ fmtNumber(summary.previouslySent) }}</dd>
          </template>
          <dt>{{ t('editor.confirmToSend') }}</dt>
          <dd style="font-size: 16px">{{ fmtNumber(summary.toSend) }}</dd>
          <dt>{{ t('editor.confirmQuota') }}</dt>
          <dd>{{ fmtNumber(summary.quota.remaining) }} / {{ fmtNumber(summary.quota.limit) }}</dd>
          <dt>{{ t('editor.confirmDuration') }}</dt>
          <dd>≈ {{ fmtDuration(summary.estimatedSeconds) }}</dd>
        </dl>
        <div v-if="summary.toSend > summary.quota.remaining" class="alert warn small">
          <Icon name="alert" class="icon" /><span>{{ t('editor.confirmQuotaWarn') }}</span>
        </div>
        <div class="alert info small"><Icon name="info" class="icon" /><span>{{ t('editor.confirmNote') }}</span></div>
      </div>
      <template #footer>
        <button class="btn" @click="summary = null">{{ t('common.cancel') }}</button>
        <button class="btn primary" :disabled="starting || summary.toSend <= 0" @click="start"><Icon name="send" />{{ t('editor.start') }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.wide { max-width: 1440px; }
.title-input { font: inherit; font-size: 22px; font-weight: 600; border: 1px solid transparent; background: transparent; color: var(--text); padding: 2px 6px; margin-left: -7px; border-radius: 6px; width: 100%; max-width: 640px; letter-spacing: -0.01em; }
.title-input:hover { border-color: var(--border); }
.title-input:focus { outline: none; border-color: var(--accent); background: var(--surface); }
.save-state { margin-right: 6px; }
.layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.preview-col { position: sticky; top: 20px; }
.preview { display: flex; flex-direction: column; max-height: calc(100vh - 120px); overflow: hidden; }
.meta { padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--border); }
.meta .k { width: 64px; flex: none; color: var(--text-3); font-size: 12.5px; }
.frame { border: 0; width: 100%; flex: 1; min-height: 480px; background: #fff; }
.text-preview { margin: 0; padding: 16px; white-space: pre-wrap; font-family: var(--font); font-size: 14px; line-height: 1.6; flex: 1; overflow: auto; }
.atts { border-top: 0; }
.att { display: flex; align-items: center; gap: 10px; padding: 9px 20px; border-bottom: 1px solid var(--border); }
.unk { margin-left: 6px; }
.example { margin-left: 4px; }
.hint { color: var(--text-3); font-size: 12.5px; }
@media (max-width: 1150px) {
  .layout { grid-template-columns: 1fr; }
  .preview-col { position: static; }
}
</style>
