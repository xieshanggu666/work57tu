<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useEngagementStore } from '@/stores/engagement'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import DocPill from '@/components/common/DocPill.vue'
import MemberSelect from '@/components/common/MemberSelect.vue'
import ShareDialog from '@/components/doc/ShareDialog.vue'
import ReviewPanel from '@/components/doc/ReviewPanel.vue'
import VersionHistory from '@/components/doc/VersionHistory.vue'
import AccessApplyCard from '@/components/doc/AccessApplyCard.vue'
import AccessPanel from '@/components/doc/AccessPanel.vue'
import { formatFull, formatDate, avatarColor } from '@/utils/format'
import { canEditDoc, canViewDoc } from '@/utils/permission'
import { ACCESS, accessPermLabel, grantExpireText } from '@/utils/access'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const engagement = useEngagementStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()

const doc = ref(null)
const notFound = ref(false)
const commentText = ref('')
const commentMentions = ref([])
const showVersions = ref(false)
const shareOpen = ref(false)
// 保存时自动合并了其他窗口修改的提示（由编辑器跳转携带）
const mergeNotice = ref('')
// 已提交评审的提示（由编辑器「提交评审」跳转携带）
const reviewSubmittedNotice = ref('')

const docId = computed(() => route.params.id)
// 兼容旧数据：早期文档可能没有 versions 字段
const versionList = computed(() => (doc.value?.versions?.length ? doc.value.versions : []))

async function refresh() {
  if (!docId.value) return
  await Promise.all([reviewStore.loadAll(), accessStore.loadAll()])
  const d = await kb.getDoc(docId.value)
  if (!d) { notFound.value = true; doc.value = null; return }
  notFound.value = false
  // 受限文档仍保留引用：能否查看由 hasAccess 响应式判定——
  // 授权被撤销/到期时 store 变化会即时切到「访问申请」卡片，无需刷新
  doc.value = d
  if (hasViewAccess.value) {
    await engagement.recordView(auth.user?.id, d.id)
    await engagement.refresh(auth.user?.id)
  }
}

// 当前用户在该文档上的有效限时授权（阅读/协作）
const activeGrant = computed(() => (doc.value ? accessStore.grantOf(doc.value.id, auth.user?.id) : null))
// 是否可查看详情（随授权记录响应式变化：撤销/到期即时收回）
const hasViewAccess = computed(() => doc.value ? canViewDoc(doc.value, auth.user?.id, null, activeGrant.value) : false)
const canEdit = computed(() => canEditDoc(auth.user?.role, doc.value, auth.user?.id, pendingReview.value, activeGrant.value))
const isFav = computed(() => engagement.isFavorite(docId.value))
const comments = computed(() => (doc.value ? kb.commentsOf(doc.value.id) : []))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const pendingReview = computed(() => (doc.value ? reviewStore.pendingReviewOf(doc.value.id) : null))
// 文档锁定提示：评审中正文保持旧版，编辑入口（非管理员）不可用
const reviewLocked = computed(() => !!pendingReview.value && auth.user?.role !== 'admin')
// 拥有者视角：管理本文档的访问申请
const isOwnerOrAdmin = computed(() => doc.value && (auth.user?.role === 'admin' || doc.value.ownerId === auth.user?.id))

async function doDelete() {
  if (!confirm('确定删除该文档？此操作不可恢复。')) return
  await kb.deleteDoc(doc.value.id)
  router.push('/docs')
}

async function postComment() {
  const content = commentText.value.trim()
  if (!content) return
  await kb.addComment(doc.value.id, content, commentMentions.value, auth.user?.id)
  commentText.value = ''
  commentMentions.value = []
}

function onMention(id) { if (!commentMentions.value.includes(id)) commentMentions.value.push(id) }

function renderMention(content) {
  return content.replace(/@([\u4e00-\u9fa5\w]+)/g, ($0, $1) => {
    const u = auth.users.find((x) => x.name === $1)
    return `<a class="at" href="#/docs/${route.params.id}">${$0}</a>`
  })
}

onMounted(() => {
  mergeNotice.value = route.query.merged || ''
  reviewSubmittedNotice.value = route.query.reviewSubmitted || ''
  refresh()
})
watch(docId, () => { if (route.name === 'docDetail') { refresh(); showVersions.value = false } })
</script>

<template>
  <div class="detail">
    <div v-if="notFound" class="empty"><div class="ico">❔</div>文档不存在或已被删除</div>

    <!-- 受限文档：可申请限时阅读/协作权限，由拥有者审批并生成授权记录；撤销/到期即时回到此卡片 -->
    <AccessApplyCard v-else-if="doc && !hasViewAccess" :doc="doc" />

    <template v-else-if="doc">
      <div v-if="mergeNotice" class="card merge-note">
        <span>ℹ️ 保存时已自动合并其他窗口对「{{ mergeNotice }}」的修改，双方内容均已保留</span>
        <button class="btn sm ghost" @click="mergeNotice = ''">知道了</button>
      </div>
      <div v-if="reviewSubmittedNotice" class="card review-submitted-note">
        <span>✅ 已提交评审：文档进入「评审中」，成员可发表意见，管理员审批通过后修改才会发布。</span>
        <button class="btn sm ghost" @click="reviewSubmittedNotice = ''">知道了</button>
      </div>
      <div v-if="reviewLocked" class="card review-lock">
        <span>⏳ 该文档正在评审中（{{ userById[pendingReview.submittedBy]?.name }} 发起）：当前展示的是评审前版本，正文已锁定，审批通过后更新。</span>
      </div>
      <div v-if="activeGrant" class="card grant-banner">
        <span>🔑 你正以「{{ accessPermLabel(activeGrant.grant.permission) }}」授权访问本文档，{{ grantExpireText(activeGrant) }}；到期或被撤销后访问权限将自动收回。</span>
      </div>
      <div class="page-head card">
        <div class="title-row">
          <h1 class="title">{{ doc.title }}</h1>
          <div class="actions">
            <button class="btn" :class="{ on: isFav }" @click="engagement.toggleFavorite(auth.user.id, doc.id)">{{ isFav ? '★ 已收藏' : '☆ 收藏' }}</button>
            <button class="btn" @click="shareOpen = true">🔗 分享</button>
            <button v-if="canEdit" class="btn" @click="router.push('/docs/' + doc.id + '/edit')">✎ 编辑</button>
            <button v-else-if="reviewLocked" class="btn" disabled title="评审中，请等待管理员审批">🔒 评审中</button>
            <button v-if="canEdit" class="btn danger" @click="doDelete">🗑 删除</button>
          </div>
        </div>
        <div class="meta-row">
          <DocPill :doc="doc" class="pills" />
          <span class="who">作者：{{ userById[doc.ownerId]?.name || doc.ownerId }}</span>
          <span class="who">更新：{{ formatFull(doc.updatedAt) }}</span>
          <button class="btn sm ghost" @click="showVersions = !showVersions">{{ showVersions ? '隐藏' : '查看' }}版本记录 ({{ versionList.length }})</button>
        </div>
      </div>

      <div v-if="showVersions" class="card">
        <VersionHistory :doc="doc" :pending-review="pendingReview" />
      </div>

      <article class="render card" v-html="doc.body"></article>

      <div class="meta card">
        <div class="row"><span class="k">协作成员</span><span class="v">
          <span v-for="ed in doc.editors" :key="ed" class="collab">
            <span class="ava" :style="{ background: avatarColor(ed) }">{{ ed.slice(0, 1) }}</span>{{ userById[ed]?.name || ed }}
          </span>
        </span></div>
        <div class="row"><span class="k">最近编辑</span><span class="v">{{ formatDate(doc.updatedAt) }} · {{ userById[doc.ownerId]?.name }}</span></div>
      </div>

      <ReviewPanel :doc="doc" />

      <!-- 拥有者/管理员：审批访问申请、管理限时授权（撤销到期同步收回四处权限） -->
      <AccessPanel v-if="isOwnerOrAdmin" :doc="doc" />

      <div class="comments card">
        <div class="c-title">评论与讨论（{{ comments.length }}）</div>
        <div v-if="!comments.length" class="c-empty">暂无评论，成为第一个讨论者吧</div>
        <div v-for="c in comments" :key="c.id" class="comment">
          <span class="ava big" :style="{ background: avatarColor(c.authorId) }">{{ userById[c.authorId]?.avatar || '?' }}</span>
          <div class="c-body">
            <div class="c-meta"><b>{{ userById[c.authorId]?.name || c.authorId }}</b><span class="c-time">{{ formatDate(c.createdAt) }}</span><span v-if="c.reviewId" class="c-review-tag">评审意见</span></div>
            <div class="c-content" v-html="renderMention(c.content)"></div>
            <div v-if="c.mentionIds.length" class="c-mention">提及：<span v-for="m in c.mentionIds" :key="m" class="pill">{{ userById[m]?.name }}</span></div>
          </div>
        </div>
        <div class="c-input">
          <MemberSelect v-model="commentText" @mention="onMention" />
          <button class="btn primary" :disabled="!commentText.trim()" @click="postComment">发表评论</button>
        </div>
      </div>

      <ShareDialog :open="shareOpen" :doc="doc" @close="shareOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.detail { max-width: 860px; margin: 0 auto; }
.merge-note { padding: 10px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: var(--primary); border-color: var(--primary); background: var(--primary-weak); }
.page-head { padding: 20px 24px; }
.title-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.title { margin: 0; font-size: 24px; }
.actions { display: flex; gap: 8px; }
.btn.on { background: var(--warn); border-color: var(--warn); color: #fff; }
.meta-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; color: var(--text-3); font-size: 12px; }
.pills { margin-right: 8px; }
.who { color: var(--text-3); }
.versions { margin-top: 14px; padding: 12px 20px; }
.ver { display: flex; gap: 14px; padding: 7px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.ver:last-child { border-bottom: none; }
.vnum { font-weight: 700; color: var(--primary); min-width: 40px; }
.vnote { flex: 1; }
.vwho { color: var(--text-2); }
.vtime { color: var(--text-3); }

.render { padding: 28px 32px; margin-top: 14px; line-height: 1.8; }
.render :deep(h1) { font-size: 26px; margin: 14px 0 8px; }
.render :deep(h2) { font-size: 21px; margin: 12px 0 8px; }
.render :deep(h3) { font-size: 17px; }
.render :deep(p) { margin: 8px 0; }
.render :deep(pre) { background: #1f2733; color: #dff2ff; padding: 12px 14px; border-radius: 8px; overflow: auto; }
.render :deep(code) { font-family: Menlo, Consolas, monospace; font-size: 13px; }
.render :deep(blockquote) { border-left: 3px solid var(--primary); margin: 8px 0; padding: 4px 12px; color: var(--text-2); background: var(--primary-weak); }
.render :deep(img) { max-width: 100%; border-radius: 6px; }

.meta { margin-top: 14px; padding: 16px 24px; }
.meta .row { display: flex; gap: 16px; padding: 6px 0; }
.meta .k { color: var(--text-3); width: 80px; }
.collab { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; }
.ava { width: 24px; height: 24px; border-radius: 50%; color: #fff; font-size: 11px; display: inline-grid; place-items: center; }
.ava.big { width: 34px; height: 34px; }

.comments { margin-top: 14px; padding: 20px 24px; }
.c-title { font-weight: 600; margin-bottom: 12px; }
.c-empty { color: var(--text-3); font-size: 13px; padding: 12px 0; }
.comment { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--panel-2); }
.c-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.c-time { color: var(--text-3); font-size: 12px; }
.c-content { color: var(--text); }
.c-mention { margin-top: 6px; display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-3); }
.c-input { display: flex; gap: 10px; align-items: flex-end; margin-top: 14px; }
.c-input > div { flex: 1; }
.versions a.at, .c-content :deep(a.at) { color: var(--primary); font-weight: 500; }
.review-lock { padding: 10px 18px; margin-bottom: 14px; font-size: 13px; color: #b45309; background: #fffbeb; border-color: #f59e0b; }
.grant-banner { padding: 10px 18px; margin-bottom: 14px; font-size: 13px; color: #6d28d9; background: #faf5ff; border-color: #a855f7; }
.review-submitted-note { padding: 10px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: #15803d; background: #f0fdf4; border-color: #16a34a; }
.vbadge { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.vb-ok { background: #dcfce7; color: #15803d; }
.vb-no { background: #fee2e2; color: #b91c1c; }
.vb-wait { background: #fef3c7; color: #b45309; }
.c-review-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--primary-weak); color: var(--primary); }
</style>