<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, download } from '../../lib/api.js';
import { useApp } from '../../stores/app.js';
import { useMail } from '../../stores/mail.js';
import { fmtBytes } from '../../lib/format.js';
import { fmtMailDate, fmtMailDateLong, addrLabel, addrFull, buildReplyInit } from '../../lib/mailFormat.js';
import Icon from '../Icon.vue';
import MessageFrame from './MessageFrame.vue';
import Avatar from '../Avatar.vue';

const props = defineProps({ threadId: { type: String, required: true }, label: String });
const emit = defineEmits(['close', 'action']);
const { t, te } = useI18n();
const app = useApp();
const mail = useMail();
const router = useRouter();

const thread = ref(null);
const loading = ref(false);
const expanded = ref(new Set());
const labelMenu = ref(false);

let imagesShown = false;
async function load(images = false, { silent = false } = {}) {
  loading.value = true;
  if (images) imagesShown = true;
  try {
    const th = await api.get(`/mail/threads/${props.threadId}${images || imagesShown ? '?images=1' : ''}`);
    const before = new Set(thread.value?.messages.map((m) => m.id) ?? []);
    thread.value = th;
    if (silent) {
      // Konuşmaya yeni gelen (ör. az önce gönderilen yanıt) iletiler açık gösterilir
      expanded.value = new Set([...expanded.value, ...th.messages.filter((m) => !before.has(m.id)).map((m) => m.id)]);
    } else if (!images) {
      const ex = new Set(th.messages.filter((m) => m.labels.includes('UNREAD')).map((m) => m.id));
      ex.add(th.messages.at(-1).id);
      expanded.value = ex;
    }
    if (th.labels.includes('UNREAD')) {
      api.post('/mail/modify', { threadIds: [props.threadId], remove: ['UNREAD'] }).catch(() => {});
    }
  } catch (e) {
    app.fail(e);
    emit('close');
  } finally {
    loading.value = false;
  }
}
watch(() => props.threadId, () => load(), { immediate: true });

// Senkronizasyonla bu konuşmaya yeni ileti gelirse (gönderilen yanıt dahil) görünümü tazele
let refreshTimer;
const offEvents = mail.onEvent((e) => {
  if (e.type !== 'mail:changed' || !thread.value) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => load(false, { silent: true }), 500);
});
onBeforeUnmount(() => {
  offEvents();
  clearTimeout(refreshTimer);
});

const me = computed(() => app.auth?.email ?? '');
const has = (l) => thread.value?.labels.includes(l);
const toggle = (id) => {
  const s = new Set(expanded.value);
  s.has(id) ? s.delete(id) : s.add(id);
  expanded.value = s;
};

function reply(m, mode) {
  mail.compose(buildReplyInit(m, mode, me.value));
}
function editDraft(m) {
  mail.compose({ mode: 'draft', messageId: m.id, draftId: m.draftId });
}

async function allowSender(email) {
  await api.post('/mail/images/allow', { email }).catch(app.fail);
  load(true);
}

const userLabels = computed(() => mail.userLabels);
const threadUserLabels = computed(() => userLabels.value.filter((l) => has(l.id)));
const folderName = (id) => (te(`mail.folders.${id}`) ? t(`mail.folders.${id}`) : id);

const recipientsLine = (m) => {
  const parts = [...m.to, ...m.cc].map((a) => (a.email === me.value ? t('mail.me') : addrLabel(a)));
  return `${t('mail.to')}: ${parts.join(', ') || '—'}`;
};

/** Üst bileşene (liste) işlem bildirir; liste aynı işlemi uygular. */
const act = (action, extra) => emit('action', { action, threadIds: [props.threadId], ...extra });

defineExpose({
  reply: () => thread.value && reply(thread.value.messages.at(-1), 'reply'),
  replyAll: () => thread.value && reply(thread.value.messages.at(-1), 'replyAll'),
  forward: () => thread.value && reply(thread.value.messages.at(-1), 'forward'),
});
</script>

<template>
  <div class="tv">
    <div class="tv-toolbar">
      <button class="btn ghost sm icon" :title="t('common.back')" @click="emit('close')"><Icon name="chevronLeft" /></button>
      <template v-if="thread">
        <button v-if="has('INBOX')" class="btn ghost sm icon" :title="t('mail.archive')" @click="act('archive')"><Icon name="archive" /></button>
        <button v-else-if="!has('TRASH') && !has('SPAM')" class="btn ghost sm icon" :title="t('mail.restore')" @click="act('inbox')"><Icon name="inbox" /></button>
        <button v-if="has('TRASH')" class="btn ghost sm icon" :title="t('mail.untrash')" @click="act('untrash')"><Icon name="undoArrow" /></button>
        <button v-else class="btn ghost sm icon" :title="t('mail.trash')" @click="act('trash')"><Icon name="trash" /></button>
        <button class="btn ghost sm icon" :title="has('SPAM') ? t('mail.notSpam') : t('mail.spam')" @click="act(has('SPAM') ? 'notspam' : 'spam')"><Icon name="ban" /></button>
        <span class="sep" />
        <button class="btn ghost sm icon" :title="t('mail.markUnread')" @click="act('unread')"><Icon name="mailOpen" /></button>
        <button class="btn ghost sm icon" :class="{ starred: has('STARRED') }" :title="has('STARRED') ? t('mail.unstar') : t('mail.star')" @click="act(has('STARRED') ? 'unstar' : 'star')">
          <Icon name="star" :filled="has('STARRED')" />
        </button>
        <button class="btn ghost sm icon" :class="{ imp: has('IMPORTANT') }" :title="has('IMPORTANT') ? t('mail.notImportant') : t('mail.important')" @click="act(has('IMPORTANT') ? 'unimportant' : 'important')">
          <Icon name="important" :filled="has('IMPORTANT')" />
        </button>
        <div v-if="userLabels.length" class="menu-wrap">
          <button class="btn ghost sm icon" :title="t('mail.applyLabel')" @click="labelMenu = !labelMenu"><Icon name="tag" /></button>
          <div v-if="labelMenu" class="menu" @mouseleave="labelMenu = false">
            <label v-for="l in userLabels" :key="l.id" class="menu-item">
              <input type="checkbox" :checked="has(l.id)" @change="act($event.target.checked ? 'label' : 'unlabel', { label: l.id })" />
              <span class="dot" :style="{ background: l.color_bg || 'var(--text-3)' }" />{{ l.name }}
            </label>
          </div>
        </div>
      </template>
    </div>

    <div v-if="!thread" class="tv-empty"><Icon name="loader" class="spin" /></div>
    <div v-else class="tv-body">
      <h2 class="subject">
        {{ thread.subject || '(—)' }}
        <span v-for="l in thread.labels.filter((x) => ['INBOX', 'SPAM', 'TRASH', 'SENT', 'DRAFT'].includes(x))" :key="l" class="badge">{{ folderName(l) }}</span>
        <span v-for="l in threadUserLabels" :key="l.id" class="badge" :style="{ background: l.color_bg, color: l.color_text }">{{ l.name }}</span>
      </h2>

      <div v-if="thread.campaign" class="alert info small" style="margin-bottom: 12px">
        <Icon name="send" class="icon" />
        <span class="spacer">
          {{ t('mail.campaignThread', { name: thread.campaign.campaign_name }) }}
          <b v-if="thread.campaign.bounced_at" style="color: var(--err)"> {{ t('mail.campaignBounced') }}</b>
          <b v-else-if="thread.campaign.replied_at" style="color: var(--ok)"> {{ t('mail.campaignReplied') }}</b>
        </span>
        <button class="btn sm" @click="router.push(`/campaigns/${thread.campaign.campaign_id}`)">{{ t('mail.openCampaign') }}</button>
      </div>
      <div v-if="thread.contact?.suppressed" class="alert warn small" style="margin-bottom: 12px">
        <Icon name="ban" class="icon" /><span>{{ t('mail.contactSuppressed') }}</span>
      </div>

      <article v-for="(m, i) in thread.messages" :key="m.id" class="msg" :class="{ open: expanded.has(m.id) }">
        <header class="msg-head" @click="i < thread.messages.length - 1 || !expanded.has(m.id) ? toggle(m.id) : null">
          <Avatar :email="m.from.email" :name="m.from.name" :size="34" />
          <div class="who">
            <div class="row">
              <b class="truncate">{{ m.from.email === me ? t('mail.me') : addrLabel(m.from) }}</b>
              <span v-if="m.from.name && expanded.has(m.id)" class="faint small truncate">&lt;{{ m.from.email }}&gt;</span>
              <span v-if="m.draftId || m.labels.includes('DRAFT')" class="badge err">{{ t('mail.draft') }}</span>
            </div>
            <div class="small faint truncate">{{ expanded.has(m.id) ? recipientsLine(m) : m.snippet }}</div>
          </div>
          <span class="date small faint" :title="fmtMailDateLong(m.date)">{{ expanded.has(m.id) ? fmtMailDateLong(m.date) : fmtMailDate(m.date) }}</span>
          <div v-if="expanded.has(m.id)" class="msg-actions" @click.stop>
            <template v-if="m.labels.includes('DRAFT')">
              <button class="btn sm" @click="editDraft(m)"><Icon name="pen" :size="14" />{{ t('common.edit') }}</button>
            </template>
            <template v-else>
              <button class="btn ghost sm icon" :title="t('mail.reply')" @click="reply(m, 'reply')"><Icon name="reply" /></button>
              <button class="btn ghost sm icon" :title="t('mail.replyAll')" @click="reply(m, 'replyAll')"><Icon name="replyAll" /></button>
              <button class="btn ghost sm icon" :title="t('mail.forward')" @click="reply(m, 'forward')"><Icon name="forward" /></button>
            </template>
          </div>
        </header>

        <div v-if="expanded.has(m.id)" class="msg-body">
          <div v-if="m.blockedImages" class="imgbar small">
            <Icon name="eye" :size="14" />
            <span class="spacer">{{ t('mail.imagesBlocked', { n: m.blockedImages }) }}</span>
            <button class="linkish" @click="load(true)">{{ t('mail.showImages') }}</button>
            <button class="linkish" @click="allowSender(m.from.email)">{{ t('mail.alwaysShowImages') }}</button>
          </div>
          <MessageFrame :html="m.html" @mailto="(addr) => mail.compose({ mode: 'new', to: [{ email: addr }] })" />
          <div v-if="m.attachments.length" class="atts">
            <button
              v-for="a in m.attachments"
              :key="a.partId"
              class="att"
              :title="t('mail.download')"
              @click="download(`/mail/messages/${m.id}/attachments/${a.attachmentId}?download=1`, a.filename).catch(app.fail)"
            >
              <Icon name="file" :size="18" />
              <span class="att-name truncate">{{ a.filename }}</span>
              <span class="faint small">{{ fmtBytes(a.size) }}</span>
              <Icon name="download" :size="14" class="faint" />
            </button>
          </div>
        </div>
      </article>

      <div class="replybar">
        <button class="btn" @click="reply(thread.messages.at(-1), 'reply')"><Icon name="reply" />{{ t('mail.reply') }}</button>
        <button class="btn" @click="reply(thread.messages.at(-1), 'replyAll')"><Icon name="replyAll" />{{ t('mail.replyAll') }}</button>
        <button class="btn" @click="reply(thread.messages.at(-1), 'forward')"><Icon name="forward" />{{ t('mail.forward') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tv { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.tv-toolbar { display: flex; align-items: center; gap: 2px; padding: 8px 12px; border-bottom: 1px solid var(--border); min-height: 49px; }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 6px; }
.starred { color: #e3a008; }
.imp { color: #e3a008; }
.menu-wrap { position: relative; }
.menu { position: absolute; top: 100%; left: 0; z-index: 10; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-lg); padding: 6px; min-width: 200px; }
.menu-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.menu-item:hover { background: var(--surface-2); }
.dot { width: 9px; height: 9px; border-radius: 50%; }
.tv-empty { display: grid; place-items: center; flex: 1; color: var(--text-3); }
.tv-body { overflow: auto; padding: 18px 22px 40px; flex: 1; }
.subject { font-size: 19px; font-weight: 600; margin-bottom: 14px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.msg { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; background: var(--surface); }
.msg:not(.open) { background: var(--surface-2); }
.msg-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; }
.avatar { width: 34px; height: 34px; border-radius: 50%; color: #fff; display: grid; place-items: center; font-weight: 700; flex: none; }
.who { flex: 1; min-width: 0; }
.who .row { gap: 6px; }
.date { flex: none; white-space: nowrap; }
.msg-actions { display: flex; gap: 2px; flex: none; }
.msg-body { padding: 0 14px 14px 60px; }
.imgbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 8px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); }
.linkish { border: 0; background: none; color: var(--accent-text); cursor: pointer; font: inherit; font-weight: 600; padding: 0; }
.linkish:hover { text-decoration: underline; }
.atts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.att { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); cursor: pointer; color: var(--text); font: inherit; max-width: 280px; }
.att:hover { border-color: var(--accent); }
.att-name { font-size: 13px; font-weight: 500; }
.replybar { display: flex; gap: 8px; margin-top: 16px; padding-left: 60px; }
</style>
