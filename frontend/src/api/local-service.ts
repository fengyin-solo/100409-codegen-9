import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult, PumpFaultForm } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 泵站故障核验相关的本地集合键：故障单和排水管段溢流复核事项都随业务数据一起持久化。
const PUMP_KEY = 'pump_station'
const PUMP_FAULT_COLLECTION = 'pump_fault'
const OVERFLOW_REVIEW_COLLECTION = 'drain_overflow_review'
// 故障单未关闭的状态：待核验、已核验（核验通过但泵站还没恢复运行）。
const OPEN_FAULT_STATUSES = ['待核验', '已核验']
// 上报故障时允许给出的最长预计恢复窗口：7 天，再久视为预计时间不合理。
const MAX_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// 写操作串行队列：恢复与故障并发提交时，按进入队列的顺序依次落库，
// 后执行的任务必须基于先落库的状态重新校验，防止跳级。
let mutationQueue: Promise<unknown> = Promise.resolve()
function enqueueMutation<T>(task: () => T): Promise<T> {
  const run = mutationQueue.then(() => task())
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function parseTime(value: string | number | boolean | undefined): Date | null {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const date = new Date(String(value).replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date
}

// 校验预计恢复时间：格式要能解析、必须晚于上报时间、且不能超过 7 天窗口。
// 返回空串表示通过，否则返回可直接展示给值班员的失败原因。
function validateEta(eta: string, reportedAt: Date): string {
  const etaDate = parseTime(eta)
  if (!etaDate) {
    return '预计恢复时间格式不正确，请重新选择'
  }
  if (etaDate.getTime() <= reportedAt.getTime()) {
    return '预计恢复时间必须晚于故障上报时间'
  }
  if (etaDate.getTime() - reportedAt.getTime() > MAX_RECOVERY_WINDOW_MS) {
    return '预计恢复时间不合理：距上报时间超过 7 天，请重新评估后再提交'
  }
  return ''
}

function pumpFaultRows(): EntryRow[] {
  return listRows(PUMP_FAULT_COLLECTION)
}

function findPump(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

// 取该泵站当前未关闭的故障单（待核验或已核验），重复上报只认这一条。
function findOpenFault(rows: EntryRow[], pumpCode: string): EntryRow | undefined {
  return rows.find(
    (row) => String(row['泵站编号']) === pumpCode && OPEN_FAULT_STATUSES.includes(String(row.status)),
  )
}

export function listPumpFaults(pumpCode = ''): EntryRow[] {
  const rows = pumpFaultRows()
  if (pumpCode === '') {
    return rows
  }
  return rows.filter((row) => String(row['泵站编号']) === pumpCode)
}

// 核验通过后，在排水管网页生成一条溢流复核事项；同一故障单只生成一次。
function ensureOverflowReview(fault: EntryRow): void {
  const reviews = listRows(OVERFLOW_REVIEW_COLLECTION)
  const faultCode = String(fault['故障单号'])
  if (reviews.some((row) => String(row['来源故障单']) === faultCode)) {
    return
  }
  const area = String(fault['影响区域'])
  const review: EntryRow = {
    id: nextId(reviews),
    status: '待复核',
    pending: true,
    abnormal: false,
    复核事项编号: `OVF-${String(reviews.length + 1).padStart(4, '0')}`,
    来源故障单: faultCode,
    泵站编号: fault['泵站编号'],
    影响区域: fault['影响区域'],
    关联管段: `待排查管段（${area}）`,
    事项说明: `泵站${String(fault['泵站编号'])}故障停机，${area}存在污水溢流风险，需现场复核水位与排水能力`,
    生成时间: formatDateTime(new Date()),
    复核时间: '',
  }
  saveRows(OVERFLOW_REVIEW_COLLECTION, [...reviews, review])
}

// 上报故障：必填原因、影响区域、预计恢复时间；只允许运行中的泵站上报，
// 同一泵站存在未关闭故障单时拒绝重复上报。
export function reportPumpFault(id: number, form: PumpFaultForm): Promise<ActionResult> {
  return enqueueMutation(() => {
    const reason = form.reason.trim()
    const area = form.area.trim()
    if (!reason || !area || !form.eta.trim()) {
      return { ok: false, message: '请填写故障原因、影响区域和预计恢复时间后再上报' }
    }
    const rows = listRows(PUMP_KEY)
    const pump = findPump(rows, id)
    if (!pump) {
      return { ok: false, message: `没有找到编号为 ${id} 的泵站` }
    }
    const current = String(pump.status)
    if (current !== '运行中') {
      return { ok: false, message: `泵站当前为「${current}」，只有运行中的泵站才能上报故障` }
    }
    const faults = pumpFaultRows()
    const pumpCode = String(pump['泵站编号'])
    const duplicated = findOpenFault(faults, pumpCode)
    if (duplicated) {
      return {
        ok: false,
        message: `该泵站已有未关闭的故障单 ${String(duplicated['故障单号'])}（${String(duplicated.status)}），同一故障只保留一条，请勿重复上报`,
      }
    }
    const reportedAt = new Date()
    const etaError = validateEta(form.eta, reportedAt)
    if (etaError) {
      return { ok: false, message: etaError }
    }
    const now = formatDateTime(reportedAt)
    const fault: EntryRow = {
      id: nextId(faults),
      status: '待核验',
      pending: true,
      abnormal: true,
      故障单号: `FLT-${String(faults.length + 1).padStart(4, '0')}`,
      泵站编号: pump['泵站编号'],
      泵站名称: pump['泵站名称'],
      故障原因: reason,
      影响区域: area,
      预计恢复时间: form.eta.replace('T', ' '),
      上报时间: now,
      核验时间: '',
      恢复时间: '',
      恢复尝试次数: 0,
    }
    saveRows(PUMP_FAULT_COLLECTION, [...faults, fault])
    const index = rows.findIndex((row) => Number(row.id) === id)
    const next = [...rows]
    next[index] = { ...pump, status: '故障中', pending: true, abnormal: true }
    saveRows(PUMP_KEY, next)
    return {
      ok: true,
      message: `故障已上报，泵站进入「故障中」，故障单 ${String(fault['故障单号'])} 待核验；未完成核验前不得再次启动`,
    }
  })
}

// 故障核验：没有故障单给空态；预计时间不合理时驳回并允许改填重试；
// 核验通过后泵站仍处于故障中（等待恢复），同时生成溢流复核事项。
export function verifyPumpFault(id: number, etaOverride = ''): Promise<ActionResult> {
  return enqueueMutation(() => {
    const rows = listRows(PUMP_KEY)
    const pump = findPump(rows, id)
    if (!pump) {
      return { ok: false, message: `没有找到编号为 ${id} 的泵站` }
    }
    const faults = pumpFaultRows()
    const fault = findOpenFault(faults, String(pump['泵站编号']))
    if (!fault) {
      return { ok: false, message: '没有找到该泵站的故障记录，无法核验' }
    }
    if (String(fault.status) === '已核验') {
      ensureOverflowReview(fault)
      return { ok: true, message: `故障单 ${String(fault['故障单号'])} 已核验通过，请执行恢复运行` }
    }
    const reportedAt = parseTime(fault['上报时间']) ?? new Date()
    const eta = etaOverride.trim() !== '' ? etaOverride : String(fault['预计恢复时间'])
    const etaError = validateEta(eta, reportedAt)
    if (etaError) {
      return { ok: false, message: `核验未通过：${etaError}` }
    }
    const faultIndex = faults.findIndex((row) => Number(row.id) === Number(fault.id))
    const updatedFault: EntryRow = {
      ...fault,
      status: '已核验',
      pending: false,
      预计恢复时间: eta.replace('T', ' '),
      核验时间: formatDateTime(new Date()),
    }
    const nextFaults = [...faults]
    nextFaults[faultIndex] = updatedFault
    saveRows(PUMP_FAULT_COLLECTION, nextFaults)
    ensureOverflowReview(updatedFault)
    return {
      ok: true,
      message: `故障单 ${String(updatedFault['故障单号'])} 核验通过，已在排水管网生成溢流复核事项；泵站保持故障中，待恢复运行`,
    }
  })
}

// 恢复运行：没有故障单、未核验、预计时间不合理、首次指令失败都要给出可重试的失败原因；
// 故障提交与恢复并发时，本任务在队列内重新读取已落库状态，按先落库的状态裁决。
export function recoverPumpStation(id: number): Promise<ActionResult> {
  return enqueueMutation(() => {
    const rows = listRows(PUMP_KEY)
    const pump = findPump(rows, id)
    if (!pump) {
      return { ok: false, message: `没有找到编号为 ${id} 的泵站` }
    }
    const faults = pumpFaultRows()
    const fault = findOpenFault(faults, String(pump['泵站编号']))
    if (!fault) {
      return { ok: false, message: '恢复失败：没有该泵站的故障记录，缺少核验依据' }
    }
    if (String(fault.status) !== '已核验') {
      return { ok: false, message: '恢复失败：故障尚未完成核验，不得启动，请先完成故障核验' }
    }
    const current = String(pump.status)
    if (current !== '故障中') {
      return { ok: false, message: `泵站状态已变更为「${current}」，恢复请求按先落库的状态驳回，请刷新后重试` }
    }
    const reportedAt = parseTime(fault['上报时间']) ?? new Date()
    const etaError = validateEta(String(fault['预计恢复时间']), reportedAt)
    if (etaError) {
      return { ok: false, message: `恢复失败：${etaError}，可在核验弹窗改填预计恢复时间后重试` }
    }
    const faultIndex = faults.findIndex((row) => Number(row.id) === Number(fault.id))
    const attempts = Number(fault['恢复尝试次数']) || 0
    // 纯前端没有真实 PLC 链路：恢复指令第一次下发按失败处理，用于演示失败原因与重试入口。
    if (attempts === 0) {
      const retriedFault: EntryRow = { ...fault, 恢复尝试次数: 1 }
      const nextFaults = [...faults]
      nextFaults[faultIndex] = retriedFault
      saveRows(PUMP_FAULT_COLLECTION, nextFaults)
      return { ok: false, message: '恢复操作失败：远程启机指令超时（第 1 次），请检查链路后点击重试' }
    }
    const recoveredAt = formatDateTime(new Date())
    const closedFault: EntryRow = { ...fault, status: '已恢复', pending: false, abnormal: false, 恢复时间: recoveredAt }
    const nextFaults = [...faults]
    nextFaults[faultIndex] = closedFault
    saveRows(PUMP_FAULT_COLLECTION, nextFaults)
    const index = rows.findIndex((row) => Number(row.id) === id)
    const next = [...rows]
    next[index] = { ...pump, status: '运行中', pending: true, abnormal: false }
    saveRows(PUMP_KEY, next)
    return { ok: true, message: `泵站已恢复运行，故障单 ${String(fault['故障单号'])} 关闭` }
  })
}

// 运营概览统计的故障泵站数：只统计核验通过、尚未恢复的故障单。
export function verifiedFaultPumpCount(): number {
  return pumpFaultRows().filter((row) => String(row.status) === '已核验').length
}

// 待核验故障数：上报后还没完成核验的故障单。
export function pendingFaultCount(): number {
  return pumpFaultRows().filter((row) => String(row.status) === '待核验').length
}

export function listOverflowReviews(): EntryRow[] {
  return listRows(OVERFLOW_REVIEW_COLLECTION)
}

export function resolveOverflowReview(id: number): ActionResult {
  const reviews = listRows(OVERFLOW_REVIEW_COLLECTION)
  const index = reviews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这条溢流复核事项' }
  }
  const current = reviews[index]
  if (String(current.status) === '已复核') {
    return { ok: false, message: '该溢流复核事项已确认，无需重复操作' }
  }
  const next = [...reviews]
  next[index] = { ...current, status: '已复核', pending: false, 复核时间: formatDateTime(new Date()) }
  saveRows(OVERFLOW_REVIEW_COLLECTION, next)
  return { ok: true, message: `溢流复核事项 ${String(current['复核事项编号'])} 已确认` }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 泵站的上报故障/故障核验/恢复运行走专属核验流程，通用动作入口不放行，
  // 且未完成故障核验（故障中）的泵站一律禁止从通用入口直接启动。
  if (key === PUMP_KEY && ['上报故障', '故障核验', '恢复运行'].includes(action)) {
    return { ok: false, message: `「${action}」需要在故障核验流程中提交核验信息，请使用行内对应入口` }
  }
  if (key === PUMP_KEY && action === '启动泵站' && current === '故障中') {
    return { ok: false, message: '泵站故障核验未完成，不得再次启动' }
  }
  if (key === PUMP_KEY && action === '启动泵站' && !['待启机', '已停机'].includes(current)) {
    return { ok: false, message: `泵站当前为「${current}」，不能直接启动，禁止跳级操作` }
  }
  if (key === PUMP_KEY && action === '正常停机' && current !== '运行中') {
    return { ok: false, message: `泵站当前为「${current}」，只有运行中的泵站才能正常停机，禁止跳级操作` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 重置泵站时连带清空故障单与排水管网的溢流复核事项，避免示例脏数据残留。
  if (key === PUMP_KEY) {
    saveRows(PUMP_FAULT_COLLECTION, [])
    saveRows(OVERFLOW_REVIEW_COLLECTION, [])
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '故障泵站', value: verifiedFaultPumpCount() },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
