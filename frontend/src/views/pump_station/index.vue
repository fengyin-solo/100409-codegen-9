<template>
  <section class="page" data-module="pump_station">
    <header class="page-head">
      <div>
        <h2>泵站运行管理</h2>
        <p class="page-desc">上报故障须填写原因、影响区域与预计恢复时间；故障中未完成恢复核验前，泵站不得再次启动。</p>
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

    <section class="incident-panel">
      <div class="incident-head">
        <h3>故障停机核验事项</h3>
        <button class="btn ghost" type="button" @click="reload">刷新事项</button>
      </div>
      <table v-if="openFaults.length" class="data-table">
        <thead>
          <tr>
            <th>泵站编号</th>
            <th>泵站名称</th>
            <th>故障原因</th>
            <th>影响区域</th>
            <th>上报时间</th>
            <th>预计恢复</th>
            <th>核验环节</th>
            <th>处理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="fault in openFaults" :key="fault.id">
            <td>{{ fault.泵站编号 }}</td>
            <td>{{ fault.泵站名称 }}</td>
            <td>{{ fault.故障原因 }}</td>
            <td>{{ fault.影响区域 }}</td>
            <td>{{ fault.上报时间 }}</td>
            <td>
              {{ fault.预计恢复时间 }}
              <span v-if="isOverdue(fault)" class="tag tag-warn">已超预计时间</span>
            </td>
            <td>
              <span :class="['tag', fault.stage === '待核验' ? 'tag-review' : 'tag-fault']">
                {{ fault.stage === '待恢复' ? '故障中·待恢复' : '待核验' }}
              </span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="openRecover(fault)">
                {{ fault.stage === '待核验' ? '查看恢复' : '恢复操作' }}
              </button>
              <button class="link" type="button" @click="openVerify(fault)">核验</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-block">
        <strong>暂无故障核验事项</strong>
        <p>当前没有故障中或待核验的泵站；从下方列表对运行异常的泵站执行「上报故障」即可发起核验流程。</p>
      </div>
    </section>

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
            <span v-if="faultMap.get(Number(row.id))" class="tag tag-fault">故障未闭环</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action.key"
              class="link"
              type="button"
              @click="dispatch(action.key, row)"
            >
              {{ action.label }}
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

    <!-- 上报故障弹窗 -->
    <div v-if="dialog === 'report'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <div class="modal-head">
          <h3>上报故障 · {{ activePump?.['泵站编号'] }}</h3>
          <button class="link" type="button" @click="closeDialog">关闭</button>
        </div>
        <div v-if="duplicateFault" class="empty-block">
          <strong>该泵站已有未闭环的故障记录</strong>
          <p>
            当前环节：{{ duplicateFault.stage === '待恢复' ? '故障中·待恢复' : '待核验' }}
            ，上报时间 {{ duplicateFault.上报时间 }}。同一故障只保留一条记录，不能重复上报。
          </p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="closeDialog">知道了</button>
            <button class="btn primary" type="button" @click="goHandleDuplicate">前往处理该故障</button>
          </div>
        </div>
        <form v-else class="modal-form" @submit.prevent="submitReport">
          <label class="form-item">
            <span>故障原因（必填）</span>
            <textarea v-model="form.reason" rows="2" placeholder="如：2号水泵轴承过热触发保护停机"></textarea>
          </label>
          <label class="form-item">
            <span>影响区域（必填）</span>
            <input v-model="form.affectedArea" placeholder="如：城东片区及滨河路低洼段" />
          </label>
          <label class="form-item">
            <span>预计恢复时间（必填，须晚于当前且不超过 7 天）</span>
            <input v-model="form.eta" type="datetime-local" />
          </label>
          <p v-if="formError" class="error-text form-error">
            {{ formError }}
            <button class="link" type="button" @click="resetReportForm">重置表单</button>
          </p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="closeDialog">取消</button>
            <button class="btn primary" type="submit">确认上报，进入故障中</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 恢复操作弹窗 -->
    <div v-if="dialog === 'recover'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <div class="modal-head">
          <h3>恢复操作 · {{ activeFault?.泵站编号 }}</h3>
          <button class="link" type="button" @click="closeDialog">关闭</button>
        </div>

        <div v-if="!activeFault" class="empty-block">
          <strong>没有可恢复的故障记录</strong>
          <p>未找到该泵站的故障记录：可能故障已核验关闭，或记录在其他页面被处理。</p>
          <div class="modal-actions">
            <button class="btn primary" type="button" @click="reloadAndRetry">重新拉取后重试</button>
          </div>
        </div>
        <template v-else>
          <dl class="detail-list">
            <div><dt>故障原因</dt><dd>{{ activeFault.故障原因 }}</dd></div>
            <div><dt>影响区域</dt><dd>{{ activeFault.影响区域 }}</dd></div>
            <div><dt>上报时间</dt><dd>{{ activeFault.上报时间 }}</dd></div>
            <div>
              <dt>预计恢复</dt>
              <dd>{{ activeFault.预计恢复时间 }}
                <span v-if="isOverdue(activeFault)" class="tag tag-warn">已超预计时间</span>
              </dd>
            </div>
            <div><dt>已尝试恢复</dt><dd>{{ activeFault.attempts }} 次</dd></div>
          </dl>

          <div v-if="activeFault.stage === '待核验'" class="empty-block">
            <strong>恢复自检已通过，等待核验</strong>
            <p>泵站已处于「待核验」，不能重复恢复；请直接提交故障核验。</p>
            <div class="modal-actions">
              <button class="btn" type="button" @click="closeDialog">关闭</button>
              <button class="btn primary" type="button" @click="switchToVerify">前往核验</button>
            </div>
          </div>
          <template v-else>
            <p v-if="recoverError" class="error-text form-error">
              <strong>恢复操作失败：</strong>{{ recoverError }}
            </p>
            <p v-else class="form-tip">提交后将执行出水压力与电流联动自检，自检通过进入「待核验」。</p>
            <div class="modal-actions">
              <button class="btn" type="button" @click="closeDialog">取消</button>
              <button class="btn primary" type="button" @click="submitRecover">
                {{ activeFault.attempts > 0 ? '重试恢复操作' : '提交恢复操作' }}
              </button>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- 故障核验弹窗 -->
    <div v-if="dialog === 'verify'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <div class="modal-head">
          <h3>故障核验 · {{ activeFault?.泵站编号 }}</h3>
          <button class="link" type="button" @click="closeDialog">关闭</button>
        </div>

        <div v-if="!activeFault" class="empty-block">
          <strong>没有待核验的故障记录</strong>
          <p>该故障可能已核验关闭或在其他页面被处理。</p>
          <div class="modal-actions">
            <button class="btn primary" type="button" @click="reloadAndRetry">重新拉取后重试</button>
          </div>
        </div>
        <div v-else-if="activeFault.stage !== '待核验'" class="empty-block">
          <strong>故障尚未完成恢复操作</strong>
          <p>当前为「故障中·待恢复」，核验环节未开放；状态不允许从故障中直接跳到已恢复。请先执行恢复操作。</p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="closeDialog">关闭</button>
            <button class="btn primary" type="button" @click="switchToRecover">先去恢复</button>
          </div>
        </div>
        <form v-else class="modal-form" @submit.prevent="submitVerify(true)">
          <dl class="detail-list">
            <div><dt>故障原因</dt><dd>{{ activeFault.故障原因 }}</dd></div>
            <div><dt>影响区域</dt><dd>{{ activeFault.影响区域 }}</dd></div>
            <div><dt>预计恢复</dt><dd>{{ activeFault.预计恢复时间 }}</dd></div>
            <div><dt>恢复尝试</dt><dd>{{ activeFault.attempts }} 次，自检已通过</dd></div>
          </dl>
          <label class="form-item">
            <span>核验说明（必填）</span>
            <textarea v-model="verifyNote" rows="2" placeholder="如：现场试运转30分钟，压力、电流正常，具备启机条件"></textarea>
          </label>
          <p v-if="verifyError" class="error-text form-error">{{ verifyError }}</p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="submitVerify(false)">核验不通过，退回抢修</button>
            <button class="btn primary" type="submit">核验通过，恢复停机待启</button>
          </div>
          <p class="form-tip">核验通过后运营概览的故障泵站数将回落，并在排水管网生成一条溢流复核事项。</p>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  etaOverdue,
  openPumpFaults,
  recoverPumpFault,
  reportPumpFault,
  startPump,
  stopPump,
  verifyPumpFault,
} from '@/api/pump-fault-service'
import type { PumpFaultRecord } from '@/data/incident-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pump_station')
const columns = ['泵站编号', '泵站名称', '所在区域', '水泵型号', '额定流量', '运行电流', '运行时长', '运行状态']
const statuses = ['待启机', '运行中', '已停机', '故障中', '待核验']

type DialogKind = '' | 'report' | 'recover' | 'verify'
type RowAction = 'start' | 'stop' | 'report' | 'recover' | 'verify'

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const faults = ref<PumpFaultRecord[]>([])
const openFaults = computed(() => faults.value.filter((item) => !item.closed))
const faultMap = computed(() => new Map(openFaults.value.map((item) => [item.pumpId, item])))

const dialog = ref<DialogKind>('')
const activePump = ref<EntryRow | null>(null)
const activeFault = ref<PumpFaultRecord | null>(null)
const duplicateFault = ref<PumpFaultRecord | null>(null)

const form = ref({ reason: '', affectedArea: '', eta: '' })
const formError = ref('')
const recoverError = ref('')
const verifyNote = ref('')
const verifyError = ref('')

const stats = computed(() => [
  { label: '运行中泵站', value: rows.value.filter((row) => String(row.status) === '运行中').length },
  {
    label: '故障泵站',
    value: rows.value.filter((row) => ['故障中', '待核验'].includes(String(row.status))).length,
  },
  { label: '待核验泵站', value: rows.value.filter((row) => String(row.status) === '待核验').length },
  { label: '今日累计运行（小时）', value: totalRunHoursToday() },
])

function totalRunHoursToday(): number {
  return rows.value.reduce((sum, row) => {
    const raw = Number(String(row['运行时长'] ?? '').replace(/[^0-9.]/g, ''))
    return sum + (Number.isFinite(raw) ? raw : 0)
  }, 0)
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): { key: RowAction; label: string }[] {
  const status = String(row.status)
  const list: { key: RowAction; label: string }[] = []
  if (status === '待启机' || status === '已停机') {
    list.push({ key: 'start', label: '启动泵站' })
  }
  if (status === '运行中') {
    list.push({ key: 'stop', label: '正常停机' })
  }
  if (status !== '故障中' && status !== '待核验') {
    list.push({ key: 'report', label: '上报故障' })
  } else {
    const fault = faultMap.value.get(Number(row.id))
    if (fault?.stage === '待核验') {
      list.push({ key: 'verify', label: '故障核验' })
    } else {
      list.push({ key: 'recover', label: '恢复操作' })
    }
  }
  return list
}

function isOverdue(fault: PumpFaultRecord): boolean {
  return etaOverdue(fault)
}

function defaultEta(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
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

function flash(message: string) {
  errorMessage.value = message
  window.setTimeout(() => {
    if (errorMessage.value === message) {
      errorMessage.value = ''
    }
  }, 4000)
}

function dispatch(key: RowAction, row: EntryRow) {
  errorMessage.value = ''
  if (key === 'start') {
    const result = startPump(Number(row.id))
    if (!result.ok) {
      flash(result.message)
      if (result.fault) {
        activeFault.value = result.fault
        dialog.value = result.fault.stage === '待核验' ? 'verify' : 'recover'
      }
    } else {
      flash(result.message)
    }
    reload()
    return
  }
  if (key === 'stop') {
    const result = stopPump(Number(row.id))
    flash(result.message)
    reload()
    return
  }
  if (key === 'report') {
    openReport(row)
    return
  }
  if (key === 'recover') {
    const fault = faultMap.value.get(Number(row.id)) ?? null
    activeFault.value = fault
    activePump.value = row
    recoverError.value = ''
    dialog.value = 'recover'
    return
  }
  if (key === 'verify') {
    const fault = faultMap.value.get(Number(row.id)) ?? null
    activeFault.value = fault
    activePump.value = row
    verifyNote.value = ''
    verifyError.value = ''
    dialog.value = 'verify'
  }
}

function openReport(row: EntryRow) {
  activePump.value = row
  activeFault.value = null
  duplicateFault.value = faultMap.value.get(Number(row.id)) ?? null
  form.value = { reason: '', affectedArea: '', eta: defaultEta() }
  formError.value = ''
  dialog.value = 'report'
}

function resetReportForm() {
  form.value = { reason: '', affectedArea: '', eta: defaultEta() }
  formError.value = ''
}

function goHandleDuplicate() {
  if (!duplicateFault.value) {
    closeDialog()
    return
  }
  const fault = duplicateFault.value
  dialog.value = fault.stage === '待核验' ? 'verify' : 'recover'
  activeFault.value = fault
  duplicateFault.value = null
}

function submitReport() {
  if (!activePump.value) {
    return
  }
  const result = reportPumpFault(Number(activePump.value.id), form.value)
  if (!result.ok) {
    formError.value = result.message
    if (result.code === 'DUPLICATE_FAULT' && result.fault) {
      duplicateFault.value = result.fault
    }
    return
  }
  flash(result.message)
  closeDialog()
  reload()
}

function openRecover(fault: PumpFaultRecord) {
  activeFault.value = fault
  activePump.value = rows.value.find((row) => Number(row.id) === fault.pumpId) ?? null
  recoverError.value = ''
  dialog.value = 'recover'
}

function submitRecover() {
  if (!activeFault.value) {
    return
  }
  const result = recoverPumpFault(activeFault.value.pumpId)
  if (!result.ok) {
    recoverError.value = result.message
    if (result.fault) {
      activeFault.value = result.fault
    }
    if (result.code === 'NOT_FOUND') {
      activeFault.value = null
    }
    reloadFaults()
    return
  }
  recoverError.value = ''
  activeFault.value = result.fault ?? activeFault.value
  flash(result.message)
  reload()
}

function switchToVerify() {
  if (!activeFault.value) {
    return
  }
  verifyNote.value = ''
  verifyError.value = ''
  dialog.value = 'verify'
}

function switchToRecover() {
  if (!activeFault.value) {
    return
  }
  recoverError.value = ''
  dialog.value = 'recover'
}

function openVerify(fault: PumpFaultRecord) {
  activeFault.value = fault
  activePump.value = rows.value.find((row) => Number(row.id) === fault.pumpId) ?? null
  verifyNote.value = ''
  verifyError.value = ''
  dialog.value = 'verify'
}

function submitVerify(passed: boolean) {
  if (!activeFault.value) {
    return
  }
  const result = verifyPumpFault(activeFault.value.pumpId, passed, verifyNote.value)
  if (!result.ok) {
    verifyError.value = result.message
    if (result.code === 'NOT_FOUND') {
      activeFault.value = null
    }
    reloadFaults()
    return
  }
  flash(result.message)
  closeDialog()
  reload()
}

function reloadAndRetry() {
  reload()
  if (activePump.value) {
    activeFault.value = faultMap.value.get(Number(activePump.value.id)) ?? null
  }
  recoverError.value = ''
  verifyError.value = ''
}

function closeDialog() {
  dialog.value = ''
  activePump.value = null
  activeFault.value = null
  duplicateFault.value = null
  formError.value = ''
  recoverError.value = ''
  verifyError.value = ''
}

function reloadFaults() {
  faults.value = openPumpFaults()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadFaults()
    // 弹窗打开期间保持引用为最新落库状态。
    if (activeFault.value) {
      activeFault.value = faults.value.find((item) => item.id === activeFault.value?.id) ?? activeFault.value
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泵站运行列表读取失败'
  }
}

onMounted(reload)
</script>
