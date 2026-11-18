import { createI18n } from 'vue-i18n';
import tr from './tr.js';
import en from './en.js';

export const systemLocale = () => (String(navigator.language || 'tr').toLowerCase().startsWith('tr') ? 'tr' : 'en');

export const i18n = createI18n({
  legacy: false,
  locale: systemLocale(),
  fallbackLocale: 'en',
  messages: { tr, en },
  missingWarn: false,
  fallbackWarn: false,
});

export function setLocale(lang) {
  const l = lang ?? systemLocale();
  i18n.global.locale.value = l;
  document.documentElement.lang = l;
}

/** API hata kodunu kullanıcıya gösterilecek metne çevirir. */
export function errorMessage(err) {
  const { t, te } = i18n.global;
  const code = err?.code ?? 'unknown';
  const key = `errors.${code}`;
  if (te(key)) return t(key, { detail: '', ...(err?.params ?? {}) });
  return t('errors.unknown', { code: err?.params?.detail ? `${code} – ${err.params.detail}` : code });
}
