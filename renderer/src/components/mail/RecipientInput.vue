<script setup>
import { ref, watch } from 'vue';
import { api } from '../../lib/api.js';

/** Alıcı çipleri + otomatik tamamlama (kayıtlı mailler ve yazışılan kişiler). */
const props = defineProps({ modelValue: { type: Array, default: () => [] }, label: String, placeholder: String });
const emit = defineEmits(['update:modelValue']);

const text = ref('');
const suggestions = ref([]);
const active = ref(0);
const input = ref(null);
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

let timer;
watch(text, (v) => {
  clearTimeout(timer);
  if (/[,;\s]$/.test(v)) return commit();
  if (v.trim().length < 2) {
    suggestions.value = [];
    return;
  }
  timer = setTimeout(async () => {
    try {
      const have = new Set(props.modelValue.map((r) => r.email));
      suggestions.value = (await api.get(`/mail/suggest?q=${encodeURIComponent(v.trim())}`)).filter((s) => !have.has(s.email));
      active.value = 0;
    } catch {
      suggestions.value = [];
    }
  }, 150);
});

function add(r) {
  if (!r?.email || props.modelValue.some((x) => x.email === r.email)) return;
  emit('update:modelValue', [...props.modelValue, { email: r.email.toLowerCase(), name: r.name ?? null }]);
}

/** Yazılanı (virgül, noktalı virgül, boşluk ile ayrılmış birden çok adres olabilir) çiplere çevirir. */
function commit() {
  const parts = text.value.split(/[,;\s]+/).filter(Boolean);
  const rest = [];
  for (const p of parts) {
    const m = /<([^>]+)>/.exec(p);
    const email = (m ? m[1] : p).trim();
    if (EMAIL.test(email)) add({ email });
    else rest.push(p);
  }
  text.value = rest.join(' ');
  suggestions.value = [];
}

function onKey(e) {
  if (suggestions.value.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.value.length) % suggestions.value.length;
  } else if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.value.length && text.value.trim()) {
    e.preventDefault();
    add(suggestions.value[active.value]);
    text.value = '';
    suggestions.value = [];
  } else if (e.key === 'Enter' || (e.key === 'Tab' && text.value.trim())) {
    if (text.value.trim()) {
      e.preventDefault();
      commit();
    }
  } else if (e.key === 'Backspace' && !text.value && props.modelValue.length) {
    emit('update:modelValue', props.modelValue.slice(0, -1));
  }
}

function remove(i) {
  const next = [...props.modelValue];
  next.splice(i, 1);
  emit('update:modelValue', next);
}

function onPaste(e) {
  const pasted = e.clipboardData.getData('text');
  if (/[,;\n]/.test(pasted) || (pasted.match(/@/g) ?? []).length > 1) {
    e.preventDefault();
    text.value = `${text.value} ${pasted}`;
    commit();
  }
}
const onBlur = () => setTimeout(commit, 150);
defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="rcpt" @click="input?.focus()">
    <span v-if="label" class="lbl">{{ label }}</span>
    <span v-for="(r, i) in modelValue" :key="r.email" class="chip-r" :title="r.email">
      {{ r.name || r.email }}
      <button type="button" tabindex="-1" @click.stop="remove(i)">×</button>
    </span>
    <input
      ref="input"
      v-model="text"
      :placeholder="modelValue.length ? '' : placeholder"
      spellcheck="false"
      @keydown="onKey"
      @blur="onBlur"
      @paste="onPaste"
    />
    <div v-if="suggestions.length" class="sugg">
      <button
        v-for="(s, i) in suggestions"
        :key="s.email"
        type="button"
        :class="{ on: i === active }"
        @mousedown.prevent="add(s), (text = ''), (suggestions = [])"
      >
        <b>{{ s.name || s.email }}</b>
        <span v-if="s.name" class="faint">{{ s.email }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.rcpt { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 5px 0; min-height: 36px; border-bottom: 1px solid var(--border); cursor: text; }
.lbl { color: var(--text-3); font-size: 13px; margin-right: 4px; min-width: 38px; }
.chip-r { display: inline-flex; align-items: center; gap: 2px; background: var(--muted-soft); border-radius: 12px; padding: 1px 4px 1px 10px; font-size: 13px; max-width: 260px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.chip-r button { border: 0; background: none; color: var(--text-3); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 4px; }
.chip-r button:hover { color: var(--err); }
input { flex: 1; min-width: 120px; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; padding: 4px 0; }
.sugg { position: absolute; top: 100%; left: 40px; right: 0; z-index: 20; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-lg); padding: 4px; display: flex; flex-direction: column; }
.sugg button { display: flex; gap: 8px; align-items: baseline; border: 0; background: none; text-align: left; padding: 7px 10px; border-radius: 6px; cursor: pointer; color: var(--text); font: inherit; font-size: 13px; }
.sugg button.on, .sugg button:hover { background: var(--accent-soft); }
</style>
