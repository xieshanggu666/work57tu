import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions, snapshotOf, diffSnapshots, mergeDocFields, withRestoreBoundary } from '@/utils/version'
import { REVIEW, REVIEW_KIND, PUBLISH, buildTimelineEntry } from '@/utils/review'
import { canEditContent } from '@/utils/permission'
import { GAP } from '@/utils/gap'
import { useKbStore } from './kb'
import { useGapStore } from './gap'

// 知识文档评审流程 store：
// 发起（快照待审内容、文档置为评审中并锁定）→ 成员发表评审意见 →
// 管理员通过（回写正文/可见性、追加带审批标记的版本）或驳回（解除锁定，内容不变）→
// 全程在评审单 timeline 与评审意见中留痕。
// 缺口工单送审（submitGapReview）：建评审单、锁文档、工单关联在同一事务内完成，
// 与审批/撤回事务互斥，不会出现「评审已完结但工单未关联」的卡单或孤立评审单。
// 评审单若由缺口工单发起（gapTickets.reviewId 关联），审批结果在同一事务内联动工单：
// 通过 → 工单置为已解决并回填答案来源；驳回/撤回 → 工单退回处理中。
export const useReviewStore = defineStore('review', () => {
  const reviews = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    reviews.value = await db.reviews.toArray()
  }

  // 文档当前流转中的评审单（同一文档同时只允许一个）
  const pendingByDoc = computed(() => {
    const m = {}
    for (const r of reviews.value) {
      if (r.status === REVIEW.PENDING) m[r.docId] = r
    }
    return m
  })

  function pendingReviewOf(docId) {
    return pendingByDoc.value[docId] || null
  }

  function reviewsOfDoc(docId) {
    return reviews.value
      .filter((r) => r.docId === docId)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
  }

  // 评审单下的意见（按时间正序）
  function commentsOfReview(reviewId) {
    const kb = useKbStore()
    return kb.comments
      .filter((c) => c.reviewId === reviewId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  // 构造待审批评审单：snapshot 为本次提交待审批的字段快照，审批通过时据此回写，保证「先审后发」
  // baseSnapshot：发起评审时文档的内容快照，审批时用于检测评审期间的并发修改并做三方合并
  // kind=restore 时为版本恢复评审：restoreFromVersion 标记要回放的历史版本（恢复边界来源）
  function buildReviewRecord(docId, patch, note, userId, now, baseVersion, opts = {}) {
    const kind = opts.kind || REVIEW_KIND.EDIT
    return {
      id: uid('rev'),
      docId,
      kind,
      restoreFromVersion: kind === REVIEW_KIND.RESTORE ? opts.restoreFromVersion : null,
      status: REVIEW.PENDING,
      submittedBy: userId,
      submittedAt: now,
      snapshot: {
        title: patch.title,
        body: patch.body,
        categoryId: patch.categoryId,
        tagIds: patch.tagIds || [],
        visibility: patch.visibility
      },
      baseVersion,
      // 发起时的文档内容快照：审批通过时据此识别评审期间他人的直接保存，避免恢复/发布覆盖并发修改
      baseSnapshot: opts.baseSnapshot ? snapshotOf(opts.baseSnapshot) : null,
      decidedBy: null,
      decidedAt: null,
      decisionNote: '',
      timeline: [buildTimelineEntry(
        kind === REVIEW_KIND.RESTORE ? 'submit-restore' : 'submit',
        userId,
        note || (kind === REVIEW_KIND.RESTORE ? '申请恢复到 v' + opts.restoreFromVersion : ''),
        now
      )]
    }
  }

  // 发起内容修改评审。
  // patch：本次提交待审批的文档字段（title/body/categoryId/tagIds/visibility）
  // 文档在审批期间保持旧内容可见，但置为「评审中」并锁定编辑；审批通过后才回写
  async function submitReview(docId, patch, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.comments, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      const existingPending = await db.reviews
        .where('docId').equals(docId)
        .filter((r) => r.status === REVIEW.PENDING).first()
      if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }

      const review = buildReviewRecord(docId, patch, note, userId, now, ensureVersions(doc, now).length, {
        baseSnapshot: snapshotOf(doc)
      })
      await db.reviews.add(review)

      // 文档进入评审中：正文锁定，旧内容继续可见，待审批内容不提前泄露
      await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

      if (note && note.trim()) {
        const cmt = {
          id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
          content: note.trim(), mentionIds: [], createdAt: now
        }
        await db.comments.add(cmt)
        kb.comments.push(cmt)
      }
      result = { status: 'ok', review }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 发起版本恢复评审：编辑者选择某个带内容快照的历史版本，申请将其内容恢复为新版本。
  // 恢复不是回滚——审批通过后是「追加」一个内容等于历史快照的新版本，版本链不丢失；
  // 旧版本记录会被打上恢复去向（恢复边界），评审期间同样锁定文档、并发修改在审批时检测。
  // 返回状态：ok / duplicate / missing / no-snapshot（历史版本无快照不可恢复）/ denied
  async function submitRestoreReview(docId, fromVersion, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }

    if (!canEditContent(currentUser?.role)) return { status: 'denied' }

    await db.transaction('rw', db.docs, db.reviews, db.comments, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      const versions = ensureVersions(doc, now)
      const target = versions.find((v) => v.version === fromVersion)
      if (!target || !target.snapshot || target.version >= versions.length) {
        result = { status: 'no-snapshot' }; return
      }
      const existingPending = await db.reviews
        .where('docId').equals(docId)
        .filter((r) => r.status === REVIEW.PENDING).first()
      if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }

      const restoreNote = (note || '').trim() || ('申请将文档恢复到历史版本 v' + fromVersion + ' 的内容')
      const review = buildReviewRecord(docId, target.snapshot, restoreNote, userId, now, versions.length, {
        kind: REVIEW_KIND.RESTORE,
        restoreFromVersion: fromVersion,
        baseSnapshot: snapshotOf(doc)
      })
      await db.reviews.add(review)
      await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

      const cmt = {
        id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
        content: restoreNote, mentionIds: [], createdAt: now
      }
      await db.comments.add(cmt)
      kb.comments.push(cmt)
      result = { status: 'ok', review }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 缺口工单「关联文档送审」：创建评审单、锁定文档、工单置为送审中，在同一事务内完成。
  // 合并组（ticketId 为组主工单）共用一次送审：全组成员同时关联同一评审单与文档，
  // 任一步失败（含取消认领、解散、他人抢先送审等并发变化）整体回滚，不留孤立评审单或失效关联；
  // 与审批/撤回事务互斥，审批不可能插入「建单」与「工单关联」之间，工单不会卡在送审中。
  async function submitGapReview(ticketId, docId, patch, note, currentUser) {
    const kb = useKbStore()
    const gap = useGapStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    let submittedComment = null

    try {
      await db.transaction('rw', db.docs, db.reviews, db.comments, db.gapTickets, async () => {
        const ticket = await db.gapTickets.get(ticketId)
        if (!ticket) { result = { status: 'ticket-missing' }; return }

        // 合并组：主工单发起，全组统一送审；组成员单独送审直接拒绝
        const members = ticket.groupId
          ? await db.gapTickets.where('groupId').equals(ticket.groupId).toArray()
          : [ticket]
        const primary = members.find((m) => m.id === ticketId) || ticket
        if (ticket.groupId && (!primary || primary.groupId !== primary.id)) {
          result = { status: 'ticket-changed', ticket }; return
        }
        // 每张工单都必须仍处于「本人处理中」：解散组、移出、取消认领等并发变化整体回滚
        for (const m of members) {
          if (m.status !== GAP.CLAIMED || (m.claimedBy !== userId && !isAdmin)) {
            result = { status: 'ticket-changed', ticket: m }; return
          }
        }

        const doc = await db.docs.get(docId)
        if (!doc) { result = { status: 'doc-missing' }; return }
        const existingPending = await db.reviews
          .where('docId').equals(docId)
          .filter((r) => r.status === REVIEW.PENDING).first()
        if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }

        const review = buildReviewRecord(docId, patch, note, userId, now, ensureVersions(doc, now).length, {
          baseSnapshot: snapshotOf(doc)
        })
        await db.reviews.add(review)

        // 文档进入评审中：正文锁定，旧内容继续可见，待审批内容不提前泄露
        await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

        // 全组工单关联同一评审单：claimed → in_review，与评审单创建、文档锁定同生共死。
        // 各成员仍追加各自的 timeline 条目，提问与处理历史分别保留
        const grouped = members.length > 1
        for (const m of members) {
          const submitNote = grouped
            ? (m.id === primary.id
              ? '合并组（' + members.length + ' 个同类问题）关联文档《' + (doc.title || docId) + '》送审'
              : '合并组统一关联文档《' + (doc.title || docId) + '》送审')
            : '关联文档《' + (doc.title || docId) + '》送审'
          await db.gapTickets.update(m.id, {
            status: GAP.IN_REVIEW,
            docId,
            reviewId: review.id,
            timeline: [...(m.timeline || []), buildTimelineEntry('submit', userId, submitNote, now)]
          })
        }

        if (note && note.trim()) {
          submittedComment = {
            id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
            content: note.trim(), mentionIds: [], createdAt: now
          }
          await db.comments.add(submittedComment)
        }
        result = { status: 'ok', review }
      })
    } catch (e) {
      // 中途失败（如写入异常）：事务已整体回滚，无孤立评审单/残留锁定，按失败处理由调用方提示
      result = { status: 'error' }
      submittedComment = null
    }

    if (result.status === 'ok' && submittedComment) kb.comments.push(submittedComment)
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  // 成员发表评审意见：同时写入 comments（联动评论区）与评审单 timeline（留痕）
  async function addReviewComment(reviewId, content, mentionIds, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let created = null

    await db.transaction('rw', db.reviews, db.comments, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review || review.status !== REVIEW.PENDING) return
      const cmt = {
        id: uid('cmt'), docId: review.docId, reviewId, authorId: userId,
        content, mentionIds: mentionIds || [], createdAt: now
      }
      await db.comments.add(cmt)
      await db.reviews.update(reviewId, {
        timeline: [...(review.timeline || []), buildTimelineEntry('comment', userId, content, now)]
      })
      created = cmt
    })

    if (created) {
      kb.comments.push(created)
      await reload()
    }
    return created
  }

  // 联动缺口工单：审批通过 → 已解决并回填答案来源（含发布版本号）；驳回/撤回 → 退回处理中。
  // 合并组共用同一 reviewId：所有成员一起解决或一起退回，组关系始终保留。
  // 须在评审决策的同一事务内调用（tables 需包含 db.gapTickets），保证两边状态一致
  async function syncGapTicket(reviewId, action, note, userId, now, sourceVersion) {
    const linked = await db.gapTickets.where('reviewId').equals(reviewId).toArray()
    // 仅联动「送审中」的工单：其它状态说明关联已失效（如文档删除后退回、历史脏数据），
    // 不再回写，避免审批结论覆盖已修正的工单状态
    const tickets = linked.filter((t) => t.status === GAP.IN_REVIEW)
    for (const ticket of tickets) {
      if (action === 'resolve') {
        const resolveNote = tickets.length > 1 && ticket.groupId
          ? '合并组送审批量通过，答案来源已回填'
          : '审批通过，答案来源已回填'
        await db.gapTickets.update(ticket.id, {
          status: GAP.RESOLVED,
          resolvedAt: now,
          // 记录答案来源对应的文档版本；后续版本恢复时据此识别并更新引用
          sourceVersion: sourceVersion || null,
          timeline: [...(ticket.timeline || []), buildTimelineEntry('resolve', userId, resolveNote, now)]
        })
      } else {
        // 退回处理：保留关联文档与合并组关系便于修改后重新送审，仅解除评审单关联
        const reason = action === 'return'
          ? '评审驳回' + (note ? '：' + note : '') + '，退回处理'
          : '评审已撤回，退回处理'
        await db.gapTickets.update(ticket.id, {
          status: GAP.CLAIMED,
          reviewId: null,
          timeline: [...(ticket.timeline || []), buildTimelineEntry('return', userId, reason, now)]
        })
      }
    }
  }

  // 版本恢复审批通过后更新问答引用：
  // 已解决的缺口工单以本文档为「答案来源」，恢复发布新版本后来源内容随之变化，
  // 把 sourceVersion 指向新版本并在工单 timeline 留痕，问答页引用始终展示最新来源版本。
  // 仅更新版本号落后的工单，重复审批/重复恢复不产生重复留痕。须在决策事务内调用。
  async function resyncGapCitations(docId, nextVersion, userId, now, reviewId) {
    const resolved = await db.gapTickets
      .where('docId').equals(docId)
      .filter((t) => t.status === GAP.RESOLVED && t.sourceVersion !== nextVersion)
      .toArray()
    for (const ticket of resolved) {
      const fromV = ticket.sourceVersion
      await db.gapTickets.update(ticket.id, {
        sourceVersion: nextVersion,
        timeline: [
          ...(ticket.timeline || []),
          buildTimelineEntry(
            'resync-source',
            userId,
            '文档恢复发布 v' + nextVersion + (fromV ? '（原引用 v' + fromV + '）' : '') + '，答案来源已更新',
            now
          )
        ]
      })
    }
  }

  // 管理员审批：approve 通过 / reject 驳回。
  // 通过：把待审批快照回写到文档（含可见性），追加「审批通过」版本，解除评审中状态；
  // 驳回：文档内容与可见性保持发起前不变，仅解除锁定并留痕。
  // opts.force：评审期间文档被管理员/其他窗口直接保存过（版本漂移）且存在无法自动合并的字段时，
  // 以待审快照为准覆盖冲突字段；否则返回 drift-conflict 由管理员确认，避免静默覆盖并发修改。
  async function decideReview(reviewId, decision, note, currentUser, opts = {}) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.gapTickets, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review) { result = { status: 'missing' }; return }
      if (review.status !== REVIEW.PENDING) { result = { status: 'closed', review }; return }

      const doc = await db.docs.get(review.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }

      const status = decision === 'approve' ? REVIEW.APPROVED : REVIEW.REJECTED
      const isRestore = review.kind === REVIEW_KIND.RESTORE || review.restoreFromVersion != null

      if (status === REVIEW.APPROVED) {
        // 并发修改检测：评审期间文档被直接保存过（版本号增长）。
        // 以发起时快照 baseSnapshot 为基线做三方合并：只改了一方的字段自动合并，双方都改的字段需管理员确认
        let fields = snapshotOf(review.snapshot)
        let autoMerged = []
        let conflictFields = []
        const versions = ensureVersions(doc, now)
        const drifted = versions.length > (review.baseVersion || versions.length)
        if (drifted && review.baseSnapshot) {
          const merge = mergeDocFields(snapshotOf(doc), review.baseSnapshot, fields)
          autoMerged = merge.autoMerged
          conflictFields = merge.conflicts
          fields = merge.fields
          if (conflictFields.length && !opts.force) {
            result = {
              status: 'drift-conflict',
              review,
              latest: doc,
              conflictFields,
              autoMerged
            }
            return
          }
          if (opts.force) for (const k of conflictFields) fields[k] = review.snapshot[k]
        }

        const nextVersion = versions.length + 1
        const approvedSnapshot = snapshotOf({ ...doc, ...fields })
        const baseNote = isRestore
          ? '版本恢复：恢复自 v' + review.restoreFromVersion + (note ? '：' + note : '')
          : '评审通过后发布' + (note ? '：' + note : '')
        const versionNote = autoMerged.length
          ? baseNote + '（自动合并：' + autoMerged.join('、') + '）'
          : baseNote

        let newVersionRecord = {
          version: nextVersion,
          savedAt: now,
          savedBy: review.submittedBy,
          note: versionNote,
          reviewStatus: REVIEW.APPROVED,
          reviewId,
          decidedBy: userId,
          snapshot: approvedSnapshot
        }
        let nextVersions = [...versions, newVersionRecord]
        // 恢复边界：被恢复的旧版本记录打上「已恢复为 vX」，新版本记录打上「恢复自 vN」，双向可追溯
        if (isRestore) {
          newVersionRecord = {
            ...newVersionRecord,
            restoreFrom: review.restoreFromVersion,
            restoreReviewId: reviewId
          }
          nextVersions = withRestoreBoundary(
            [...versions, newVersionRecord],
            review.restoreFromVersion, nextVersion, now, reviewId
          )
        }

        const updated = {
          ...doc,
          ...fields,
          publishState: PUBLISH.PUBLISHED,
          activeReviewId: null,
          updatedAt: now,
          lastReview: { reviewId, status, by: userId, at: now, note: note || '', version: nextVersion, kind: review.kind || 'edit' },
          versions: nextVersions
        }
        await db.docs.put(updated)

        const timeline = [
          ...(review.timeline || []),
          buildTimelineEntry(isRestore ? 'approve-restore' : 'approve', userId, note, now)
        ]
        await db.reviews.put({
          ...review,
          status,
          decidedBy: userId,
          decidedAt: now,
          decisionNote: note || '',
          publishedVersion: nextVersion,
          autoMerged,
          conflictFields,
          timeline
        })

        // 缺口工单联动：通过回填答案来源 / 驳回退回处理（同事务，状态不会脱节）
        await syncGapTicket(reviewId, 'resolve', note, userId, now, nextVersion)
        // 版本恢复：把本文档作为答案来源的已解决工单引用更新到新版本（问答引用随恢复同步）
        if (isRestore) await resyncGapCitations(review.docId, nextVersion, userId, now, reviewId)
        result = { status: 'ok', review: { ...review, status }, approved: true, publishedVersion: nextVersion, restored: isRestore }
      } else {
        const timeline = [
          ...(review.timeline || []),
          buildTimelineEntry('reject', userId, note, now)
        ]
        // 驳回不改内容，仅解除评审中锁定；驳回结论挂到文档上供详情页提示
        await db.docs.update(review.docId, {
          publishState: PUBLISH.PUBLISHED,
          activeReviewId: null,
          lastReview: { reviewId, status, by: userId, at: now, note: note || '', kind: review.kind || 'edit' }
        })
        await db.reviews.put({
          ...review,
          status,
          decidedBy: userId,
          decidedAt: now,
          decisionNote: note || '',
          timeline
        })
        // 缺口工单联动：驳回退回处理（同事务，状态不会脱节）
        await syncGapTicket(reviewId, 'return', note, userId, now)
        result = { status: 'ok', review: { ...review, status }, approved: false }
      }
    })

    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  // 发起人撤回评审：文档解除锁定，待审内容不生效
  async function withdrawReview(reviewId, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.gapTickets, async () => {
      const review = await db.reviews.get(reviewId)
      if (!review) { result = { status: 'missing' }; return }
      if (review.status !== REVIEW.PENDING || review.submittedBy !== userId) { result = { status: 'denied' }; return }
      const withdrawn = {
        ...review,
        status: REVIEW.WITHDRAWN,
        timeline: [...(review.timeline || []), buildTimelineEntry('withdraw', userId, '', now)]
      }
      await db.reviews.put(withdrawn)
      await db.docs.update(review.docId, { publishState: PUBLISH.PUBLISHED, activeReviewId: null })
      // 缺口工单联动：撤回送审，工单退回处理中
      await syncGapTicket(reviewId, 'withdraw', '', userId, now)
      result = { status: 'ok', review: withdrawn }
    })

    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  // 删除文档时连带清理评审单
  async function deleteReviewsOfDoc(docId) {
    await db.reviews.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  // 待我审批（管理员视角）/ 我发起的（编辑者视角）
  const pendingCount = computed(() => reviews.value.filter((r) => r.status === REVIEW.PENDING).length)

  return {
    reviews, loaded, loadAll, reload,
    pendingByDoc, pendingReviewOf, reviewsOfDoc, commentsOfReview,
    submitReview, submitRestoreReview, submitGapReview, addReviewComment, decideReview, withdrawReview,
    deleteReviewsOfDoc, pendingCount
  }
})
