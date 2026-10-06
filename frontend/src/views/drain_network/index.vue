<template>
  <section class="page" data-module="drain_network">
    <header class="page-head">
      <div>
        <h2>排水管网管理</h2>
        <p class="page-desc">泵站故障核验通过后，这里会生成溢流复核事项，需现场确认管段是否发生倒灌、溢流并闭环。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记排水管段</button>
        <button class="btn" type="button" @click="exportRows">导出排水管网清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="incident-panel">
      <div class="incident-head">
        <h3>溢流复核事项（来自泵站故障核验）</h3>
        <button class="btn ghost" type="button" @click="reloadReviews">刷新事项</button>
      </div>
      <table v-if="reviews.length" class="data-table">
        <thead>
          <tr>
            <th>事项编号</th>
            <th>来源泵站</th>
            <th>影响区域</th>
            <th>故障原因</th>
            <th>故障时间</th>
            <th>核验通过时间</th>
            <th>复核管段</th>
            <th>状态</th>
            <th>处理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviews" :key="item.id">
            <td>{{ item.事项编号 }}</td>
            <td>{{ item.泵站编号 }} {{ item.泵站名称 }}</td>
            <td>{{ item.影响区域 }}</td>
            <td>{{ item.故障原因 }}</td>
            <td>{{ item.故障时间 }}</td>
            <td>{{ item.核验时间 }}</td>
            <td>{{ item.管段编号 }}</td>
            <td>
              <span :class="['tag', item.status === '已复核' ? 'tag-done' : 'tag-review']">{{ item.status }}</span>
              <p v-if="item.复核说明" class="cell-note">{{ item.复核说明 }}（{{ item.复核时间 }}）</p>
            </td>
            <td class="row-actions">
              <button v-if="item.status === '待复核'" class="link" type="button" @click="openReview(item)">
                现场复核
              </button>
              <span v-else class="muted-text">已闭环</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-block">
        <strong>暂无溢流复核事项</strong>
        <p>泵站故障核验通过后，系统会按影响区域自动在此生成一条待复核事项；完成现场复核后即可闭环。</p>
      </div>
    </section>

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
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无排水管网数据，可先登记排水管段</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条排水管网记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 现场复核弹窗 -->
    <div v-if="reviewTarget" class="modal-mask" @click.self="closeReview">
      <div class="modal">
        <div class="modal-head">
          <h3>溢流现场复核 · {{ reviewTarget.事项编号 }}</h3>
          <button class="link" type="button" @click="closeReview">关闭</button>
        </div>
        <dl class="detail-list">
          <div><dt>来源泵站</dt><dd>{{ reviewTarget.泵站编号 }} {{ reviewTarget.泵站名称 }}</dd></div>
          <div><dt>影响区域</dt><dd>{{ reviewTarget.影响区域 }}</dd></div>
          <div><dt>故障原因</dt><dd>{{ reviewTarget.故障原因 }}</dd></div>
          <div><dt>故障时间</dt><dd>{{ reviewTarget.故障时间 }}</dd></div>
        </dl>
        <form class="modal-form" @submit.prevent="submitReview">
          <label class="form-item">
            <span>实际复核管段编号（留空则保持「待分派」）</span>
            <input v-model="reviewForm.segment" placeholder="如：DRAI-0017" />
          </label>
          <label class="form-item">
            <span>现场复核情况（必填）</span>
            <textarea v-model="reviewForm.note" rows="2" placeholder="如：管段水位正常，未发现溢流痕迹，雨水口无淤积"></textarea>
          </label>
          <p v-if="reviewError" class="error-text form-error">{{ reviewError }}</p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="closeReview">取消</button>
            <button class="btn primary" type="submit">提交复核并闭环</button>
          </div>
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
  runAction as applyAction,
} from '@/api/local-service'
import { completeOverflowReview, overflowReviews } from '@/api/pump-fault-service'
import type { OverflowReviewItem } from '@/data/incident-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('drain_network')
const columns = ['管段编号', '上游节点', '下游节点', '管段长度', '断面尺寸', '设计坡度', '排水能力', '运行状况']
const actions = ['标记淤积', '预警溢流', '确认封堵']
const statuses = ['正常', '淤积预警', '溢流风险', '已封堵']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const reviews = ref<OverflowReviewItem[]>([])
const reviewTarget = ref<OverflowReviewItem | null>(null)
const reviewForm = ref({ segment: '', note: '' })
const reviewError = ref('')

const stats = computed(() => [
  { label: '管段总数', value: rows.value.length },
  { label: '淤积预警管段', value: rows.value.filter((row) => String(row.status) === '淤积预警').length },
  { label: '溢流风险管段', value: rows.value.filter((row) => String(row.status) === '溢流风险').length },
  { label: '待溢流复核事项', value: reviews.value.filter((item) => item.status === '待复核').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '排水管段登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openReview(item: OverflowReviewItem) {
  reviewTarget.value = item
  reviewForm.value = { segment: item.管段编号 === '待分派' ? '' : item.管段编号, note: '' }
  reviewError.value = ''
}

function closeReview() {
  reviewTarget.value = null
  reviewError.value = ''
}

function submitReview() {
  if (!reviewTarget.value) {
    return
  }
  const result = completeOverflowReview(reviewTarget.value.id, reviewForm.value.segment, reviewForm.value.note)
  if (!result.ok) {
    reviewError.value = result.message
    return
  }
  errorMessage.value = result.message
  closeReview()
  reload()
}

function reloadReviews() {
  reviews.value = overflowReviews()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadReviews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '排水管网列表读取失败'
  }
}

onMounted(reload)
</script>
