<script setup>
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useApp } from './stores/app.js';
import { useMail } from './stores/mail.js';
import ComposerHost from './components/mail/ComposerHost.vue';
import Avatar from './components/Avatar.vue';
import logoUrl from './assets/logo.png';
import { confirmState, resolveConfirm } from './lib/confirm.js';
import Icon from './components/Icon.vue';
import Modal from './components/Modal.vue';

const store = useApp();
const mail = useMail();
const route = useRoute();
const { t } = useI18n();

// Posta senkronizasyon olaylarını ve okunmamış sayısını her ekranda izle
watch(
  () => store.auth?.connected,
  (c) => c && mail.init(),
  { immediate: true },
);
// Posta ekranında daha fazla yer için kenar menü ikonlara daralır
const compact = computed(() => route.path.startsWith('/mail'));
const viewKey = (r) => (r.path.startsWith('/mail') ? 'mail' : r.fullPath.split('?')[0]);

const nav = [
  { to: '/mail', icon: 'inbox', label: 'nav.mail', badge: true },
  { to: '/', icon: 'dashboard', label: 'nav.dashboard' },
  { to: '/campaigns', icon: 'send', label: 'nav.campaigns' },
  { to: '/lists', icon: 'list', label: 'nav.lists' },
  { to: '/contacts', icon: 'book', label: 'nav.contacts' },
  { to: '/account', icon: 'user', label: 'nav.account' },
  { to: '/logs', icon: 'logs', label: 'nav.logs' },
  { to: '/settings', icon: 'settings', label: 'nav.settings' },
];

const quotaPct = computed(() => (store.quota ? Math.min(100, (store.quota.used / store.quota.limit) * 100) : 0));
</script>

<template>
  <div class="shell" :class="{ compact }">
    <aside class="sidebar">
      <div class="brand">
        <img class="logo" :src="logoUrl" alt="GmailFlow" />
        <div>
          <div class="name">GmailFlow</div>
          <div class="tag">{{ t('app.tagline') }}</div>
        </div>
      </div>
      <nav>
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" class="nav-item" :class="{ exact: n.to === '/' }" :title="compact ? t(n.label) : ''">
          <Icon :name="n.icon" :size="17" />
          <span class="nav-label">{{ t(n.label) }}</span>
          <b v-if="n.badge && mail.inboxUnread" class="nav-badge">{{ mail.inboxUnread > 999 ? '999+' : mail.inboxUnread }}</b>
        </RouterLink>
      </nav>
      <div class="side-foot">
        <RouterLink to="/account" class="acct">
          <Avatar v-if="store.auth?.connected" :email="store.auth.email" :name="store.auth.name" :size="24" />
          <span v-else class="status-dot" />
          <span class="truncate">{{ store.auth?.connected ? store.auth.email : t('account.notConnected') }}</span>
        </RouterLink>
        <div v-if="store.quota" class="quota">
          <div class="row small">
            <span>{{ t('dashboard.quotaToday') }}</span>
            <span class="spacer" />
            <span class="num">{{ store.quota.used }} / {{ store.quota.limit }}</span>
          </div>
          <div class="bar"><span :style="{ width: `${quotaPct}%` }" :class="{ full: quotaPct >= 100 }" /></div>
        </div>
      </div>
    </aside>

    <main class="main">
      <RouterView v-slot="{ Component, route }">
        <component :is="Component" :key="viewKey(route)" />
      </RouterView>
    </main>

    <ComposerHost />

    <div class="toasts">
      <TransitionGroup name="toast">
        <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="toast.type" @click="store.dismiss(toast.id)">
          <Icon :name="toast.type === 'err' ? 'alertCircle' : toast.type === 'warn' ? 'alert' : 'checkCircle'" :size="17" />
          <span>{{ toast.message }}</span>
        </div>
      </TransitionGroup>
    </div>

    <Modal v-if="confirmState" :title="confirmState.title ?? t('common.confirm')" width="440px" @close="resolveConfirm(false)">
      <p class="muted" style="white-space: pre-line">{{ confirmState.message }}</p>
      <template #footer>
        <button class="btn" @click="resolveConfirm(false)">{{ t('common.cancel') }}</button>
        <button class="btn" :class="confirmState.danger ? 'danger-solid' : 'primary'" autofocus @click="resolveConfirm(true)">
          {{ confirmState.confirmText ?? t('common.confirm') }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }
.shell.compact { grid-template-columns: 64px 1fr; }
.shell.compact .sidebar { padding: 18px 8px; align-items: center; }
.shell.compact .brand > div:last-child, .shell.compact .nav-label, .shell.compact .side-foot { display: none; }
.shell.compact .brand { padding: 4px 0 6px; }
.shell.compact nav { align-items: stretch; width: 100%; }
.shell.compact .nav-item { justify-content: center; padding: 10px 0; position: relative; }
.shell.compact .nav-badge { position: absolute; top: 3px; right: 3px; padding: 0 5px; font-size: 10px; }
.nav-badge { margin-left: auto; background: #6582f5; color: #fff; border-radius: 10px; padding: 0 7px; font-size: 11px; line-height: 18px; font-variant-numeric: tabular-nums; }
.sidebar { background: var(--sidebar); color: var(--sidebar-text); display: flex; flex-direction: column; padding: 18px 12px; gap: 18px; }
.brand { display: flex; align-items: center; gap: 11px; padding: 4px 8px 6px; }
.logo { width: 40px; height: 40px; object-fit: contain; flex: none; }
.name { color: #fff; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.tag { font-size: 11.5px; color: #7d859b; }
nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item { display: flex; align-items: center; gap: 11px; padding: 9px 11px; border-radius: 8px; color: var(--sidebar-text); font-weight: 500; text-decoration: none; }
.nav-item:hover { background: var(--sidebar-hover); color: #fff; text-decoration: none; }
.nav-item.router-link-active:not(.exact), .nav-item.exact.router-link-exact-active { background: var(--sidebar-hover); color: var(--sidebar-active); box-shadow: inset 3px 0 0 #6582f5; }
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 12px; padding: 0 4px; }
.acct { display: flex; align-items: center; gap: 8px; color: var(--sidebar-text); font-size: 12.5px; padding: 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.04); text-decoration: none; }
.acct:hover { color: #fff; text-decoration: none; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #e0a336; flex: none; }
.status-dot.on { background: #3fcf7a; }
.quota { padding: 0 6px; color: #8a91a6; }
.bar { height: 5px; border-radius: 9px; background: rgba(255, 255, 255, 0.08); margin-top: 6px; overflow: hidden; }
.bar span { display: block; height: 100%; background: #6582f5; border-radius: 9px; transition: width 0.4s; }
.bar span.full { background: #e0a336; }
.main { overflow: auto; }
.toasts { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 100; max-width: 420px; }
.toast { display: flex; gap: 10px; align-items: flex-start; padding: 11px 14px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-lg); cursor: pointer; }
.toast.ok :deep(.icon) { color: var(--ok); }
.toast.err { border-color: color-mix(in srgb, var(--err) 40%, var(--border)); }
.toast.err :deep(.icon) { color: var(--err); }
.toast.warn :deep(.icon) { color: var(--warn); }
.toast :deep(.icon) { flex: none; margin-top: 2px; }
.toast-enter-active, .toast-leave-active { transition: all 0.18s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
