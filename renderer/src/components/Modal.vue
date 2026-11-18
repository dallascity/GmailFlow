<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({ title: String, width: { type: String, default: '520px' }, closable: { type: Boolean, default: true } });
const emit = defineEmits(['close']);

const onKey = (e) => {
  if (e.key === 'Escape' && props.closable) emit('close');
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="overlay" @mousedown.self="closable && emit('close')">
      <div class="modal" :style="{ width }" role="dialog" aria-modal="true">
        <header>
          <h2>{{ title }}</h2>
          <button v-if="closable" class="btn ghost sm icon" @click="emit('close')"><Icon name="x" /></button>
        </header>
        <div class="body"><slot /></div>
        <footer v-if="$slots.footer"><slot name="footer" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 20, 0.45);
  display: grid;
  place-items: center;
  z-index: 50;
  padding: 24px;
  animation: fade 0.12s ease;
}
.modal {
  background: var(--surface);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  max-width: 100%;
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  animation: rise 0.16s ease;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
}
.body {
  padding: 4px 20px 20px;
  overflow: auto;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}
@keyframes fade {
  from { opacity: 0; }
}
@keyframes rise {
  from { transform: translateY(8px); opacity: 0; }
}
</style>
