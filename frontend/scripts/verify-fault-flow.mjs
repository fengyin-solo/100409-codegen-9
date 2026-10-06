// 临时验证脚本：在 node 里模拟 localStorage，走一遍故障核验全部规则。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const path = require('path')

// 直接用 esbuild 把 TS 服务转译成 JS 后再执行，避免引入测试框架。
import { build } from '/workspace/frontend/node_modules/esbuild/lib/main.js'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const dir = mkdtempSync(path.join(tmpdir(), 'pump-fault-'))
const entry = path.join(dir, 'entry.js')

const aliasPlugin = {
  name: 'at-alias',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => ({
      path: path.join('/workspace/frontend/src', args.path.slice(2) + '.ts'),
    }))
  },
}

const result = await build({
  entryPoints: ['/workspace/frontend/src/api/pump-fault-service.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [aliasPlugin],
})
writeFileSync(entry, result.outputFiles[0].text)

// --- 最小 localStorage / window 模拟 ---
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  },
  addEventListener() {},
}

const svc = await import(entry)
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function eta(daysFromNow, hours = 0) {
  const d = new Date(Date.now() + daysFromNow * 86400000 + hours * 3600000)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const {
  reportPumpFault,
  recoverPumpFault,
  verifyPumpFault,
  startPump,
  stopPump,
  openPumpFaults,
  overflowReviews,
  completeOverflowReview,
  faultyPumpCount,
} = svc

// 清空模拟存储后重新导入模块以获得干净种子
mem.clear()
// 重新导入模块缓存（模块内 cache 已初始化自 SEED），为拿到干净环境，用动态查询代替 reset
// 种子自带泵2故障，先验证种子状态。
check('种子：故障泵站数为 1（泵2 故障中）', faultyPumpCount() === 1, `actual=${faultyPumpCount()}`)
const seeded = openPumpFaults()
check('种子：存在 1 条未闭环故障(泵2)', seeded.length === 1 && seeded[0].pumpId === 2)

console.log('\n--- 场景1：泵1 正常上报 → 恢复（首次失败重试）→ 核验通过 → 启动解锁 + 溢流事项 ---')
let r = reportPumpFault(1, { reason: '叶轮卡滞', affectedArea: '城东片区', eta: eta(1) })
check('上报成功', r.ok && r.code === 'OK', r.message)
check('泵1 进入故障中', pumpStatus(1) === '故障中', pumpStatus(1))
check('上报后故障泵站数为 2', faultyPumpCount() === 2, `actual=${faultyPumpCount()}`)

// 未核验禁止启动
r = startPump(1)
check('故障中禁止启动', !r.ok && r.code === 'FLOW_CONFLICT', r.message)

// 重复上报只保留一条
r = reportPumpFault(1, { reason: '再次上报', affectedArea: '城北', eta: eta(2) })
check('重复上报被拒', !r.ok && r.code === 'DUPLICATE_FAULT', r.message)
check('故障记录仍只有 1 条(泵1)', openPumpFaults().filter((f) => f.pumpId === 1).length === 1)

// 恢复：首次自检失败
r = recoverPumpFault(1)
check('首次恢复自检失败', !r.ok && r.code === 'SELF_CHECK_FAILED', r.message)
check('失败后仍为故障中', pumpStatus(1) === '故障中')
// 重试成功
r = recoverPumpFault(1)
check('重试恢复成功进入待核验', r.ok && pumpStatus(1) === '待核验', r.message)
check('待核验仍禁止启动', !startPump(1).ok)
// 待核验再恢复被阻止（不能跳级/重复）
r = recoverPumpFault(1)
check('待核验阶段重复恢复被拒', !r.ok && r.code === 'FLOW_CONFLICT', r.message)

// 核验：说明必填
r = verifyPumpFault(1, true, '  ')
check('核验说明为空被拒', !r.ok && r.code === 'INVALID_FORM', r.message)
// 核验通过
r = verifyPumpFault(1, true, '试运转正常')
check('核验通过', r.ok, r.message)
check('泵1 回到已停机', pumpStatus(1) === '已停机', pumpStatus(1))
check('核验后故障泵站数回落为 1', faultyPumpCount() === 1, `actual=${faultyPumpCount()}`)
// 启动解锁
r = startPump(1)
check('核验通过后可启动', r.ok && pumpStatus(1) === '运行中', r.message)
// 溢流复核事项生成
const reviews = overflowReviews()
check('生成 1 条溢流复核事项且待复核', reviews.length === 1 && reviews[0].status === '待复核' && reviews[0].pumpId === 1)
// 复核闭环缺少说明
let cr = completeOverflowReview(reviews[0].id, 'DRAI-0009', '')
check('复核说明为空被拒', !cr.ok, cr.message)
cr = completeOverflowReview(reviews[0].id, 'DRAI-0009', '现场无溢流痕迹')
check('复核闭环成功', cr.ok, cr.message)
check('事项状态已复核', overflowReviews()[0].status === '已复核')

console.log('\n--- 场景2：核验不通过退回故障中，再次恢复+核验通过不重复生成溢流事项 ---')
r = reportPumpFault(3, { reason: '电源模块告警', affectedArea: '高新区', eta: eta(0, 6) })
check('泵3上报成功', r.ok, r.message)
recoverPumpFault(3) // 第一次失败
recoverPumpFault(3) // 第二次成功
r = verifyPumpFault(3, false, '压力不稳')
check('核验不通过退回故障中', r.ok && pumpStatus(3) === '故障中', r.message)
check('退回后故障泵站数=2', faultyPumpCount() === 2, `actual=${faultyPumpCount()}`)
check('退回后仍禁止启动', !startPump(3).ok)
recoverPumpFault(3) // 第三次：attempts 当前为3（首次失败+恢复成功+核验尝试），不为1，直接通过
check('再次恢复成功', pumpStatus(3) === '待核验', pumpStatus(3))
r = verifyPumpFault(3, true, '复测合格')
check('再次核验通过', r.ok && pumpStatus(3) === '已停机', r.message)
check('溢流事项总数仍为 2（不重复生成）', overflowReviews().length === 2, `actual=${overflowReviews().length}`)

console.log('\n--- 场景3：表单校验：空原因/空区域/时间在过去/超过7天 ---')
check('空原因被拒', reportPumpFault(1, { reason: '', affectedArea: '', eta: eta(1) }).code !== 'OK')
check('空区域被拒', !reportPumpFault(1, { reason: 'x', affectedArea: '', eta: eta(1) }).ok)
check('时间在过去被拒', reportPumpFault(1, { reason: 'x', affectedArea: 'y', eta: eta(-1) }).code === 'INVALID_FORM')
check('超过7天被拒', reportPumpFault(1, { reason: 'x', affectedArea: 'y', eta: eta(8) }).code === 'INVALID_FORM')
check('非法时间格式被拒', reportPumpFault(1, { reason: 'x', affectedArea: 'y', eta: 'not-a-date' }).code === 'INVALID_FORM')

console.log('\n--- 场景4：无故障记录的恢复/核验给出可处理失败 ---')
r = recoverPumpFault(1)
check('无故障记录恢复被拒(NOT_FOUND)', !r.ok && r.code === 'NOT_FOUND', r.message)
r = verifyPumpFault(1, true, '说明')
check('无故障记录核验被拒(NOT_FOUND)', !r.ok && r.code === 'NOT_FOUND', r.message)

console.log('\n--- 场景5：并发——恢复与故障提交竞争，先落库者生效、后到者被拒 ---')
// 泵1 当前运行中。直接先手动把泵1落库为故障中（模拟另一笔故障提交先落库），再调恢复
reportPumpFault(1, { reason: '并发故障', affectedArea: '南区', eta: eta(1) })
// 此时故障记录为待恢复、状态故障中。模拟「恢复」已先落库：直接调 recover 两次推进到待核验，
// 然后再尝试一次 report（模拟延迟到达的故障提交）
recoverPumpFault(1)
recoverPumpFault(1)
check('并发前置：泵1 已到待核验', pumpStatus(1) === '待核验')
r = reportPumpFault(1, { reason: '迟到的故障提交', affectedArea: 'z', eta: eta(1) })
check('迟到的故障提交被重复记录规则拦截', r.code === 'DUPLICATE_FAULT', r.code)
// 反向：故障中状态下，模拟「启动」这种跳级操作
const faultList = openPumpFaults().filter((f) => f.pumpId === 1)
check('泵1 仍只有一条故障记录', faultList.length === 1)

// 正常停机不能绕开故障
check('故障流程中正常停机被锁', !stopPump(1).ok)
// 先落库的恢复流程继续完成核验，迟到的上报不影响其走向
r = verifyPumpFault(1, true, '并发场景核验通过')
check('先落库的恢复流程核验通过', r.ok && pumpStatus(1) === '已停机', r.message)

console.log('\n--- 场景6：种子泵2 的恢复失败→重试→核验 全流程也可用 ---')
r = recoverPumpFault(2)
check('泵2首次恢复失败(可重试空态)', r.code === 'SELF_CHECK_FAILED')
r = recoverPumpFault(2)
check('泵2重试恢复成功', r.ok && pumpStatus(2) === '待核验')
r = verifyPumpFault(2, true, '现场确认正常')
check('泵2核验通过', r.ok && pumpStatus(2) === '已停机')
check('最终故障泵站数为0', faultyPumpCount() === 0, `actual=${faultyPumpCount()}`)
check('溢流事项总数为4（同故障不重复、不同故障各一条）', overflowReviews().length === 4, `actual=${overflowReviews().length}`)

function pumpStatus(id) {
  // 通过模块数据读取：服务没有导出读取函数，用 startPump 的错误无法读状态；
  // 改为从 localStorage 解析。
  const raw = JSON.parse(mem.get('underground-pipeline-inspection:entries'))
  return String(raw.pump_station.find((x) => x.id === id).status)
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
