<script setup>
// 文档版本记录（内容快照）：
// - 每个版本附带内容快照，可展开与「当前版本」逐字段比较（标题/分类/标签/可见性/正文）
// - 编辑者可对带快照的历史版本发起「恢复评审」，审批通过后追加新版本（不回滚版本链）
// - 被恢复过的旧版本标注「恢复边界：已恢复为 vX」；新版本标注「恢复自 vN」，双向可追溯
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { formatFull } from '@/utils/format'
import { canEditContent } from '@/utils/permission'
import {
  versionSnapshot, findVersion, canRestoreVersion, diffSnapshots, fieldLabels, docVersion
} from '@/utils/version'
import { versionReviewBadge, isVersionRestoreBadge, isRestoreReview, reviewBaseVersionLabel } from '@/utils/review'
import { stripHtml } from '@/utils/search'

const props = defineProps({
  doc: { type: Object, required: true },
  pendingReview: { type: Object, default: null }
})

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()

const currentN = computed(() => docVersion(props.doc))
const list = computed(() =>
  [...(props.doc.versions || [])].sort((a, b) => b.version - a.version)
)
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

// 展开的版本（查看与当前版本的内容差异）
const expanded = ref({})
// 恢复确认中的版本号
const restoringN = ref(null)
const restoreNote = ref('')
const busy = ref(false)
const restoreDone = ref('')

function snap(n) {
  const v = findVersion(props.doc, n)
  return versionSnapshot(props.doc, v)
}
const currentSnap = computed(() => snap(currentN.value) || {})

function diffOf(n) {
  const s = snap(n)
  if (!s) return []
  return diffSnapshots(currentSnap.value, s)
}
function fieldText(val, key) {
  if (key === 'categoryId') return kb.catMap[val]?.name || '（未分类）'
  if (key === 'tagIds') {
    const names = (val || []).map((id) => kb.tagMap[id]?.name).filter(Boolean)
    return names.length ? names.map((n2) => '#' + n2).join(' ') : '（无标签）'
  }
  if (key === 'visibility') return { public: '🌐 公开', team: '👥 团队', private: '🔒 私有' }[val] || val
  if (key === 'body') {
    const text = stripHtml(String(val || ''))
    return text.length > 140 ? text.slice(0, 140) + '…' : (text || '（空）')
  }
  return String(val || '（空）')
}

function toggle(n) { expanded.value = { ...expanded.value, [n]: !expanded.value[n] }
function startRestore(v) {
  restoringN.value = v.version
  restoreNote.value = ''
}
function cancelRestore() { restoringN.value = null; restoreNote.value = '' }

// 恢复评审与普通修改评审互斥（同一文档同时只允许一个流转中评审单）
const restoreLocked = computed(() => !!props.pendingReview)
const canSubmitRestore = computed(() =>
  canEditContent(auth.user?.role) && !restoreLocked.value
)

async function confirmRestore(v) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await reviewStore.submitRestoreReview(
      props.doc.id, v.version, restoreNote.value.trim(), auth.user
    )
    if (res.status === 'ok') {
      restoreDone.value = '已提交 v' + v.version + ' 的恢复评审'
      restoringN.value = null
      setTimeout(() => { restoreDone.value = '' }, 3000)
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的评审单，请等待当前评审结束后再发起恢复。')
    } else if (res.status === 'no-snapshot') {
      alert('该历史版本没有内容快照（升级前产生的旧记录），无法恢复，仅可查看版本信息。')
    } else if (res.status === 'missing') {
      alert('文档不存在或已被删除')
    } else if (res.status === 'denied') {
      alert('仅编辑者/管理员可发起版本恢复')
    }
  } finally {
    busy.value = false
  }
}

// 该版本是否正被某条流转中的恢复评审引用（点击可跳转评审面板位置）
const pendingRestoreOf = computed(() =>
  props.pendingReview && isRestoreReview(props.pendingReview) ? props.pendingReview : null
)
</script>

<template>
  <div class="versions">
    <div v-if="restoreDone" class="v-toast">✅ {{ restoreDone }}：文档已进入评审中，审批通过后生成恢复版本。</div>

    <div v-for="v in list" :key="v.version" class="ver" :class="{ current: v.version === currentN }">
      <div class="ver-head">
        <span class="vnum">v{{ v.version }}</span>
        <span v-if="v.version === currentN" class="vcur">当前</span>
        <span class="vnote">{{ v.note || '编辑' }}</span>
        <span v-if="isVersionRestoreBadge(v)" class="vbadge vb-restore">{{ isVersionRestoreBadge(v).text }}</span>
        <span v-else-if="versionReviewBadge(v)" class="vbadge" :class="'vb-' + versionReviewBadge(v).cls">{{ versionReviewBadge(v).text }}</span>
        <span v-if="pendingRestoreOf && pendingRestoreOf.restoreFromVersion === v.version" class="vbadge vb-wait">恢复评审中 → v{{ currentN + 1 }}</span>
        <span class="vwho">{{ userById[v.savedBy]?.name || v.savedBy }}</span>
        <span class="vtime">{{ formatFull(v.savedAt) }}</span>
        <button
          class="v-toggle"
          :disabled="!snap(v.version)"
          :title="snap(v.version) ? '与当前版本比较内容' : '升级前的旧版本无内容快照'"
          @click="toggle(v.version)"
        >{{ expanded[v.version] ? '收起比较' : '比较' }}</button>
      </div>

      <!-- 恢复边界：该历史快照曾被恢复为新版本 -->
      <div v-if="v.restoredTo && v.restoredTo.length" class="boundary">
        ↳ 恢复边界：本版本内容曾于恢复评审通过后发布为
        <template v-for="(link, i) in v.restoredTo" :key="i">
          <b v-if="i">、</b><b>v{{ link.version }}</b>
        </template>
        （旧记录保留，恢复后新增的内容不在本版本内）
      </div>

      <!-- 与当前版本的字段级比较 -->
      <div v-if="expanded[v.version]" class="vdiff">
        <div v-if="v.version === currentN" class="same-tip">这是当前版本，内容即文档现状。</div>
        <template v-else>
          <div v-if="!diffOf(v.version).length" class="same-tip">与当前版本内容一致（无字段差异）。</div>
          <div v-else class="d-title">与当前版本不同的字段：{{ fieldLabels(diffOf(v.version)).join('、') }}</div>
          <div v-for="k in diffOf(v.version)" :key="k" class="drow">
            <div class="dcol">
              <span class="dtag old">v{{ v.version }} · {{ fieldLabels([k])[0] }}</span>
              <span class="dval">{{ fieldText(snap(v.version)[k], k) }}</span>
            </div>
            <div class="darrow">→</div>
            <div class="dcol">
              <span class="dtag new">当前 v{{ currentN }} · {{ fieldLabels([k])[0] }}</span>
              <span class="dval">{{ fieldText(currentSnap[k], k) }}</span>
            </div>
          </div>

          <div class="v-actions">
            <template v-if="restoringN === v.version">
              <textarea
                v-model="restoreNote"
                rows="2"
                :placeholder="'向管理员说明恢复 v' + v.version + ' 的原因（可选，将作为评审说明留痕）'"
              ></textarea>
              <div class="v-act-row">
                <button class="btn sm primary" :disabled="busy" @click="confirmRestore(v)">提交恢复评审</button>
                <button class="btn sm ghost" :disabled="busy" @click="cancelRestore">取消</button>
              </div>
              <div class="v-act-hint">审批通过后将<b>追加</b>一个内容等于 v{{ v.version }} 的新版本，不删除任何后续版本；本记录会标记恢复边界。</div>
            </template>
            <template v-else>
              <button
                v-if="canSubmitRestore && canRestoreVersion(doc, v.version)"
                class="btn sm"
                @click="startRestore(v)"
              >↩ 恢复此版本（提交评审）</button>
              <span v-else-if="restoreLocked" class="v-locked-hint">文档评审中，暂不能发起恢复</span>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.versions { margin-top: 14px; padding: 12px 20px; }
.v-toast { font-size: 13px; color: #15803d; background: #f0fdf4; border: 1px solid #16a34a; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.ver { padding: 8px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.ver:last-child { border-bottom: none; }
.ver.current .vnum { color: var(--accent); }
.ver-head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.vnum { font-weight: 700; color: var(--primary); min-width: 34px; }
.vcur { font-size: 10px; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 0 7px; }
.vnote { flex: 1; min-width: 120px; }
.vwho { color: var(--text-2); }
.vtime { color: var(--text-3); }
.v-toggle { border: none; background: transparent; color: var(--primary); cursor: pointer; font-size: 12px; padding: 2px 6px; }
.v-toggle:disabled { color: var(--text-3); cursor: not-allowed; }
.vbadge { font-size: 11px; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.vb-ok { background: #dcfce7; color: #15803d; }
.vb-no { background: #fee2e2; color: #b91c1c; }
.vb-wait { background: #fef3c7; color: #b45309; }
.vb-restore { background: #ede9fe; color: #6d28d9; }
.boundary { margin: 6px 0 0 46px; font-size: 12px; color: #6d28d9; background: #faf5ff; border-left: 2px solid #a855f7; padding: 4px 10px; border-radius: 0 6px 6px 0; }
.vdiff { margin: 8px 0 4px 46px; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--panel-2); }
.same-tip, .d-title { font-size: 12px; color: var(--text-3); margin-bottom: 8px; }
.d-title b { color: var(--primary); }
.drow { display: flex; gap: 10px; align-items: stretch; margin-bottom: 8px; }
.dcol { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.darrow { color: var(--text-3); align-self: center; }
.dtag { font-size: 11px; border-radius: 4px; padding: 0 6px; align-self: flex-start; }
.dtag.old { background: #fee2e2; color: #b91c1c; }
.dtag.new { background: #dcfce7; color: #15803d; }
.dval { font-size: 12px; color: var(--text-2); word-break: break-word; }
.v-actions { margin-top: 8px; }
.v-actions textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 7px 10px; font-size: 13px; resize: vertical; outline: none; }
.v-actions textarea:focus { border-color: var(--primary); }
.v-act-row { display: flex; gap: 8px; margin-top: 7px; }
.v-act-hint { margin-top: 6px; font-size: 11px; color: var(--text-3); }
.v-locked-hint { font-size: 12px; color: var(--text-3); }
</style>
