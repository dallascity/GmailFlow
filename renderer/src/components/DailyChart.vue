<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { fmtNumber } from '../lib/format.js';

const props = defineProps({ days: { type: Array, default: () => [] } });
const { t, locale } = useI18n();
const hover = ref(null);

const H = 150;
const max = computed(() => Math.max(5, ...props.days.map((d) => d.sent + d.failed)));
const ticks = computed(() => {
  const step = Math.ceil(max.value / 4 / 5) * 5 || 1;
  return [0, step, step * 2, step * 3, step * 4].filter((v) => v <= max.value * 1.05 || v === 0);
});
const top = computed(() => Math.max(max.value, ticks.value.at(-1)));
const y = (v) => H - (v / top.value) * H;

const label = (iso, short = true) =>
  new Intl.DateTimeFormat(locale.value === 'tr' ? 'tr-TR' : 'en-GB', short ? { day: 'numeric', month: 'short' } : { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(`${iso}T12:00:00`),
  );
</script>

<template>
  <div class="chart">
    <div class="legend small">
      <span><i class="sw ok" />{{ t('dashboard.sent') }}</span>
      <span><i class="sw err" />{{ t('dashboard.failed') }}</span>
    </div>
    <div class="plot">
      <div class="axis">
        <span v-for="v in ticks" :key="v" class="small faint num" :style="{ top: `${y(v)}px` }">{{ fmtNumber(v) }}</span>
      </div>
      <div class="area" :style="{ height: `${H}px` }">
        <div v-for="v in ticks" :key="v" class="grid-line" :style="{ top: `${y(v)}px` }" />
        <div class="bars">
          <div v-for="(d, i) in days" :key="d.date" class="col" @mouseenter="hover = i" @mouseleave="hover = null">
            <div class="stack" :style="{ height: `${((d.sent + d.failed) / top) * H}px` }">
              <div class="seg err" :style="{ flex: d.failed }" />
              <div class="seg ok" :style="{ flex: d.sent }" />
            </div>
            <div v-if="hover === i" class="tip">
              <b>{{ label(d.date, false) }}</b>
              <div><i class="sw ok" />{{ t('dashboard.sent') }}: <b class="num">{{ fmtNumber(d.sent) }}</b></div>
              <div><i class="sw err" />{{ t('dashboard.failed') }}: <b class="num">{{ fmtNumber(d.failed) }}</b></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="xlabels">
      <span v-for="(d, i) in days" :key="d.date" class="small faint">{{ i % 2 === 1 || i === days.length - 1 ? label(d.date) : '' }}</span>
    </div>
  </div>
</template>

<style scoped>
.chart { padding: 4px 4px 0; }
.legend { display: flex; gap: 16px; color: var(--text-2); margin-bottom: 10px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
.sw.ok { background: var(--ok); }
.sw.err { background: var(--err); }
.plot { display: flex; gap: 8px; }
.axis { position: relative; width: 34px; flex: none; }
.axis span { position: absolute; right: 0; transform: translateY(-50%); }
.area { position: relative; flex: 1; }
.grid-line { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--border); }
.bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 6px; }
.col { flex: 1; height: 100%; display: flex; align-items: flex-end; justify-content: center; position: relative; cursor: default; }
.col:hover { background: color-mix(in srgb, var(--muted-soft) 70%, transparent); border-radius: 4px; }
.stack { width: min(100%, 26px); display: flex; flex-direction: column; border-radius: 4px 4px 0 0; overflow: hidden; min-height: 0; }
.seg.ok { background: var(--ok); }
.seg.err { background: var(--err); }
.seg + .seg { border-top: 2px solid var(--surface); }
.tip { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: var(--text); color: var(--surface); padding: 8px 10px; border-radius: 8px; font-size: 12px; white-space: nowrap; z-index: 5; display: flex; flex-direction: column; gap: 2px; pointer-events: none; }
.xlabels { display: flex; gap: 6px; margin-left: 42px; margin-top: 6px; }
.xlabels span { flex: 1; text-align: center; white-space: nowrap; }
</style>
