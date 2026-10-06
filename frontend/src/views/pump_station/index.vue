<template>
  <section class="page" data-module="pump_station">
    <header class="page-head">
      <div>
        <h2>泵站运行管理</h2>
        <p class="page-desc">维护泵站，围绕泵站编号、泵站名称、所在区域、水泵型号做登记、筛选与状态流转。故障停机须先上报并完成核验，未核验不得启动。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记泵站</button>
        <button class="btn" type="button" @click="exportRows">导出泵站运行清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="faultPhaseOf(row) === '待核验'" class="tag tag-warn">待核验</span>
            <span v-else-if="faultPhaseOf(row) === '已核验'" class="tag tag-danger">待恢复</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busyId === String(row.id)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无泵站运行数据，可先登记泵站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵站运行记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 上报故障弹窗：原因、影响区域、预计恢复时间 -->
    <div v-if="reportTarget" class="modal-mask" @click.self="closeReport">
      <div class="modal">
        <h3>上报故障停机</h3>
        <p class="modal-sub">
          {{ String(reportTarget['泵站名称']) }}（{{ String(reportTarget['泵站编号']) }}）提交后进入「故障中」，
          未完成故障核验不得再次启动。
        </p>
        <form class="modal-form" @submit.prevent="submitReport">
          <label class="form-item">
            <span>故障原因 <em>*</em></span>
            <textarea v-model="reportForm.reason" rows="2" placeholder="如：3#水泵过载跳闸，绕组温度异常"></textarea>
          </label>
          <label class="form-item">
            <span>影响区域 <em>*</em></span>
            <input v-model="reportForm.area" placeholder="如：城南片区滨河路低洼路段" />
          </label>
          <label class="form-item">
            <span>预计恢复时间 <em>*</em></span>
            <input v-model="reportForm.eta" type="datetime-local" />
            <small class="form-hint">必须晚于上报时间，且不超过 7 天</small>
          </label>
          <p v-if="reportError" class="error-text modal-error">{{ reportError }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" :disabled="submitting" @click="closeReport">取消</button>
            <button class="btn primary" type="submit" :disabled="submitting">
              {{ submitting ? '提交中…' : '确认上报故障' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 故障核验弹窗：可处理空态、失败原因、重试入口 -->
    <div v-if="verifyTarget" class="modal-mask" @click.self="closeVerify">
      <div class="modal">
        <h3>故障停机核验</h3>
        <p class="modal-sub">
          {{ String(verifyTarget['泵站名称']) }}（{{ String(verifyTarget['泵站编号']) }}）
        </p>

        <div v-if="verifyLoading" class="modal-empty">
          <p>正在加载故障记录…</p>
        </div>

        <div v-else-if="!verifyFault" class="modal-empty">
          <p class="empty-title">暂无可核验的故障记录</p>
          <p class="empty-desc">{{ verifyError || '该泵站没有未关闭的故障单，恢复操作缺少核验依据。' }}</p>
          <button class="btn" type="button" @click="loadVerifyFault">重新拉取</button>
        </div>

        <div v-else class="modal-form">
          <dl class="fault-detail">
            <div><dt>故障单号</dt><dd>{{ verifyFault['故障单号'] }}</dd></div>
            <div><dt>核验状态</dt><dd>{{ verifyFault.status }}</dd></div>
            <div><dt>上报时间</dt><dd>{{ verifyFault['上报时间'] }}</dd></div>
            <div><dt>故障原因</dt><dd>{{ verifyFault['故障原因'] }}</dd></div>
            <div><dt>影响区域</dt><dd>{{ verifyFault['影响区域'] }}</dd></div>
          </dl>

          <label v-if="verifyFault.status === '待核验'" class="form-item">
            <span>预计恢复时间 <em>*</em></span>
            <input v-model="verifyEta" type="datetime-local" />
            <small class="form-hint">核验时复核：须晚于上报时间且不超过 7 天</small>
          </label>
          <p v-else class="form-hint">
            核验时间：{{ verifyFault['核验时间'] }} ｜ 预计恢复：{{ verifyFault['预计恢复时间'] }}
          </p>

          <p v-if="verifyError" class="error-text modal-error">{{ verifyError }}</p>

          <div class="modal-actions">
            <button class="btn ghost" type="button" :disabled="submitting" @click="closeVerify">关闭</button>
            <template v-if="verifyFault.status === '待核验'">
              <button class="btn primary" type="button" :disabled="submitting" @click="submitVerify">
                {{ submitting ? '核验中…' : '核验通过' }}
              </button>
            </template>
            <template v-else>
              <button class="btn" type="button" :disabled="submitting" @click="submitRecover">
                {{ submitting ? '指令下发中…' : '恢复运行（重试）' }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listPumpFaults,
  moduleMeta,
  pendingFaultCount,
  recoverPumpStation,
  reportPumpFault,
  runAction as applyAction,
  verifiedFaultPumpCount,
  verifyPumpFault,
} from '@/api/local-service'
import type { EntryRow, PumpFaultForm } from '@/data/types'

const meta = moduleMeta('pump_station')
const columns = ["泵站编号", "泵站名称", "所在区域", "水泵型号", "额定流量", "运行电流", "运行时长", "运行状态"]
const statuses = ["待启机", "运行中", "已停机", "故障中"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const faultMap = ref<Map<string, EntryRow>>(new Map())
const busyId = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: "运行中泵站", value: rows.value.filter((row) => String(row.status) === '运行中').length },
  { label: "故障泵站", value: verifiedFaultPumpCount() },
  { label: "待核验故障", value: pendingFaultCount() },
  { label: "今日累计运行", value: 0 },
])

function openFaultOf(row: EntryRow): EntryRow | undefined {
  return faultMap.value.get(String(row['泵站编号']))
}

function faultPhaseOf(row: EntryRow): string {
  return String(openFaultOf(row)?.status ?? '')
}

// 行内动作按当前状态收口：故障中只能走故障核验，不能直接启动或停机。
function actionsFor(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待启机' || status === '已停机') {
    return ['启动泵站']
  }
  if (status === '运行中') {
    return ['正常停机', '上报故障']
  }
  if (status === '故障中') {
    return ['故障核验']
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '泵站登记入口尚未接入审批流'
}

function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// ---- 上报故障 ----
const reportTarget = ref<EntryRow | null>(null)
const reportForm = ref<PumpFaultForm>({ reason: '', area: '', eta: '' })
const reportError = ref('')
const submitting = ref(false)

function openReport(row: EntryRow) {
  reportTarget.value = row
  const defaultEta = new Date(Date.now() + 4 * 60 * 60 * 1000)
  reportForm.value = { reason: '', area: '', eta: toLocalInput(defaultEta) }
  reportError.value = ''
}

function closeReport() {
  if (submitting.value) {
    return
  }
  reportTarget.value = null
}

async function submitReport() {
  if (!reportTarget.value) {
    return
  }
  submitting.value = true
  reportError.value = ''
  try {
    const result = await reportPumpFault(Number(reportTarget.value.id), { ...reportForm.value })
    if (!result.ok) {
      reportError.value = result.message
      return
    }
    reportTarget.value = null
    await reload()
  } finally {
    submitting.value = false
  }
}

// ---- 故障核验 / 恢复 ----
const verifyTarget = ref<EntryRow | null>(null)
const verifyFault = ref<EntryRow | null>(null)
const verifyEta = ref('')
const verifyError = ref('')
const verifyLoading = ref(false)

function openVerify(row: EntryRow) {
  verifyTarget.value = row
  verifyFault.value = null
  verifyError.value = ''
  verifyEta.value = ''
  void loadVerifyFault()
}

function closeVerify() {
  if (submitting.value) {
    return
  }
  verifyTarget.value = null
}

// 拉取故障单：没有故障记录时展示可处理空态，并给出重试入口。
async function loadVerifyFault() {
  if (!verifyTarget.value) {
    return
  }
  verifyLoading.value = true
  verifyError.value = ''
  try {
    const pumpCode = String(verifyTarget.value['泵站编号'])
    const faults = listPumpFaults(pumpCode).filter((row) =>
      ['待核验', '已核验'].includes(String(row.status)),
    )
    verifyFault.value = faults[0] ?? null
    if (verifyFault.value && String(verifyFault.value.status) === '待核验') {
      const eta = String(verifyFault.value['预计恢复时间'] ?? '')
      verifyEta.value = eta ? eta.replace(' ', 'T') : ''
    }
    if (!verifyFault.value) {
      verifyError.value = '若确认刚上报过故障，请点「重新拉取」；恢复操作无故障记录时将被拒绝。'
    }
  } finally {
    verifyLoading.value = false
  }
}

async function submitVerify() {
  if (!verifyTarget.value) {
    return
  }
  submitting.value = true
  verifyError.value = ''
  try {
    const result = await verifyPumpFault(Number(verifyTarget.value.id), verifyEta.value)
    if (!result.ok) {
      verifyError.value = result.message
      return
    }
    verifyError.value = ''
    await Promise.all([loadVerifyFault(), reload()])
  } finally {
    submitting.value = false
  }
}

async function submitRecover() {
  if (!verifyTarget.value) {
    return
  }
  submitting.value = true
  verifyError.value = ''
  try {
    const result = await recoverPumpStation(Number(verifyTarget.value.id))
    if (!result.ok) {
      // 失败原因就地展示，弹窗保留并允许直接重试。
      verifyError.value = result.message
      await Promise.all([loadVerifyFault(), reload()])
      return
    }
    verifyTarget.value = null
    await reload()
  } finally {
    submitting.value = false
  }
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '上报故障') {
    openReport(row)
    return
  }
  if (action === '故障核验') {
    openVerify(row)
    return
  }
  busyId.value = String(row.id)
  try {
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    await reload()
  } finally {
    busyId.value = ''
  }
}

async function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const openFaults = listPumpFaults().filter((row) => ['待核验', '已核验'].includes(String(row.status)))
    faultMap.value = new Map(openFaults.map((row) => [String(row['泵站编号']), row]))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泵站运行列表读取失败'
  }
}

onMounted(reload)
</script>
