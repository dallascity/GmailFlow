<script setup>
import { ref, onBeforeUnmount } from 'vue';

/**
 * E-posta HTML'ini yalıtılmış bir iframe'de gösterir.
 * sandbox'ta allow-scripts YOK → e-postadaki betikler asla çalışmaz. allow-same-origin yalnızca
 * yüksekliği ölçmek ve mailto bağlantılarını yakalamak içindir (betik olmadan güvenlidir).
 */
const props = defineProps({ html: { type: String, required: true }, minHeight: { type: Number, default: 60 } });
const emit = defineEmits(['mailto']);
const frame = ref(null);
const height = ref(props.minHeight);
let ro;

function onLoad() {
  const doc = frame.value?.contentDocument;
  if (!doc) return;
  const measure = () => {
    // Yatay kaydırma çubuğu varsa onun yüksekliği de eklenir
    const hScroll = doc.documentElement.scrollWidth > doc.documentElement.clientWidth ? 18 : 0;
    height.value = Math.max(props.minHeight, doc.documentElement.scrollHeight + hScroll, (doc.body?.scrollHeight ?? 0) + hScroll);
  };
  measure();
  ro?.disconnect();
  ro = new ResizeObserver(measure);
  ro.observe(doc.documentElement);
  if (doc.body) ro.observe(doc.body);
  doc.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', measure, { once: true });
  });
  // Web fontları ve geç yüklenen içerik için birkaç kez daha ölç
  [150, 600, 1500].forEach((ms) => setTimeout(measure, ms));
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="mailto:"]');
    if (a) {
      e.preventDefault();
      emit('mailto', decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]));
    }
  });
}
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <iframe
    ref="frame"
    class="mail-frame"
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    referrerpolicy="no-referrer"
    :srcdoc="html"
    :style="{ height: `${height}px` }"
    title="mail"
    @load="onLoad"
  />
</template>

<style scoped>
.mail-frame { width: 100%; border: 0; display: block; background: #fff; border-radius: 6px; }
</style>
