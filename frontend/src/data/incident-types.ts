/** 故障停机核验相关数据结构：泵站故障记录、排水管段溢流复核事项。 */

/** 故障记录所处阶段：待恢复（故障中）→ 待核验 → 已核验（关闭）。 */
export type FaultStage = '待恢复' | '待核验' | '已核验'

export type PumpFaultRecord = {
  id: number
  pumpId: number
  泵站编号: string
  泵站名称: string
  所在区域: string
  故障原因: string
  影响区域: string
  上报时间: string
  预计恢复时间: string
  /** 恢复自检已尝试次数：用于失败原因展示与重试入口。 */
  attempts: number
  stage: FaultStage
  核验说明: string
  核验时间: string
  closed: boolean
}

export type OverflowStatus = '待复核' | '已复核'

/** 故障核验通过后联动生成的排水管网页溢流复核事项。 */
export type OverflowReviewItem = {
  id: number
  faultId: number
  pumpId: number
  事项编号: string
  泵站编号: string
  泵站名称: string
  影响区域: string
  故障原因: string
  故障时间: string
  核验时间: string
  /** 建议复核的排水管段，尚未派单时为「待分派」。 */
  管段编号: string
  status: OverflowStatus
  复核说明: string
  复核时间: string
}

export type IncidentBundle = {
  pump_faults: PumpFaultRecord[]
  overflow_reviews: OverflowReviewItem[]
}
