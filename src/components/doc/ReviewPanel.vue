<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useReviewStore } from '@/stores/review'
import { useAuthStore } from '@/stores/auth'
import MemberSelect from '@/components/common/MemberSelect.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  REVIEW, reviewStatusLabel, canWithdrawReview, canReviewDecision,
  canCommentReview, timelineActionLabel, isRestoreReview, reviewKindLabel, reviewBaseVersionLabel
} from '@/utils/review'
import { fieldLabels } from '@/utils/version'

const props = defineProps({
  doc: { type: Object, required: true }
})

const router = useRouter()
const reviewStore = useReviewStore()
const auth = useAuthStore()

const commentText = ref('')
const commentMentions = ref([])
const noteText = ref('')
const decisionOpen = ref(false)
const busy = ref(false)
const justDecided = ref('')
// 审批时发现评审期间存在并发直接保存（版本漂移）：待管理员确认冲突处理方式
const driftConflict = ref(null)

// 展开的历史评审单 id（最新一条默认展开）
const expanded = ref({})

const reviews = computed(() => reviewStore.reviewsOfDoc(props.doc.id))
const latest = computed(() => reviews.value[0] || null)
const pending = computed(() => reviewStore.pendingReviewOf(props.doc.id))
const history = computed(() => reviews.value.slice(pending.value ? 0 : 1, reviews.value.length))
const shownFirst = computed(() => pending.value || latest.value)

const pendingComments = computed(() =>
  pending.value ? reviewStore.commentsOfReview(pending.value.id) : []
)
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

// 待审批快照与当前文档的字段差异（提示审批通过后将发生的变化）
const diffs = computed(() => {
  if (!pending.value) return []
  const s = pending.value.snapshot || {}
  const d = props.doc
  const out = []
  if ((s.title || '') !== (d.title || '')) out.push('标题')
  if ((s.body || '') !== (d.body || '')) out.push('正文')
  if ((s.categoryId || '') !== (d.categoryId || '')) out.push('分类')
  if (JSON.stringify(s.tagIds || []) !== JSON.stringify(d.tagIds || [])) out.push('标签')
  if ((s.visibility || '') !== (d.visibility || '')) out.push('可见性')
  return out
})

function isExpanded(id) {
  if (id === shownFirst.value?.id) return true
  return !!expanded.value[id]
}
function toggle(id) { expanded.value = { ...expanded.value, [id]: !expanded.value[id] } }

async function postComment() {
  const content = commentText.value.trim()
  if (!content || !pending.value || busy.value) return
  busy.value = true
  try {
    await reviewStore.addReviewComment(pending.value.id, content, commentMentions.value, auth.user)
    commentText.value = ''
    commentMentions.value = []
  } finally {
    busy.value = false
  }
}
function onMention(id) { if (!commentMentions.value.includes(id)) commentMentions.value.push(id) }

async function decide(decision, force = false) {
  if (!pending.value || busy.value) return
  busy.value = true
  try {
    const res = await reviewStore.decideReview(pending.value.id, decision, noteText.value.trim(), auth.user, { force })
    if (res.status === 'ok') {
      justDecided.value = decision === 'approve'
        ? (res.restored ? '已通过，已发布恢复版本 v' + res.publishedVersion : '已通过，待审内容已发布')
        : '已驳回，文档保持原内容'
      decisionOpen.value = false
      driftConflict.value = null
      noteText.value = ''
      setTimeout(() => { justDecided.value = '' }, 3000)
    } else if (res.status === 'drift-conflict') {
      // 评审期间文档被直接保存过：展示冲突字段，管理员可自动合并其余字段后选择以待审内容覆盖冲突
      driftConflict.value = res
      decisionOpen.value = false
    } else {
      alert('操作失败：评审单状态已变化，请刷新后重试')
    }
  } finally {
    busy.value = false
  }
}

async function withdraw() {
  if (!pending.value) return
  if (!confirm('确定撤回本次评审？待审内容不会生效。')) return
  busy.value = true
  try {
    await reviewStore.withdrawReview(pending.value.id, auth.user)
  } finally {
    busy.value = false
  }
}

const canDecide = computed(() => canReviewDecision(auth.user?.role, pending.value))
const canWithdraw = computed(() => canWithdrawReview(pending.value, auth.user?.id))
const canComment = computed(() => canCommentReview(auth.user?.role, pending.value, auth.user?.id))
const pendingIsRestore = computed(() => isRestoreReview(pending.value))

function statusCls(r) {
  return { [REVIEW.PENDING]: 'st-pending', [REVIEW.APPROVED]: 'st-ok', [REVIEW.REJECTED]: 'st-no', [REVIEW.WITHDRAWN]: 'st-off' }[r.status]
}

watch(pending, (p) => { if (!p) decisionOpen.value = false })
</script>

<template>
  <div class="review card">
    <div class="rv-head">
      <span class="rv-title">🧾 知识评审</span>
      <span v-if="pending" class="kind-tag" :class="{ restore: pendingIsRestore }">
        {{ reviewKindLabel(pending) }}
      </span>
      <span v-if="pending" class="st st-pending">⏳ 待管理员审批</span>
      <span v-else-if="doc.lastReview" class="st" :class="statusCls({ status: doc.lastReview.status })">
        最近审批：{{ reviewStatusLabel(doc.lastReview.status) }}
      </span>
      <button v-if="!pending" class="btn sm primary" @click="router.push('/docs/' + doc.id + '/edit?submitReview=1')">
        发起评审
      </button>
    </div>

    <div v-if="justDecided" class="toast-line">✅ {{ justDecided }}</div>

    <!-- 流转中的评审单 -->
    <div v-if="pending" class="rv-body">
      <div v-if="pendingIsRestore" class="restore-tip">
        ↩ 本次为<b>版本恢复</b>：审批通过后将追加一个内容等于 v{{ pending.restoreFromVersion }} 的新版本（不删除后续版本），并同步更新引用本文档的问答答案来源。
      </div>
      <div class="rv-meta">
        <span class="who"><span class="ava" :style="{ background: avatarColor(pending.submittedBy) }">{{ userById[pending.submittedBy]?.avatar || '?' }}</span>
          {{ userById[pending.submittedBy]?.name || pending.submittedBy }} 发起评审
        </span>
        <span class="tm">{{ formatFull(pending.submittedAt) }}</span>
        <span class="ver">{{ reviewBaseVersionLabel(pending) }}</span>
      </div>

      <!-- 审批时检测到评审期间的并发直接保存：冲突字段需管理员决策 -->
      <div v-if="driftConflict" class="drift-bar">
        <div class="drift-head">⚠️ 评审期间文档被修改并保存过（版本已更新）</div>
        <div class="drift-desc">
          冲突字段：<b>{{ fieldLabels(driftConflict.conflictFields).join('、') }}</b>
          <template v-if="driftConflict.autoMerged?.length">；其余字段将自动合并：{{ fieldLabels(driftConflict.autoMerged).join('、') }}</template>。
        </div>
        <div class="decision-actions">
          <button class="btn sm ok-solid" :disabled="busy" @click="decide('approve', true)">以待审内容覆盖冲突并发布</button>
          <button class="btn sm ghost" :disabled="busy" @click="driftConflict = null; decisionOpen = true">返回再想想</button>
        </div>
      </div>

      <div v-if="diffs.length" class="diff-line">
        审批通过后将更新：<b v-for="(f, i) in diffs" :key="f">{{ i ? '、' : '' }}{{ f }}</b>
      </div>

      <!-- 评审意见（与文档评论区联动，此处是评审视角的聚合） -->
      <div class="rv-c-title">评审意见（{{ pendingComments.length }}）</div>
      <div v-if="!pendingComments.length" class="rv-c-empty">暂无评审意见，成员可在此发表看法</div>
      <div v-for="c in pendingComments" :key="c.id" class="rv-comment">
        <span class="ava" :style="{ background: avatarColor(c.authorId) }">{{ userById[c.authorId]?.avatar || '?' }}</span>
        <div class="rv-c-body">
          <div class="rv-c-meta"><b>{{ userById[c.authorId]?.name || c.authorId }}</b><span>{{ formatDate(c.createdAt) }}</span></div>
          <div>{{ c.content }}</div>
        </div>
      </div>

      <div v-if="canComment" class="rv-input">
        <MemberSelect v-model="commentText" @mention="onMention" />
        <button class="btn primary" :disabled="!commentText.trim() || busy" @click="postComment">发表意见</button>
      </div>
      <div v-else-if="pending" class="rv-login-tip">登录成员均可评论</div>

      <!-- 管理员审批 -->
      <div v-if="canDecide" class="decision">
        <button v-if="!decisionOpen" class="btn sm" @click="decisionOpen = true">审批处理</button>
        <template v-else>
          <textarea v-model="noteText" rows="2" placeholder="审批意见（可选，将留痕并同步到评论区时间线）"></textarea>
          <div class="decision-actions">
            <button class="btn sm" :disabled="busy" @click="decide('reject')">✕ 驳回（内容不变）</button>
            <button class="btn sm ok-solid" :disabled="busy" @click="decide('approve')">
              ✓ {{ pendingIsRestore ? '通过并发布恢复版本' : '通过并发布' }}
            </button>
            <button class="btn sm ghost" @click="decisionOpen = false">取消</button>
          </div>
        </template>
      </div>

      <div v-if="canWithdraw" class="withdraw-row">
        <button class="btn sm ghost" :disabled="busy" @click="withdraw">撤回评审</button>
      </div>
    </div>

    <!-- 无流转中的评审单：展示最近结论 -->
    <div v-else-if="doc.lastReview" class="last-decision">
      <p>
        <b>{{ userById[doc.lastReview.by]?.name || doc.lastReview.by }}</b>
        于 {{ formatDate(doc.lastReview.at) }} {{ reviewStatusLabel(doc.lastReview.status) }}
      </p>
      <p v-if="doc.lastReview.note" class="dnote">“{{ doc.lastReview.note }}”</p>
    </div>

    <!-- 历史评审单留痕 -->
    <div v-if="history.length || (shownFirst && !pending)" class="rv-history">
      <div class="rv-h-title">评审记录（{{ reviews.length }}）</div>
      <div v-if="shownFirst && !pending" class="h-item">
        <div class="h-head" @click="toggle(shownFirst.id)">
          <span class="st sm" :class="statusCls(shownFirst)">{{ reviewStatusLabel(shownFirst.status) }}</span>
          <span v-if="isRestoreReview(shownFirst)" class="kind-sm restore">版本恢复</span>
          <span class="h-who">{{ userById[shownFirst.submittedBy]?.name }}</span>
          <span class="h-tm">{{ formatDate(shownFirst.submittedAt) }}</span>
          <span class="h-arrow">{{ isExpanded(shownFirst.id) ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="isExpanded(shownFirst.id)" class="h-timeline">
          <div v-for="(t, i) in shownFirst.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ timelineActionLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || t.by }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </div>
      </div>
      <div v-for="r in history" :key="r.id" class="h-item">
        <div class="h-head" @click="toggle(r.id)">
          <span class="st sm" :class="statusCls(r)">{{ reviewStatusLabel(r.status) }}</span>
          <span v-if="isRestoreReview(r)" class="kind-sm restore">版本恢复</span>
          <span class="h-who">{{ userById[r.submittedBy]?.name }}</span>
          <span class="h-tm">{{ formatDate(r.submittedAt) }}</span>
          <span class="h-arrow">{{ isExpanded(r.id) ? '收起 ▲' : '展开 ▼' }}</span>
        </div>
        <div v-if="isExpanded(r.id)" class="h-timeline">
          <div v-for="(t, i) in r.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ timelineActionLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || t.by }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review { margin-top: 14px; padding: 18px 24px; }
.rv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rv-title { font-weight: 700; font-size: 15px; }
.rv-head .btn { margin-left: auto; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st.sm { font-size: 11px; padding: 1px 8px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.kind-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: var(--panel-2); color: var(--text-3); }
.kind-tag.restore, .kind-sm.restore { background: #ede9fe; color: #6d28d9; }
.kind-sm { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--text-3); }
.restore-tip { margin-top: 10px; font-size: 12px; color: #6d28d9; background: #faf5ff; border: 1px solid #ddd6fe; border-radius: 8px; padding: 8px 12px; }
.drift-bar { margin-top: 10px; border: 1px solid #f59e0b; background: #fffbeb; border-radius: 8px; padding: 10px 12px; }
.drift-head { font-weight: 600; color: #b45309; font-size: 13px; margin-bottom: 6px; }
.drift-desc { font-size: 12px; color: var(--text-2); margin-bottom: 8px; }
.drift-bar .decision-actions { margin-top: 2px; }
.toast-line { color: #15803d; font-size: 13px; margin-bottom: 10px; }
.rv-meta { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); flex-wrap: wrap; }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 24px; height: 24px; border-radius: 50%; color: #fff; font-size: 11px; display: inline-grid; place-items: center; }
.tm, .ver { color: var(--text-3); font-size: 12px; }
.diff-line { margin-top: 10px; font-size: 13px; color: var(--text-2); background: var(--primary-weak); border-radius: 8px; padding: 8px 12px; }
.diff-line b { color: var(--primary); margin-right: 2px; }
.rv-c-title { font-weight: 600; font-size: 13px; margin: 14px 0 8px; }
.rv-c-empty { color: var(--text-3); font-size: 13px; padding: 6px 0; }
.rv-comment { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--panel-2); }
.rv-c-meta { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-3); margin-bottom: 2px; }
.rv-c-body { font-size: 13px; }
.rv-input { display: flex; gap: 10px; align-items: flex-end; margin-top: 12px; }
.rv-input > div { flex: 1; }
.rv-login-tip { margin-top: 10px; color: var(--text-3); font-size: 12px; }
.decision { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border); }
.decision textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; margin-bottom: 8px; }
.decision textarea:focus { border-color: var(--primary); }
.decision-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.withdraw-row { margin-top: 10px; }
.last-decision { font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 10px 14px; }
.last-decision p { margin: 2px 0; }
.dnote { color: var(--text-3); }
.rv-history { margin-top: 14px; border-top: 1px solid var(--panel-2); padding-top: 10px; }
.rv-h-title { font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.h-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; overflow: hidden; }
.h-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; font-size: 13px; background: var(--panel-2); }
.h-who { font-weight: 600; }
.h-tm { color: var(--text-3); font-size: 12px; }
.h-arrow { margin-left: auto; color: var(--text-3); font-size: 12px; }
.h-timeline { padding: 8px 14px; }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 5px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 76px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
