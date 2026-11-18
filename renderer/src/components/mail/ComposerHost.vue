<script setup>
import { useMail } from '../../stores/mail.js';
import Composer from './Composer.vue';

const mail = useMail();
</script>

<template>
  <div class="dock">
    <Composer v-for="c in mail.composers" :key="c.id" :composer="c" />
  </div>
</template>

<style scoped>
.dock { position: fixed; right: 24px; bottom: 0; display: flex; align-items: flex-end; gap: 12px; z-index: 55; pointer-events: none; }
</style>
