import type { IncidentBundle } from './incident-types'

// 故障与溢流事项单独放在一个键里：和业务主表分开落库，互不影响。
const STORAGE_KEY = 'underground-pipeline-inspection:incidents'

// 首次打开的示例：2号泵站有一条未关闭的故障，恢复自检尚未通过，便于演示空态与重试。
const SEED_BUNDLE: IncidentBundle = {
  pump_faults: [
    {
      id: 1,
      pumpId: 2,
      泵站编号: 'PUMP-0002',
      泵站名称: '泵站运行样例2',
      所在区域: '泵站运行样例2',
      故障原因: '2号水泵轴承过热触发保护停机',
      影响区域: '泵站运行样例2及周边低洼路段',
      上报时间: '2026-09-02 09:20',
      预计恢复时间: '2026-09-03 12:00',
      attempts: 0,
      stage: '待恢复',
      核验说明: '',
      核验时间: '',
      closed: false,
    },
  ],
  overflow_reviews: [],
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): IncidentBundle {
  const fallback = clone(SEED_BUNDLE)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IncidentBundle>
    return {
      pump_faults: Array.isArray(parsed.pump_faults) ? parsed.pump_faults : clone(fallback.pump_faults),
      overflow_reviews: Array.isArray(parsed.overflow_reviews)
        ? parsed.overflow_reviews
        : clone(fallback.overflow_reviews),
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: IncidentBundle | null = null

export function incidents(): IncidentBundle {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveIncidents(next: IncidentBundle): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetIncidents(): IncidentBundle {
  const seeded = clone(SEED_BUNDLE)
  saveIncidents(seeded)
  return seeded
}

export function incidentStorageKey(): string {
  return STORAGE_KEY
}

// 另一个标签页先落库时清掉内存缓存，下次读取就是最新状态，避免拿旧状态覆盖新状态。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}
