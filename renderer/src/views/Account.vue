<script setup>
import { ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, openExternal } from '../lib/api.js';
import { useApp } from '../stores/app.js';
import { confirm } from '../lib/confirm.js';
import { fmtDate } from '../lib/format.js';
import Icon from '../components/Icon.vue';
import Avatar from '../components/Avatar.vue';

const { t } = useI18n();
const store = useApp();

const clientId = ref(store.auth?.clientId ?? '');
const clientSecret = ref('');
const savingClient = ref(false);
const waiting = ref(false);
const guideOpen = ref(!store.auth?.configured);
let poll = null;

const links = [
  'https://console.cloud.google.com/projectcreate',
  'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  'https://console.cloud.google.com/auth/branding',
  'https://console.cloud.google.com/auth/audience',
  'https://console.cloud.google.com/auth/clients',
  null,
];

async function saveClient(body = { clientId: clientId.value, clientSecret: clientSecret.value }, message = t('account.clientSaved')) {
  savingClient.value = true;
  try {
    store.auth = await api.put('/auth/config', body);
    clientId.value = store.auth.clientId;
    clientSecret.value = '';
    store.toast(message);
    guideOpen.value = false;
  } catch (e) {
    store.fail(e);
  } finally {
    savingClient.value = false;
  }
}

// Google'dan indirilen client_secret_….json dosyası: Client ID ve Secret dosyadan okunur
const jsonInput = ref(null);
async function loadJsonFile(file) {
  if (!file) return;
  const text = await file.text();
  jsonInput.value.value = '';
  await saveClient({ json: text }, t('account.jsonLoaded'));
}

// JSON'un tamamı Secret (veya ID) alanına yapıştırılırsa aynı şekilde çözülür
function onPasteJson(e) {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!text.trim().startsWith('{')) return;
  e.preventDefault();
  saveClient({ json: text }, t('account.jsonLoaded'));
}

async function connect() {
  try {
    const { url } = await api.post('/auth/start');
    openExternal(url);
    waiting.value = true;
    const until = Date.now() + 5 * 60 * 1000;
    clearInterval(poll);
    // SSE ile de bildirilir; yine de kısa aralıklı yoklama yedek olarak çalışır.
    poll = setInterval(async () => {
      if (Date.now() > until) stopWaiting();
      else await store.refreshAuth().catch(() => {});
    }, 2500);
  } catch (e) {
    store.fail(e);
  }
}

function stopWaiting() {
  waiting.value = false;
  clearInterval(poll);
}

const startEmail = store.auth?.connected ? store.auth.connectedAt : null;
watch(
  () => store.auth?.connectedAt,
  (v) => {
    if (waiting.value && v && v !== startEmail && store.auth.connected) {
      stopWaiting();
      store.toast(t('account.connectedToast', { email: store.auth.email }));
    }
  },
);
onBeforeUnmount(() => clearInterval(poll));

async function disconnect() {
  if (!(await confirm({ message: t('account.disconnectConfirm'), confirmText: t('account.disconnect'), danger: true }))) return;
  try {
    store.auth = await api.post('/auth/disconnect');
  } catch (e) {
    store.fail(e);
  }
}
</script>

<template>
  <div class="page narrow">
    <div class="page-head">
      <div>
        <h1>{{ t('account.title') }}</h1>
        <p class="sub">{{ t('account.subtitle') }}</p>
      </div>
    </div>

    <div class="stack-lg">
      <div v-if="store.auth?.connected && !store.auth?.mailReady" class="alert warn">
        <Icon name="key" class="icon" />
        <div class="spacer">
          <b>{{ t('mail.reconnectTitle') }}</b>
          <div class="small">{{ t('mail.reconnectText') }}</div>
        </div>
        <button class="btn sm primary" @click="connect">{{ t('mail.reconnect') }}</button>
      </div>

      <!-- Bağlantı durumu -->
      <div class="card card-pad">
        <div v-if="store.auth?.connected" class="row conn">
          <Avatar :email="store.auth.email" :name="store.auth.name" :size="52" />
          <div class="spacer">
            <div class="faint small">{{ t('account.connected') }}</div>
            <div v-if="store.auth.name" style="font-weight: 600; font-size: 16px">{{ store.auth.name }}</div>
            <div :style="store.auth.name ? 'color: var(--text-2)' : 'font-weight: 600; font-size: 16px'">{{ store.auth.email }}</div>
            <div class="faint small">{{ t('account.connectedAt') }}: {{ fmtDate(store.auth.connectedAt) }}</div>
            <div v-if="!store.auth.grantedScopes?.some((s) => s.endsWith('profile'))" class="faint small">{{ t('account.avatarHint') }}</div>
          </div>
          <button class="btn" @click="connect"><Icon name="refresh" />{{ t('account.reconnect') }}</button>
          <button class="btn danger" @click="disconnect"><Icon name="logout" />{{ t('account.disconnect') }}</button>
        </div>
        <div v-else class="row conn">
          <div class="avatar off"><Icon name="user" :size="20" /></div>
          <div class="spacer">
            <div style="font-weight: 600">{{ t('account.notConnected') }}</div>
            <div class="faint small">{{ t('account.scopesNote') }}</div>
          </div>
          <button class="btn primary lg" :disabled="!store.auth?.configured" @click="connect">
            <Icon name="key" />{{ t('account.connect') }}
          </button>
        </div>
        <div v-if="waiting" class="alert info" style="margin-top: 16px">
          <Icon name="loader" class="icon spin" />
          <div class="spacer">
            <b>{{ t('account.waiting') }}</b>
            <div class="small muted">{{ t('account.waitingHint') }}</div>
          </div>
          <button class="btn sm" @click="stopWaiting">{{ t('common.cancel') }}</button>
        </div>
      </div>

      <!-- OAuth istemcisi -->
      <div class="card">
        <div class="card-head">
          <div>
            <h2>{{ t('account.clientTitle') }}</h2>
            <div class="sub">{{ t('account.clientSubtitle') }}</div>
          </div>
        </div>
        <div class="card-body stack-lg">
          <div class="guide">
            <button class="guide-toggle" @click="guideOpen = !guideOpen">
              <Icon :name="guideOpen ? 'chevronDown' : 'chevronRight'" />
              <b>{{ t('account.guideTitle') }}</b>
            </button>
            <ol v-if="guideOpen" class="steps">
              <li v-for="(link, i) in links" :key="i">
                <span>{{ t(`account.guide${i + 1}`) }}</span>
                <a v-if="link" href="#" class="small nowrap" @click.prevent="openExternal(link)">
                  {{ t('account.openConsole') }} <Icon name="external" :size="12" />
                </a>
              </li>
            </ol>
            <div v-if="guideOpen" class="alert info small" style="margin-top: 12px">
              <Icon name="info" class="icon" />
              <span>{{ t('account.testingNote') }}</span>
            </div>
          </div>

          <div class="grid cols-2">
            <div class="field">
              <label>{{ t('account.clientId') }}</label>
              <input v-model.trim="clientId" class="input mono" placeholder="1234567890-abc….apps.googleusercontent.com" spellcheck="false" @paste="onPasteJson" />
            </div>
            <div class="field">
              <label>{{ t('account.clientSecret') }}</label>
              <input
                v-model.trim="clientSecret"
                type="password"
                class="input mono"
                :placeholder="store.auth?.configured ? t('account.clientSecretKeep') : 'GOCSPX-…'"
                autocomplete="off"
                @paste="onPasteJson"
              />
            </div>
          </div>
          <div class="row">
            <span class="small faint row">
              <Icon name="shield" :size="14" />
              {{ store.auth?.secretsEncrypted ? t('account.encrypted') : t('account.notEncrypted') }}
            </span>
            <span class="spacer" />
            <button class="btn" :disabled="savingClient" @click="jsonInput.click()"><Icon name="upload" />{{ t('account.uploadJson') }}</button>
            <input ref="jsonInput" type="file" accept=".json,application/json" hidden @change="loadJsonFile($event.target.files[0])" />
            <button class="btn primary" :disabled="savingClient || !clientId" @click="saveClient()">{{ t('account.saveClient') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.narrow { max-width: 900px; }
.conn { gap: 16px; }
.avatar { width: 46px; height: 46px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 18px; flex: none; }
.avatar.off { background: var(--muted-soft); color: var(--text-3); }
.guide { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; background: var(--surface-2); }
.guide-toggle { display: flex; align-items: center; gap: 8px; background: none; border: 0; color: var(--text); font: inherit; cursor: pointer; padding: 0; }
.steps { margin: 12px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; }
.steps li { padding-left: 4px; }
.steps li span { margin-right: 8px; }
.steps a { display: inline-flex; align-items: center; gap: 3px; }
</style>
