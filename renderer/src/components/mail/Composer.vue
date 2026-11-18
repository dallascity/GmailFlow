<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../lib/api.js';
import { useApp } from '../../stores/app.js';
import { useMail } from '../../stores/mail.js';
import { fmtBytes } from '../../lib/format.js';
import Icon from '../Icon.vue';
import RichEditor from '../RichEditor.vue';
import RecipientInput from './RecipientInput.vue';
import MessageFrame from './MessageFrame.vue';

const props = defineProps({ composer: { type: Object, required: true } });
const { t } = useI18n();
const app = useApp();
const mail = useMail();

const init = props.composer.init;
const f = reactive({
  to: init.to ?? [],
  cc: init.cc ?? [],
  bcc: init.bcc ?? [],
  subject: init.subject ?? '',
  html: '',
  uploads: [], // { id, filename, size }
  forward: init.forward ?? [], // Gmail'de duran ekler (iletme / taslak)
});
const meta = reactive({
  draftId: init.draftId ?? null,
  threadId: init.threadId ?? null,
  inReplyTo: init.inReplyTo ?? null,
  references: init.references ?? null,
  quoteHtml: init.quoteHtml ?? '',
});
const showCc = ref(f.cc.length > 0);
const showBcc = ref(f.bcc.length > 0);
const showQuote = ref(false);
const big = ref(false);
const state = ref('idle'); // idle | saving | saved | sending
const uploading = ref(false);
const fileInput = ref(null);
const toInput = ref(null);
const editorRef = ref(null);
let ready = false;

const title = computed(() => f.subject || t('mail.composer.newMessage'));
const fullHtml = () => (meta.quoteHtml ? `${f.html}<br>${meta.quoteHtml}` : f.html);
const hasContent = () => Boolean(f.to.length || f.cc.length || f.subject.trim() || f.html.replace(/<[^>]+>/g, '').trim() || f.uploads.length);

onMounted(async () => {
  if (init.mode === 'draft' && init.messageId) {
    try {
      const d = await api.get(`/mail/drafts/by-message/${init.messageId}`);
      Object.assign(f, { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: d.html, forward: d.forward });
      Object.assign(meta, { draftId: d.draftId, threadId: d.threadId, inReplyTo: d.inReplyTo, references: d.references });
      showCc.value = d.cc.length > 0;
      showBcc.value = d.bcc.length > 0;
    } catch (e) {
      app.fail(e);
    }
  } else {
    const sig = app.settings?.mail_signature;
    f.html = `<p></p>${sig ? `<p>--</p>${sig}` : ''}`;
    // Alıcı belliyse (yanıt) imleç metnin başına, değilse "Kime" alanına
    setTimeout(() => (f.to.length ? editorRef.value?.focus('start') : toInput.value?.focus()), 80);
  }
  setTimeout(() => (ready = true), 0);
});

// ---- otomatik taslak kaydı
let saveTimer;
let saving = null;
watch(
  f,
  () => {
    if (!ready) return;
    state.value = 'idle';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 2500);
  },
  { deep: true },
);

function payload() {
  return {
    to: f.to,
    cc: f.cc,
    bcc: f.bcc,
    subject: f.subject,
    html: fullHtml(),
    attachments: f.uploads.map((u) => u.id),
    forward: f.forward,
    threadId: meta.threadId,
    inReplyTo: meta.inReplyTo,
    references: meta.references,
    draftId: meta.draftId,
  };
}

async function saveDraft() {
  clearTimeout(saveTimer);
  if (!hasContent() || state.value === 'sending') return;
  if (saving) return saving;
  state.value = 'saving';
  saving = api
    .post('/mail/drafts', payload())
    .then((r) => {
      meta.draftId = r.draftId ?? meta.draftId;
      if (r.threadId && !meta.threadId) meta.threadId = r.threadId;
      state.value = 'saved';
    })
    .catch((e) => {
      state.value = 'idle';
      app.fail(e);
    })
    .finally(() => (saving = null));
  return saving;
}

async function send() {
  if (!f.to.length && !f.cc.length && !f.bcc.length) return app.toast(t('mail.composer.noRecipients'), 'warn');
  clearTimeout(saveTimer);
  if (saving) await saving;
  state.value = 'sending';
  try {
    await api.post('/mail/send', payload());
    app.toast(t('mail.composer.sent'));
    mail.closeComposer(props.composer.id);
  } catch (e) {
    state.value = 'idle';
    app.fail(e);
  }
}

async function discard() {
  clearTimeout(saveTimer);
  ready = false;
  if (saving) await saving.catch(() => {});
  try {
    if (meta.draftId) await api.del(`/mail/drafts/${meta.draftId}`);
    if (meta.draftId) app.toast(t('mail.composer.discarded'));
  } catch (e) {
    app.fail(e);
  }
  mail.closeComposer(props.composer.id);
}

async function close() {
  if (hasContent() && state.value !== 'saved') {
    await saveDraft();
    app.toast(t('mail.composer.draftSaved'), 'ok', 2000);
  }
  mail.closeComposer(props.composer.id);
}

async function upload(files) {
  uploading.value = true;
  try {
    for (const file of files) f.uploads.push(await api.upload('/mail/compose/attachments', file));
  } catch (e) {
    app.fail(e);
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

function onKey(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="composer" :class="{ min: composer.minimized, big }" @keydown="onKey">
    <header @click="composer.minimized = !composer.minimized">
      <span class="truncate">{{ title }}</span>
      <span class="spacer" />
      <button class="hb" :title="t('mail.composer.minimize')" @click.stop="composer.minimized = !composer.minimized"><Icon name="minimize" :size="15" /></button>
      <button class="hb" :title="t('mail.composer.maximize')" @click.stop="(big = !big), (composer.minimized = false)"><Icon name="maximize" :size="14" /></button>
      <button class="hb" :title="t('mail.composer.close')" @click.stop="close"><Icon name="x" :size="15" /></button>
    </header>

    <div v-show="!composer.minimized" class="body">
      <div class="fields">
        <div class="row-to">
          <RecipientInput ref="toInput" v-model="f.to" :label="t('mail.to')" :placeholder="t('mail.composer.recipientsPlaceholder')" />
          <div class="ccbcc">
            <button v-if="!showCc" @click="showCc = true">{{ t('mail.composer.addCc') }}</button>
            <button v-if="!showBcc" @click="showBcc = true">{{ t('mail.composer.addBcc') }}</button>
          </div>
        </div>
        <RecipientInput v-if="showCc" v-model="f.cc" :label="t('mail.cc')" />
        <RecipientInput v-if="showBcc" v-model="f.bcc" :label="t('mail.bcc')" />
        <input v-model="f.subject" class="subject" :placeholder="t('mail.composer.subject')" />
      </div>

      <div class="editor">
        <RichEditor ref="editorRef" v-model="f.html" />
        <div v-if="meta.quoteHtml" class="quote">
          <button class="dots" @click="showQuote = !showQuote">•••</button>
          <MessageFrame v-if="showQuote" :html="`<!doctype html><html><head><meta charset='utf-8'></head><body style='font-family:Segoe UI,Arial,sans-serif;font-size:14px'>${meta.quoteHtml}</body></html>`" />
        </div>
      </div>

      <div v-if="f.uploads.length || f.forward.length" class="atts">
        <span v-for="(u, i) in f.uploads" :key="u.id" class="att">
          <Icon name="clip" :size="13" /><span class="truncate">{{ u.filename }}</span><span class="faint">{{ fmtBytes(u.size) }}</span>
          <button @click="f.uploads.splice(i, 1)">×</button>
        </span>
        <span v-for="(a, i) in f.forward" :key="a.attachmentId" class="att">
          <Icon name="clip" :size="13" /><span class="truncate">{{ a.filename }}</span><span class="faint">{{ fmtBytes(a.size) }}</span>
          <button @click="f.forward.splice(i, 1)">×</button>
        </span>
      </div>

      <footer>
        <button class="btn primary" :disabled="state === 'sending'" :title="t('mail.composer.shortcutHint')" @click="send">
          <Icon :name="state === 'sending' ? 'loader' : 'send'" :class="{ spin: state === 'sending' }" />
          {{ state === 'sending' ? t('mail.composer.sending') : t('mail.composer.send') }}
        </button>
        <button class="btn ghost icon" :title="t('mail.composer.attach')" :disabled="uploading" @click="fileInput.click()">
          <Icon :name="uploading ? 'loader' : 'clip'" :class="{ spin: uploading }" />
        </button>
        <input ref="fileInput" type="file" multiple hidden @change="upload([...$event.target.files])" />
        <span class="small faint">
          <template v-if="state === 'saving'">{{ t('mail.composer.draftSaving') }}</template>
          <template v-else-if="state === 'saved'">{{ t('mail.composer.draftSaved') }}</template>
        </span>
        <span class="spacer" />
        <button class="btn ghost icon danger" :title="t('mail.composer.discard')" @click="discard"><Icon name="trash" /></button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.composer { width: 560px; max-height: calc(100vh - 80px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 12px 12px 0 0; box-shadow: var(--shadow-lg); pointer-events: auto; overflow: hidden; }
.composer.big { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(1000px, calc(100vw - 80px)); height: calc(100vh - 100px); border-radius: 12px; z-index: 60; }
.composer.min { width: 300px; }
header { display: flex; align-items: center; gap: 4px; padding: 9px 10px 9px 16px; background: var(--sidebar); color: #fff; font-weight: 600; font-size: 13.5px; cursor: pointer; }
.hb { border: 0; background: none; color: #c6cbd9; width: 26px; height: 24px; border-radius: 5px; display: grid; place-items: center; cursor: pointer; }
.hb:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
.body { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.fields { padding: 0 16px; }
.row-to { position: relative; }
.ccbcc { position: absolute; right: 0; top: 8px; display: flex; gap: 8px; }
.ccbcc button { border: 0; background: none; color: var(--text-2); cursor: pointer; font: inherit; font-size: 13px; }
.ccbcc button:hover { text-decoration: underline; }
.subject { width: 100%; border: 0; border-bottom: 1px solid var(--border); padding: 10px 0; font: inherit; background: transparent; color: var(--text); outline: none; }
.editor { flex: 1; overflow: auto; padding: 8px 12px; min-height: 220px; }
.editor :deep(.rte) { border: 0; }
.editor :deep(.rte:focus-within) { outline: none; }
.editor :deep(.toolbar) { position: sticky; top: 0; z-index: 1; border-radius: 6px; border: 1px solid var(--border); }
.editor :deep(.tiptap) { min-height: 180px; max-height: none; padding: 10px 4px; }
.quote { padding: 0 4px 8px; }
.dots { border: 1px solid var(--border); background: var(--surface-2); border-radius: 6px; padding: 0 8px; cursor: pointer; color: var(--text-2); letter-spacing: 1px; margin-bottom: 6px; }
.atts { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 16px; border-top: 1px solid var(--border); }
.att { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12.5px; max-width: 260px; }
.att button { border: 0; background: none; cursor: pointer; color: var(--text-3); font-size: 15px; }
footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); }
</style>
