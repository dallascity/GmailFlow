<script setup>
import { watch, onBeforeUnmount } from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { useI18n } from 'vue-i18n';
import Icon from './Icon.vue';

const props = defineProps({ modelValue: { type: String, default: '' }, disabled: Boolean });
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();

const editor = useEditor({
  content: props.modelValue,
  editable: !props.disabled,
  extensions: [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
  ],
  onUpdate: ({ editor: e }) => emit('update:modelValue', e.isEmpty ? '' : e.getHTML()),
});

watch(
  () => props.modelValue,
  (v) => {
    const e = editor.value;
    if (e && v !== e.getHTML() && !(v === '' && e.isEmpty)) e.commands.setContent(v || '', { emitUpdate: false });
  },
);
watch(
  () => props.disabled,
  (d) => editor.value?.setEditable(!d),
);
onBeforeUnmount(() => editor.value?.destroy());

function setLink() {
  const prev = editor.value.getAttributes('link').href ?? '';
  const url = window.prompt(t('rte.linkPrompt'), prev);
  if (url === null) return;
  if (url.trim() === '') editor.value.chain().focus().extendMarkRange('link').unsetLink().run();
  else editor.value.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
}

/** Değişken gibi metni imlecin bulunduğu yere ekler. */
function insert(text) {
  editor.value?.chain().focus().insertContent(text).run();
}
/** İmleci başa ('start') veya sona ('end') koyarak odaklar. */
function focus(pos = 'start') {
  editor.value?.commands.focus(pos);
}
defineExpose({ insert, focus });

const tools = [
  { icon: 'bold', title: 'rte.bold', run: (c) => c.toggleBold(), active: 'bold' },
  { icon: 'italic', title: 'rte.italic', run: (c) => c.toggleItalic(), active: 'italic' },
  { icon: 'underline', title: 'rte.underline', run: (c) => c.toggleUnderline(), active: 'underline' },
  { icon: 'strike', title: 'rte.strike', run: (c) => c.toggleStrike(), active: 'strike' },
  null,
  { icon: 'heading', title: 'rte.h2', run: (c) => c.toggleHeading({ level: 2 }), active: ['heading', { level: 2 }] },
  { icon: 'ul', title: 'rte.bullet', run: (c) => c.toggleBulletList(), active: 'bulletList' },
  { icon: 'ol', title: 'rte.ordered', run: (c) => c.toggleOrderedList(), active: 'orderedList' },
  { icon: 'quote', title: 'rte.quote', run: (c) => c.toggleBlockquote(), active: 'blockquote' },
  { icon: 'link', title: 'rte.link', custom: setLink, active: 'link' },
  null,
  { icon: 'eraser', title: 'rte.clear', run: (c) => c.unsetAllMarks().clearNodes() },
  { icon: 'undo', title: 'rte.undo', run: (c) => c.undo() },
  { icon: 'redo', title: 'rte.redo', run: (c) => c.redo() },
];

const isActive = (a) => (Array.isArray(a) ? editor.value?.isActive(...a) : a && editor.value?.isActive(a));
const exec = (tool) => (tool.custom ? tool.custom() : tool.run(editor.value.chain().focus()).run());
</script>

<template>
  <div class="rte" :class="{ disabled }">
    <div v-if="editor && !disabled" class="toolbar">
      <template v-for="(tool, i) in tools" :key="i">
        <span v-if="!tool" class="sep" />
        <button v-else type="button" class="tb" :class="{ on: isActive(tool.active) }" :title="t(tool.title)" @click="exec(tool)">
          <Icon :name="tool.icon" :size="15" />
        </button>
      </template>
    </div>
    <EditorContent :editor="editor" class="content" />
  </div>
</template>

<style scoped>
.rte { border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); overflow: hidden; }
.rte:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.toolbar { display: flex; align-items: center; gap: 2px; padding: 5px 6px; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
.tb { width: 30px; height: 28px; border: 0; background: transparent; border-radius: 5px; color: var(--text-2); cursor: pointer; display: grid; place-items: center; }
.tb:hover { background: var(--muted-soft); color: var(--text); }
.tb.on { background: var(--accent-soft); color: var(--accent-text); }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
.content :deep(.tiptap) { min-height: 260px; max-height: 520px; overflow: auto; padding: 14px 16px; outline: none; line-height: 1.6; }
.content :deep(.tiptap p) { margin: 0 0 0.7em; }
.content :deep(.tiptap h2) { font-size: 1.3em; margin: 0.6em 0 0.4em; }
.content :deep(.tiptap h3) { font-size: 1.1em; margin: 0.6em 0 0.4em; }
.content :deep(.tiptap ul), .content :deep(.tiptap ol) { padding-left: 1.4em; margin: 0 0 0.7em; }
.content :deep(.tiptap blockquote) { border-left: 3px solid var(--border-strong); margin: 0 0 0.7em; padding-left: 12px; color: var(--text-2); }
.content :deep(.tiptap a) { color: var(--accent-text); text-decoration: underline; }
.content :deep(.tiptap p.is-editor-empty:first-child::before) { content: attr(data-placeholder); color: var(--text-3); float: left; height: 0; pointer-events: none; }
.disabled .content :deep(.tiptap) { background: var(--surface-2); color: var(--text-2); }
</style>
