<template>
  <section class="page" data-module="drain_network">
    <header class="page-head">
      <div>
        <h2>排水管网管理</h2>
        <p class="page-desc">维护排水管段，围绕管段编号、上游节点、下游节点、管段长度做登记、筛选与状态流转。泵站故障核验通过后，这里会生成对应的溢流复核事项。</p>
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

    <section class="review-panel">
      <div class="review-head">
        <h3>溢流复核事项 <span class="review-badge">{{ pendingReviews.length }} 条待复核</span></h3>
        <button class="btn ghost" type="button" @click="reloadReviews">刷新事项</button>
      </div>
      <table v-if="reviews.length" class="data-table">
        <thead>
          <tr>
            <th>事项编号</th>
            <th>来源故障单</th>
            <th>泵站编号</th>
            <th>影响区域</th>
            <th>关联管段</th>
            <th>事项说明</th>
            <th>生成时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="review in reviews" :key="String(review.id)">
            <td>{{ review['复核事项编号'] }}</td>
            <td>{{ review['来源故障单'] }}</td>
            <td>{{ review['泵站编号'] }}</td>
            <td>{{ review['影响区域'] }}</td>
            <td>{{ review['关联管段'] }}</td>
            <td>{{ review['事项说明'] }}</td>
            <td>{{ review['生成时间'] }}</td>
            <td>{{ review.status }}</td>
            <td class="row-actions">
              <button
                v-if="review.status === '待复核'"
                class="link"
                type="button"
                @click="confirmReview(review)"
              >
                复核确认
              </button>
              <span v-else class="muted-text">已于 {{ review['复核时间'] }} 完成</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-state review-empty">
        <p class="empty-title">暂无溢流复核事项</p>
        <p class="empty-desc">泵站故障核验通过后，会按故障影响区域自动在此生成复核事项。</p>
        <button class="btn" type="button" @click="reloadReviews">重新拉取</button>
      </div>
      <p v-if="reviewError" class="error-text">{{ reviewError }}</p>
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
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listOverflowReviews,
  moduleMeta,
  resolveOverflowReview,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('drain_network')
const columns = ["管段编号", "上游节点", "下游节点", "管段长度", "断面尺寸", "设计坡度", "排水能力", "运行状况"]
const actions = ["标记淤积", "预警溢流", "确认封堵"]
const statuses = ["正常", "淤积预警", "溢流风险", "已封堵"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const reviews = ref<EntryRow[]>([])
const reviewError = ref('')
const pendingReviews = computed(() => reviews.value.filter((row) => String(row.status) === '待复核'))

const stats = computed(() => [
  { label: "管段总数", value: rows.value.length },
  { label: "淤积预警管段", value: rows.value.filter((row) => String(row.status) === '淤积预警').length },
  { label: "溢流风险管段", value: rows.value.filter((row) => String(row.status) === '溢流风险').length },
  { label: "待复核溢流事项", value: pendingReviews.value.length },
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

function reloadReviews() {
  reviewError.value = ''
  try {
    reviews.value = listOverflowReviews()
  } catch (error) {
    reviewError.value = error instanceof Error ? error.message : '溢流复核事项读取失败，请重试'
  }
}

function confirmReview(row: EntryRow) {
  reviewError.value = ''
  const result = resolveOverflowReview(Number(row.id))
  if (!result.ok) {
    reviewError.value = result.message
    return
  }
  reloadReviews()
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
