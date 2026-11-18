<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { statusTone, sendTone } from '../lib/format.js';

const props = defineProps({ status: String, kind: { type: String, default: 'campaign' } });
const { t } = useI18n();
const tone = computed(() => (props.kind === 'send' ? sendTone : statusTone)[props.status] ?? '');
const label = computed(() => t(`${props.kind === 'send' ? 'sendStatus' : 'status'}.${props.status}`));
</script>

<template>
  <span class="badge" :class="[tone, { pulse: status === 'running' || status === 'sending' }]"><span class="dot" />{{ label }}</span>
</template>
