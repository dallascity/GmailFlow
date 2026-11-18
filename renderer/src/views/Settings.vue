<script setup>
import { reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useApp } from '../stores/app.js';
import { isDesktop, openDataDir } from '../lib/api.js';
import Icon from '../components/Icon.vue';
import RichEditor from '../components/RichEditor.vue';

const { t } = useI18n();
const store = useApp();
const form = reactive({ ...store.settings });
watch(
  () => store.settings,
  (s) => Object.assign(form, s),
);

async function save(patch) {
  try {
    await store.saveSettings(patch);
    store.toast(t('settings.saved'), 'ok', 1800);
  } catch (e) {
    store.fail(e);
  }
}
const version = __APP_VERSION__;

// İmza her tuşta değil, yazmayı bırakınca kaydedilir
let sigTimer;
function saveSignature(v) {
  form.mail_signature = v;
  clearTimeout(sigTimer);
  sigTimer = setTimeout(() => save({ mail_signature: v }), 900);
}
</script>

<template>
  <div class="page narrow">
    <div class="page-head"><h1>{{ t('settings.title') }}</h1></div>

    <div class="stack-lg">
      <div class="card card-pad grid cols-2">
        <div class="field">
          <label>{{ t('settings.language') }}</label>
          <select class="select" :value="form.language ?? ''" @change="save({ language: $event.target.value || null })">
            <option value="">{{ t('settings.languageSystem') }}</option>
            <option value="tr">Türkçe</option>
            <option value="en">English</option>
          </select>
        </div>
        <div class="field">
          <label>{{ t('settings.theme') }}</label>
          <div class="segmented">
            <button v-for="th in ['system', 'light', 'dark']" :key="th" :class="{ on: form.theme === th }" @click="save({ theme: th })">
              {{ t(`settings.theme${th[0].toUpperCase()}${th.slice(1)}`) }}
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h2>{{ t('settings.sendingTitle') }}</h2>
            <div class="sub">{{ t('settings.sendingHint') }}</div>
          </div>
        </div>
        <div class="card-body stack-lg">
          <div class="field">
            <label>{{ t('settings.accountType') }}</label>
            <div class="types">
              <label v-for="type in ['personal', 'workspace']" :key="type" class="type" :class="{ on: form.account_type === type }">
                <input type="radio" name="acct" :checked="form.account_type === type" @change="save({ account_type: type })" />
                <div>
                  <div style="font-weight: 600">{{ t(`settings.${type}`) }}</div>
                  <div class="small faint">{{ t(`settings.${type}Limit`) }}</div>
                </div>
              </label>
            </div>
          </div>
          <div class="grid cols-2">
            <div class="field">
              <label>{{ t('settings.dailyLimit') }}</label>
              <input
                v-model.number="form.daily_limit"
                type="number"
                min="1"
                :max="form.daily_cap"
                class="input num"
                @change="save({ daily_limit: form.daily_limit })"
              />
              <span class="hint">{{ t('settings.dailyLimitHint', { cap: form.daily_cap }) }}</span>
            </div>
            <div class="field">
              <label>{{ t('settings.defaultDelay') }}</label>
              <input
                v-model.number="form.default_delay_sec"
                type="number"
                min="1"
                max="3600"
                class="input num"
                @change="save({ default_delay_sec: form.default_delay_sec })"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>{{ t('settings.mailTitle') }}</h2></div>
        <div class="card-body stack-lg">
          <div class="grid cols-2">
            <div class="field">
              <label>{{ t('settings.mailCacheDays') }}</label>
              <input v-model.number="form.mail_cache_days" type="number" min="7" max="365" class="input num" @change="save({ mail_cache_days: form.mail_cache_days })" />
              <span class="hint">{{ t('settings.mailCacheHint') }}</span>
            </div>
            <div class="field">
              <label>{{ t('settings.mailImages') }}</label>
              <select class="select" :value="form.mail_images" @change="save({ mail_images: $event.target.value })">
                <option value="ask">{{ t('settings.mailImagesAsk') }}</option>
                <option value="always">{{ t('settings.mailImagesAlways') }}</option>
              </select>
            </div>
          </div>
          <label class="check">
            <input type="checkbox" :checked="form.mail_notifications" @change="save({ mail_notifications: $event.target.checked })" />
            <span>{{ t('settings.mailNotifications') }}</span>
          </label>
          <label class="check">
            <input type="checkbox" :checked="form.list_unsubscribe_default" @change="save({ list_unsubscribe_default: $event.target.checked })" />
            <span>{{ t('settings.listUnsubDefault') }}</span>
          </label>
          <div class="field">
            <label>{{ t('settings.mailSignature') }}</label>
            <RichEditor :model-value="form.mail_signature" class="sig" @update:model-value="saveSignature" />
            <span class="hint">{{ t('settings.mailSignatureHint') }}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h2>{{ t('settings.dataTitle') }}</h2>
            <div class="sub">{{ t('settings.dataHint') }}</div>
          </div>
        </div>
        <div class="card-body row">
          <div class="spacer">
            <div class="small faint">{{ t('settings.dataDir') }}</div>
            <code>{{ store.info?.dataDir }}</code>
          </div>
          <button v-if="isDesktop" class="btn" @click="openDataDir()"><Icon name="folder" />{{ t('settings.openFolder') }}</button>
        </div>
      </div>

      <div class="card card-pad row">
        <div class="spacer">
          <h3>GmailFlow</h3>
          <div class="small faint">{{ t('settings.version') }} {{ version }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.narrow { max-width: 900px; }
.sig :deep(.tiptap) { min-height: 90px; }
.types { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.type { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: pointer; }
.type.on { border-color: var(--accent); background: var(--accent-soft); }
.type input { margin-top: 3px; accent-color: var(--accent); }
</style>
