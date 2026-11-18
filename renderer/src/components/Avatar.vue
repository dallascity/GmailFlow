<script setup>
import { computed, ref, watch } from 'vue';
import { useApp } from '../stores/app.js';
import { withKey } from '../lib/api.js';

/**
 * Kişi avatarı: bağlı hesabın kendisi için Google profil resmi, diğer herkes için renkli baş harf.
 * (Gmail API başka kişilerin profil resmini vermez.)
 */
const props = defineProps({ email: String, name: String, size: { type: Number, default: 34 } });
const app = useApp();
const failed = ref(false);

const isMe = computed(() => Boolean(props.email && app.auth?.email && props.email.toLowerCase() === app.auth.email.toLowerCase()));
const src = computed(() => (isMe.value && app.auth?.avatarUrl && !failed.value ? withKey(app.auth.avatarUrl) : null));
watch(() => app.auth?.avatarUrl, () => (failed.value = false));

const initial = computed(() => ((props.name || props.email || '?').trim()[0] ?? '?').toLocaleUpperCase('tr'));
const color = computed(() => `hsl(${[...(props.email ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 55% 48%)`);
</script>

<template>
  <img v-if="src" class="av" :src="src" :alt="name || email" :style="{ width: `${size}px`, height: `${size}px` }" referrerpolicy="no-referrer" @error="failed = true" />
  <div v-else class="av letter" :style="{ width: `${size}px`, height: `${size}px`, background: color, fontSize: `${Math.round(size * 0.42)}px` }">{{ initial }}</div>
</template>

<style scoped>
.av { border-radius: 50%; flex: none; object-fit: cover; display: block; }
.letter { color: #fff; display: grid; place-items: center; font-weight: 700; }
</style>
