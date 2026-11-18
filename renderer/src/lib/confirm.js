import { ref } from 'vue';

/** Promise tabanlı onay penceresi: `if (await confirm({ message })) …` */
export const confirmState = ref(null);

export function confirm({ title, message, confirmText, danger = false }) {
  return new Promise((resolve) => {
    confirmState.value = { title, message, confirmText, danger, resolve };
  });
}

export function resolveConfirm(value) {
  confirmState.value?.resolve(value);
  confirmState.value = null;
}
