import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions, mergeDocFields } from '@/utils/version'
import { buildTimelineEntry } from '@/utils/review'
import { GAP } from '@/utils/gap'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { useAuthStore } from './auth'
import { useGapStore } from './gap'

export const useKbStore = defineStore('kb', () => {
  const docs = ref([])
  const categories = ref([])
  const tags = ref([])
  const comments = ref([])
  const loaded = ref(false)

  const catMap = computed(() => Object.fromEntries(categories.value.map((c) => [c.id, c])))
  const tagMap = computed(() => Object.fromEntries(tags.value.map((t) => [t.id, t])))

  async function loadAll() {
    if (loaded.value) return
    docs.value = await db.docs.toArray()
    categories.value = await db.categories.toArray()
    tags.value = await db.tags.toArray()
    comments.value = await db.comments.toArray()
    loaded.value = true
  }

  async function reloadDocs() {
    docs.value = await db.docs.toArray()
  }

  async function getDoc(id) {
    await loadAll()
    return docs.value.find((d) => d.id === id) || null
  }

  // 直接读库取最新文档，绕过内存缓存——编辑器打开文档、保存前校验时必须用最新数据，
  // 否则多窗口场景会基于过期快照判断，造成覆盖与版本记录丢失
  async function getDocFresh(id) {
    await loadAll()
    const fresh = await db.docs.get(id)
    return fresh || null
  }

  async function createDoc(payload, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const doc = {
      id: uid('doc'),
      title: payload.title || '无标题文档',
      categoryId: payload.categoryId || categories.value[0]?.id || null,
      tagIds: payload.tagIds || [],
      body: payload.body || '',
      visibility: payload.visibility || 'public',
      publishState: 'published',
      activeReviewId: null,
      ownerId: currentUser?.id || 'u-guest',
      editors: [currentUser?.id || 'u-guest'],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, savedAt: now, savedBy: currentUser?.id || 'u-guest', note: '创建文档' }]
    }
    await db.docs.add(doc)
    await reloadDocs()
    return doc
  }

  // 保存文档（乐观锁 + 三方合并）。
  // opts.baseVersion：编辑器打开文档时的版本号；保存时若库中版本更高，说明其他窗口已保存过
  // opts.base：编辑器打开时的字段快照，用于三方合并（只自动合并未被对方改动的字段）
  // opts.force：用户确认「以我的内容为准」时强制保存，冲突字段取本次提交值
  // 返回 { status: 'saved', doc, autoMerged } | { status: 'conflict', conflictFields, autoMerged, latest } | { status: 'missing' }
  async function updateDoc(id, patch, currentUser, note, opts = {}) {
    await loadAll()
    const now = new Date().toISOString()
    const savedBy = currentUser?.id || 'u-guest'
    let result = null
    // 读 + 写放在同一事务中，保证「检测版本 → 合并 → 追加版本记录」不被其他窗口的写入打断
    await db.transaction('rw', db.docs, db.accessRequests, async () => {
      const existing = await db.docs.get(id)
      if (!existing) { result = { status: 'missing' }; return }
      // 评审中锁定：仅管理员可直接写入（管理员写入通道为审批，这里兜底防御多窗口/共享链接绕过）
      if (existing.activeReviewId && savedBy !== 'u-guest') {
        const isAdmin = currentUser?.role === 'admin'
        if (!isAdmin) { result = { status: 'review-locked', latest: existing }; return }
      }
      // 非拥有者/非固定协作成员（如只读角色）写入：必须持有效限时协作授权，否则拒绝。
      // 防止仅前端放开编辑入口被多窗口/直接调用绕过；授权撤销或到期后保存立即收回
      const isOwnerOrEditor = existing.ownerId === savedBy || (existing.editors || []).includes(savedBy)
      const isContentRole = currentUser?.role === 'admin' || currentUser?.role === 'editor'
      if (!isOwnerOrEditor && !isContentRole && savedBy !== 'u-guest') {
        const grantReq = await db.accessRequests
          .where('docId').equals(id)
          .filter((r) => r.applicantId === savedBy).toArray()
        const collab = grantReq.find((r) => isGrantActive(r) && r.grant?.permission === ACCESS_PERM.COLLAB)
        if (!collab) { result = { status: 'access-denied', latest: existing }; return }
      }
      // 兼容已有文档：缺失的版本记录先补全，再在其后追加，历史版本永不丢弃
      const versions = ensureVersions(existing, now)
      const currentVersion = versions.length
      const hasConflict = opts.baseVersion != null && currentVersion > opts.baseVersion

      let fields = patch
      let autoMerged = []
      if (hasConflict) {
        if (!opts.base) {
          // 没有基线快照无法安全合并，除非强制保存，否则返回冲突由调用方决定
          if (!opts.force) {
            result = { status: 'conflict', conflictFields: Object.keys(patch), autoMerged, latest: existing }
            return
          }
        } else {
          const merge = mergeDocFields(existing, opts.base, patch)
          autoMerged = merge.autoMerged
          if (merge.conflicts.length && !opts.force) {
            result = { status: 'conflict', conflictFields: merge.conflicts, autoMerged, latest: existing }
            return
          }
          fields = merge.fields
          // 用户选择以本次提交为准：冲突字段强制采用我方值，其余字段仍是合并结果
          if (opts.force) for (const k of merge.conflicts) fields[k] = patch[k]
        }
      }

      const versionNote = autoMerged.length
        ? (note || '编辑文档') + '（自动合并：' + autoMerged.join('、') + '）'
        : (note || '编辑文档')
      const updated = {
        ...existing,
        ...fields,
        updatedAt: now,
        versions: [...versions, { version: currentVersion + 1, savedAt: now, savedBy, note: versionNote }]
      }
      await db.docs.put(updated)
      result = { status: 'saved', doc: updated, autoMerged }
    })
    await reloadDocs()
    return result
  }

  async function deleteDoc(id) {
    await db.docs.delete(id)
    await db.comments.where('docId').equals(id).delete()
    await db.shares.where('docId').equals(id).delete()
    // 评审单随文档一并清理（直接按索引删除，避免与 review store 循环依赖）
    await db.reviews.where('docId').equals(id).delete()
    // 访问申请/授权随文档一并清理（授权失去依附对象，详情、搜索、问答、编辑入口同步消失）
    await db.accessRequests.where('docId').equals(id).delete()
    // 关联该文档的缺口工单退回处理中：答案来源/送审关联随文档删除失效，需重新关联
    const now = new Date().toISOString()
    const linkedTickets = await db.gapTickets.where('docId').equals(id).toArray()
    for (const t of linkedTickets) {
      await db.gapTickets.update(t.id, {
        status: GAP.CLAIMED,
        docId: null,
        reviewId: null,
        resolvedAt: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('reset', 'system', '关联文档已删除，工单退回处理', now)]
      })
    }
    comments.value = comments.value.filter((c) => c.docId !== id)
    const gap = useGapStore()
    await Promise.all([reloadDocs(), gap.reload()])
  }

  async function addCategory(name, icon) {
    const cat = { id: uid('c'), name, icon: icon || 'doc' }
    await db.categories.add(cat)
    categories.value.push(cat)
    return cat
  }

  async function addTag(name, color) {
    const tag = { id: uid('t'), name, color: color || '#4f6ef7' }
    await db.tags.add(tag)
    tags.value.push(tag)
    return tag
  }

  // ---- 评论 ----
  async function addComment(docId, content, mentionIds, authorId) {
    const cmt = { id: uid('cmt'), docId, authorId, content, mentionIds: mentionIds || [], createdAt: new Date().toISOString() }
    await db.comments.add(cmt)
    comments.value.push(cmt)
    return cmt
  }

  function commentsOf(docId) {
    return comments.value
      .filter((c) => c.docId === docId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  return {
    docs, categories, tags, comments, loaded,
    catMap, tagMap, loadAll, reloadDocs, getDoc, getDocFresh, createDoc, updateDoc, deleteDoc,
    addCategory, addTag, addComment, commentsOf
  }
})