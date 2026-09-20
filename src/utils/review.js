// 知识文档评审流程：状态常量、权限判定、留痕工具（均为纯函数，便于复用与测试）
import { ROLE, canEditContent } from './permission'

// 评审单类型
export const REVIEW_KIND = {
  EDIT: 'edit', // 内容修改评审：提交当前编辑内容
  RESTORE: 'restore' // 版本恢复评审：回放某个历史版本快照
}

// 评审单状态
export const REVIEW = {
  PENDING: 'pending', // 待审批：编辑者已发起，成员可评论，等待管理员处理
  APPROVED: 'approved', // 已通过：待审内容已回写文档
  REJECTED: 'rejected', // 已驳回：文档保持发起前内容，可修改后重新发起
  WITHDRAWN: 'withdrawn' // 已撤回：发起人主动撤回
}

// 文档发布状态（挂在 doc.publishState 上）
export const PUBLISH = {
  PUBLISHED: 'published', // 正常
  IN_REVIEW: 'in_review' // 评审中：有 pending 评审单，正文锁定
}

// 评审单是否仍在流转中
export function isReviewOpen(review) {
  return !!review && review.status === REVIEW.PENDING
}

// 文档是否处于评审中（存在待审批评审单时锁定正文）
export function isDocInReview(doc, pendingReview) {
  if (!doc) return false
  if (pendingReview) return true
  return doc.publishState === PUBLISH.IN_REVIEW
}

export function reviewStatusLabel(status) {
  return { pending: '待审批', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' }[status] || status
}

export function publishStateLabel(state) {
  return state === PUBLISH.IN_REVIEW ? '评审中' : '已发布'
}

// 发起评审：仅编辑者/管理员，且文档当前没有流转中的评审单
export function canSubmitReview(role, doc, pendingReview) {
  if (!doc || !canEditContent(role)) return false
  if (isDocInReview(doc, pendingReview)) return false
  return true
}

// 撤回评审：仅发起人本人（管理员可在评审中心直接处理，不提供撤回）
export function canWithdrawReview(review, userId) {
  return isReviewOpen(review) && review.submittedBy === userId
}

// 审批（通过/驳回）：仅管理员，且评审单仍在流转中
export function canReviewDecision(role, review) {
  return role === ROLE.ADMIN && isReviewOpen(review)
}

// 评审意见：任何登录成员都可以在评审单下评论；未登录访客不可
export function canCommentReview(role, review, userId) {
  return isReviewOpen(review) && !!userId && !!role
}

// 评审中是否允许直接编辑/保存正文：评审中一律锁定，仅管理员除外（管理员审批即为写入通道）
export function canEditDocDuringReview(role, doc, pendingReview) {
  if (!isDocInReview(doc, pendingReview)) return true
  return role === ROLE.ADMIN
}

// 版本记录上的评审标记
export function versionReviewBadge(v) {
  if (!v || !v.reviewStatus) return null
  if (v.reviewStatus === REVIEW.APPROVED) return { text: '审批通过', cls: 'ok' }
  if (v.reviewStatus === REVIEW.REJECTED) return { text: '审批驳回', cls: 'no' }
  if (v.reviewStatus === REVIEW.PENDING) return { text: '待审批', cls: 'wait' }
  return null
}

// 是否为版本恢复评审单（兼容旧数据：无 kind 字段一律视为普通修改评审）
export function isRestoreReview(review) {
  return !!review && (review.kind === REVIEW_KIND.RESTORE || review.restoreFromVersion != null)
}

export function reviewKindLabel(review) {
  return isRestoreReview(review) ? '版本恢复' : '内容修改'
}

// 评审单上记录的「基于版本」：恢复单展示其恢复来源版本
export function reviewBaseVersionLabel(review) {
  if (isRestoreReview(review)) return '恢复自 v' + (review.restoreFromVersion ?? review.baseVersion)
  return '基于 v' + review.baseVersion
}

// 审批通过发布的新版本号（评审单决策时记录，用于旧记录恢复边界之外的交叉引用）
export function isVersionRestoreBadge(v) {
  if (!v || v.restoreFrom == null) return null
  return { text: '恢复自 v' + v.restoreFrom, cls: 'restore' }
}

// 生成一条审批留痕（意见 + 操作人 + 时间），评审单的 timeline 全程保留
export function buildTimelineEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

export function timelineActionLabel(action) {
  return {
    submit: '发起评审',
    'submit-restore': '发起版本恢复评审',
    comment: '发表评审意见',
    approve: '审批通过',
    'approve-restore': '审批通过 · 发布恢复版本',
    reject: '审批驳回',
    withdraw: '撤回评审'
  }[action] || action
}
