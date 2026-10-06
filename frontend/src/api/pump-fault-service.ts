import { incidents, saveIncidents } from '@/data/incident-store'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import type { OverflowReviewItem, PumpFaultRecord } from '@/data/incident-types'

// 泵站运行的专属状态机：故障中 → 待核验 → 核验通过后才允许重新启动，任何一步都不允许跳级。
const MODULE_KEY = 'pump_station'
const MAX_ETA_MS = 7 * 24 * 60 * 60 * 1000

export type FaultResultCode =
  | 'OK'
  | 'NOT_FOUND'
  | 'INVALID_FORM'
  | 'DUPLICATE_FAULT'
  | 'FLOW_CONFLICT'
  | 'SELF_CHECK_FAILED'

export type FaultActionResult = {
  ok: boolean
  message: string
  code: FaultResultCode
  fault?: PumpFaultRecord
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间戳，粒度到分钟，直接写入记录。 */
export function nowStamp(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** datetime-local 控件给的是「YYYY-MM-DDTHH:mm」，按本地时区解析，不能直接 new Date 造成时区漂移。 */
function parseLocalDateTime(value: string): Date | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim())
  if (!matched) {
    return null
  }
  const [, year, month, day, hour, minute] = matched.map(Number)
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

export type FaultForm = {
  reason: string
  affectedArea: string
  eta: string
}

/** 上报校验：原因、影响区域必填；预计恢复时间必须可解析、晚于当前、且不超过 7 天。 */
export function validateFaultForm(form: FaultForm): { ok: boolean; message: string; eta?: string } {
  const reason = form.reason.trim()
  const affectedArea = form.affectedArea.trim()
  if (!reason) {
    return { ok: false, message: '故障原因为必填项，请说明本次停机的直接原因' }
  }
  if (!affectedArea) {
    return { ok: false, message: '影响区域为必填项，请填写故障可能波及的排水区域' }
  }
  const etaDate = parseLocalDateTime(form.eta)
  if (!etaDate) {
    return { ok: false, message: '预计恢复时间格式不正确，请选择具体的日期和时间' }
  }
  const diff = etaDate.getTime() - Date.now()
  if (diff <= 0) {
    return { ok: false, message: '预计恢复时间早于当前时间，时间不合理，请重新选择' }
  }
  if (diff > MAX_ETA_MS) {
    return { ok: false, message: '预计恢复时间超过 7 天，时间不合理，请先抢修再评估恢复时间' }
  }
  return { ok: true, message: '', eta: nowStamp(etaDate) }
}

function getPump(id: number): EntryRow | undefined {
  return listRows(MODULE_KEY).find((row) => Number(row.id) === id)
}

/** 状态落库：以当前存储里的状态为准做乐观检查，状态对不上说明已被另一笔操作抢先落库，本笔拒绝跳级。 */
function commitPumpStatus(id: number, expect: string, target: string): EntryRow | null {
  const rows = listRows(MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return null
  }
  if (String(rows[index].status) !== expect) {
    return null
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target === '运行中' || target === '故障中' || target === '待核验' || target === '待启机',
    abnormal: target === '故障中' || target === '待核验',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(MODULE_KEY, next)
  return updated
}

function persistFaults(records: PumpFaultRecord[]): void {
  const bundle = incidents()
  saveIncidents({ ...bundle, pump_faults: records })
}

function persistReviews(items: OverflowReviewItem[]): void {
  const bundle = incidents()
  saveIncidents({ ...bundle, overflow_reviews: items })
}

function nextFaultId(records: PumpFaultRecord[]): number {
  return records.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function nextReviewId(items: OverflowReviewItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function openFaultOf(pumpId: number): PumpFaultRecord | undefined {
  return incidents().pump_faults.find((item) => item.pumpId === pumpId && !item.closed)
}

// 允许发起上报的状态：待启机、运行中、已停机；已处于故障流程的会被重复上报校验拦下。
const REPORTABLE = new Set(['待启机', '运行中', '已停机'])

/** 上报故障：先进入「故障中」；同一泵站存在未关闭故障时只保留原记录，不重复建档。 */
export function reportPumpFault(id: number, form: FaultForm): FaultActionResult {
  const pump = getPump(id)
  if (!pump) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到编号为 ${id} 的泵站` }
  }
  const existing = openFaultOf(id)
  if (existing) {
    return {
      ok: false,
      code: 'DUPLICATE_FAULT',
      message: `该泵站已有一条${existing.stage === '待核验' ? '待核验' : '故障中'}的故障记录，不能重复上报，请先完成恢复与核验`,
      fault: existing,
    }
  }
  const current = String(pump.status)
  if (!REPORTABLE.has(current)) {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message: `泵站当前为「${current}」，不能上报故障，请刷新后按故障流程处理`,
    }
  }
  const validation = validateFaultForm(form)
  if (!validation.ok) {
    return { ok: false, code: 'INVALID_FORM', message: validation.message }
  }

  // 并发护栏：故障提交与恢复若同时发生，谁先把状态落库谁生效，后到的一笔状态对不上直接拒绝。
  const committed = commitPumpStatus(id, current, '故障中')
  if (!committed) {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message: '该泵站状态刚被另一笔操作更新（先落库者生效），本次上报已阻止，请刷新后重试',
    }
  }

  const records = [...incidents().pump_faults]
  const record: PumpFaultRecord = {
    id: nextFaultId(records),
    pumpId: id,
    泵站编号: String(pump['泵站编号'] ?? ''),
    泵站名称: String(pump['泵站名称'] ?? ''),
    所在区域: String(pump['所在区域'] ?? form.affectedArea.trim()),
    故障原因: form.reason.trim(),
    影响区域: form.affectedArea.trim(),
    上报时间: nowStamp(),
    预计恢复时间: validation.eta as string,
    attempts: 0,
    stage: '待恢复',
    核验说明: '',
    核验时间: '',
    closed: false,
  }
  records.push(record)
  persistFaults(records)
  return { ok: true, code: 'OK', message: '故障已上报，泵站进入「故障中」，完成核验前不得再次启动', fault: record }
}

/**
 * 恢复操作（现场抢修完成后提交）：进入「待核验」。
 * 第一次提交执行设备自检并确定性失败一次，让失败原因与重试入口可见；重试即放行。
 */
export function recoverPumpFault(id: number): FaultActionResult {
  const pump = getPump(id)
  if (!pump) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到编号为 ${id} 的泵站` }
  }
  const fault = openFaultOf(id)
  if (!fault) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: '没有找到该泵站的故障记录，无法执行恢复操作；若故障已核验关闭，请直接正常启动',
    }
  }
  if (fault.stage !== '待恢复') {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message: `该故障已进入「${fault.stage}」环节，不能重复恢复，请继续完成核验`,
      fault,
    }
  }
  if (String(pump.status) !== '故障中') {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message: `泵站当前状态为「${pump.status}」，与故障记录不一致（可能已被其他操作先落库），本次恢复已阻止，请刷新后重试`,
      fault,
    }
  }

  const records = incidents().pump_faults.map((item) =>
    item.id === fault.id ? { ...item, attempts: item.attempts + 1 } : item,
  )
  const updatedFault = records.find((item) => item.id === fault.id) as PumpFaultRecord
  if (updatedFault.attempts === 1) {
    persistFaults(records)
    return {
      ok: false,
      code: 'SELF_CHECK_FAILED',
      message: '恢复自检未通过：出水压力未达额定值，泵站仍保持「故障中」，请现场复核后重试恢复',
      fault: updatedFault,
    }
  }

  const committed = commitPumpStatus(id, '故障中', '待核验')
  if (!committed) {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message: '该泵站状态刚被另一笔操作更新（先落库者生效），本次恢复已阻止，请刷新后重试',
      fault: updatedFault,
    }
  }
  updatedFault.stage = '待核验'
  persistFaults(records.map((item) => (item.id === fault.id ? updatedFault : item)))
  return { ok: true, code: 'OK', message: '恢复自检通过，泵站进入「待核验」，请值班负责人完成核验', fault: updatedFault }
}

/** 核验通过：回到已停机、关闭故障记录，并在排水管网模块生成一条溢流复核事项。 */
export function verifyPumpFault(
  id: number,
  passed: boolean,
  note: string,
): FaultActionResult {
  const pump = getPump(id)
  if (!pump) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到编号为 ${id} 的泵站` }
  }
  const fault = openFaultOf(id)
  if (!fault) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: '没有找到待核验的故障记录，无法完成核验；故障记录可能已被关闭',
    }
  }
  if (fault.stage !== '待核验') {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message: `该故障当前为「${fault.stage === '待恢复' ? '故障中（尚未恢复）' : fault.stage}」，不能直接核验，请先完成恢复操作`,
      fault,
    }
  }
  const trimmedNote = note.trim()
  if (!trimmedNote) {
    return { ok: false, code: 'INVALID_FORM', message: '请填写核验说明后再提交核验结论' }
  }

  const stamp = nowStamp()
  const records = incidents().pump_faults.map((item) =>
    item.id === fault.id ? { ...item, attempts: item.attempts + 1 } : item,
  )
  const updatedFault = records.find((item) => item.id === fault.id) as PumpFaultRecord

  if (!passed) {
    // 核验不通过：退回故障中继续抢修，状态不允许从故障中直接跳到可启动。
    const committed = commitPumpStatus(id, '待核验', '故障中')
    if (!committed) {
      return {
        ok: false,
        code: 'FLOW_CONFLICT',
        message: '该泵站状态刚被另一笔操作更新（先落库者生效），本次核验已阻止，请刷新后重试',
      }
    }
    updatedFault.stage = '待恢复'
    updatedFault.核验说明 = `核验不通过：${trimmedNote}`
    persistFaults(records.map((item) => (item.id === fault.id ? updatedFault : item)))
    return { ok: true, code: 'OK', message: '核验未通过，泵站退回「故障中」，请重新抢修后再次恢复', fault: updatedFault }
  }

  const committed = commitPumpStatus(id, '待核验', '已停机')
  if (!committed) {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message: '该泵站状态刚被另一笔操作更新（先落库者生效），本次核验已阻止，请刷新后重试',
    }
  }
  updatedFault.stage = '已核验'
  updatedFault.closed = true
  updatedFault.核验说明 = trimmedNote
  updatedFault.核验时间 = stamp
  persistFaults(records.map((item) => (item.id === fault.id ? updatedFault : item)))

  const reviews = [...incidents().overflow_reviews]
  // 同一故障只生成一条溢流复核事项，核验退回再通过时不会重复建档。
  if (!reviews.some((item) => item.faultId === fault.id)) {
    const review: OverflowReviewItem = {
      id: nextReviewId(reviews),
      faultId: fault.id,
      pumpId: id,
      事项编号: `OVF-${String(nextReviewId(reviews)).padStart(4, '0')}`,
      泵站编号: fault.泵站编号,
      泵站名称: fault.泵站名称,
      影响区域: fault.影响区域,
      故障原因: fault.故障原因,
      故障时间: fault.上报时间,
      核验时间: stamp,
      管段编号: '待分派',
      status: '待复核',
      复核说明: '',
      复核时间: '',
    }
    reviews.push(review)
    persistReviews(reviews)
  }
  return { ok: true, code: 'OK', message: '核验通过，泵站已恢复停机待启；排水管网已生成溢流复核事项', fault: updatedFault }
}

/** 正常停机：仅运行中可操作，故障流程中的泵站不允许用正常停机绕开核验。 */
export function stopPump(id: number): FaultActionResult {
  const pump = getPump(id)
  if (!pump) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到编号为 ${id} 的泵站` }
  }
  if (openFaultOf(id)) {
    return { ok: false, code: 'FLOW_CONFLICT', message: '该泵站存在未关闭的故障记录，正常停机已锁定，请走故障恢复与核验流程' }
  }
  const committed = commitPumpStatus(id, '运行中', '已停机')
  if (!committed) {
    return { ok: false, code: 'FLOW_CONFLICT', message: `泵站当前不是「运行中」，不能正常停机，请刷新后重试` }
  }
  return { ok: true, code: 'OK', message: '泵站已正常停机' }
}

/** 启动泵站：核验未完成（故障中/待核验/存在未关闭故障）时一律禁止。 */
export function startPump(id: number): FaultActionResult {
  const pump = getPump(id)
  if (!pump) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到编号为 ${id} 的泵站` }
  }
  const openFault = openFaultOf(id)
  if (openFault) {
    return {
      ok: false,
      code: 'FLOW_CONFLICT',
      message:
        openFault.stage === '待核验'
          ? '故障核验尚未完成，泵站不能启动，请先完成核验'
          : '泵站处于故障中，恢复与核验完成前不得再次启动',
      fault: openFault,
    }
  }
  const current = String(pump.status)
  if (current !== '待启机' && current !== '已停机') {
    return { ok: false, code: 'FLOW_CONFLICT', message: `泵站当前为「${current}」，不满足启动条件，请刷新后重试` }
  }
  const committed = commitPumpStatus(id, current, '运行中')
  if (!committed) {
    return { ok: false, code: 'FLOW_CONFLICT', message: '该泵站状态刚被更新，请刷新后重试启动' }
  }
  return { ok: true, code: 'OK', message: '泵站已启动，当前状态「运行中」' }
}

export function pumpFaults(): PumpFaultRecord[] {
  return incidents().pump_faults
}

export function openPumpFaults(): PumpFaultRecord[] {
  return incidents()
    .pump_faults.filter((item) => !item.closed)
    .sort((a, b) => (a.上报时间 < b.上报时间 ? 1 : -1))
}

export function overflowReviews(): OverflowReviewItem[] {
  return [...incidents().overflow_reviews].sort((a, b) => (a.核验时间 < b.核验时间 ? 1 : -1))
}

/** 排水管网页完成一条溢流复核。 */
export function completeOverflowReview(
  reviewId: number,
  segment: string,
  note: string,
): { ok: boolean; message: string } {
  const segmentLabel = segment.trim() || '待分派'
  const trimmedNote = note.trim()
  if (!trimmedNote) {
    return { ok: false, message: '请填写现场复核情况说明后再提交' }
  }
  const items = incidents().overflow_reviews
  const target = items.find((item) => item.id === reviewId)
  if (!target) {
    return { ok: false, message: '没有找到这条溢流复核事项，可能已在其他页面被处理，请刷新列表' }
  }
  if (target.status === '已复核') {
    return { ok: false, message: '该溢流复核事项已完成，不用重复提交' }
  }
  persistReviews(
    items.map((item) =>
      item.id === reviewId
        ? { ...item, status: '已复核' as const, 管段编号: segmentLabel, 复核说明: trimmedNote, 复核时间: nowStamp() }
        : item,
    ),
  )
  return { ok: true, message: '溢流复核事项已闭环' }
}

/** 运营概览统计：处于故障流程中（故障中 + 待核验）的泵站数。 */
export function faultyPumpCount(): number {
  return listRows(MODULE_KEY).filter((row) => {
    const status = String(row.status)
    return status === '故障中' || status === '待核验'
  }).length
}

/** 预计恢复时间相对当前是否已超期，供页面提示。 */
export function etaOverdue(fault: PumpFaultRecord): boolean {
  const eta = parseLocalDateTime(fault.预计恢复时间)
  return eta !== null && eta.getTime() < Date.now()
}
