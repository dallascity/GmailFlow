import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';
import { i18n } from './i18n/index.js';
import App from './App.vue';
import { useApp } from './stores/app.js';
import './styles.css';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: () => import('./views/Dashboard.vue') },
    { path: '/mail/:label?', component: () => import('./views/Mail.vue') },
    { path: '/account', component: () => import('./views/Account.vue') },
    { path: '/lists', component: () => import('./views/Lists.vue') },
    { path: '/lists/:id', component: () => import('./views/ListDetail.vue'), props: true },
    { path: '/contacts', component: () => import('./views/Contacts.vue') },
    { path: '/campaigns', component: () => import('./views/Campaigns.vue') },
    { path: '/campaigns/:id/edit', component: () => import('./views/CampaignEditor.vue'), props: true },
    { path: '/campaigns/:id', component: () => import('./views/CampaignDetail.vue'), props: true },
    { path: '/logs', component: () => import('./views/Logs.vue') },
    { path: '/settings', component: () => import('./views/Settings.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);

const store = useApp();
store
  .load()
  .catch((err) => console.error('Başlatma hatası', err))
  .finally(() => app.mount('#app'));
