// bgjobs tests —— 外部引擎契约（引擎只靠声明接入，宿主不认识具体插件）。
//
// 本文件的引擎 id / 字段全是虚构的（ext / svc.pid / result.json），不引用任何真实插件名或
// 其私有产物名：契约需要的只是「声明什么，宿主就按什么处理」。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { apply, setSchtasksRunner } from '../lib/index.js'
import { BgjobEngine } from '../lib/core/engines.js'
import { batEngine } from '../lib/engines/shell/index.js'
import { readJobPid, pidFilesOf, DEFAULT_PID_FILES } from '../lib/kill-tree.js'
import {
  makeCtx, makeWorkdir, makeFakeRunner, installSuiteHooks, setFullAccessEnabled,
} from './helpers/common.js'

installSuiteHooks()

after(() => setSchtasksRunner(null))

/** 虚构的外部引擎：复用 bat 的脚本生成钩子（旧链路），但身份与契约字段全部自持。 */
function extEngine(overrides = {}) {
  return new BgjobEngine({
    id: 'ext',
    label: 'External',
    supportsSandbox: false,
    resolve: batEngine.resolve,
    buildMeta: (_ctx, baseMeta) => {
      const jobDir = path.dirname(baseMeta.jsonPath)
      return { engine: 'ext', cmdPath: path.join(jobDir, 'cmd.bat'), launchVbsPath: path.join(jobDir, 'launch.vbs') }
    },
    writeFiles: batEngine.writeFiles,
    buildTr: batEngine.buildTr,
    ...overrides,
  })
}

const execOf = (workdir) => ({ agent: { session: { id: 's-contract', header: { cwd: workdir } } } })

function boot(workdir, extraServices = {}) {
  const made = makeCtx({
    services: {
      sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workdir }) },
      workspaceRegistry: { list: () => [] },
      ...extraServices,
    },
  })
  const dispose = apply(made.ctx)
  return { ...made, dispose }
}

test('契约字段：声明的 sandboxPolicy / pidFiles / resultFile 原样落进 job.json', async () => {
  const workdir = await makeWorkdir()
  setSchtasksRunner(makeFakeRunner([]))
  const { ctx, intervals, services, dispose } = boot(workdir)
  try {
    services.get('bgjobEngines').registerEngine(extEngine({
      sandboxPolicy: 'off-unrestricted',
      pidFiles: [{ name: 'svc.pid', owned: false }],
      resultFile: 'result.json',
    }))
    const api = services.get('bgjobs')
    const exec = execOf(workdir)
    // off-unrestricted：受限会话（read-only）里也不拒绝、不审批，直接 off。
    const mode = await api.decideJobSandbox({ sandbox: 'read-only' }, exec, 'ext_submit', 'ext')
    assert.equal(mode, 'off')
    const res = await api.submitJob('契约任务', 'echo hi', workdir, 's-contract', 'ext', mode)
    assert.equal(res.ok, true, JSON.stringify(res))
    const jobDir = path.join(workdir, '.dsh', 'bgjobs', res.jobId)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.engine, 'ext')
    assert.deepEqual(meta.pidFiles, [{ name: 'svc.pid', owned: false }])
    assert.equal(meta.resultFile, 'result.json')
    assert.equal(meta.sandbox, 'off')
    // pid 文件按声明读取；owned:false 原样透传（不参与命令行归属核验）
    await fsp.writeFile(path.join(jobDir, 'svc.pid'), String(process.pid), 'utf8')
    const found = await readJobPid(jobDir, pidFilesOf(meta))
    assert.equal(found.pid, process.pid)
    assert.equal(found.file, 'svc.pid')
    assert.equal(found.owned, false)
    // resultFile：收尾时读 channel 落进 meta（面板展示用），与引擎是谁无关
    await fsp.writeFile(path.join(jobDir, 'result.json'), JSON.stringify({ channel: 'warm' }), 'utf8')
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await intervals.find((i) => i.ms === 1000).fn()
    const done = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(done.status, 'done')
    assert.equal(done.channel, 'warm')
  } finally {
    dispose()
    setSchtasksRunner(null)
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('契约字段：off-strict 在受限会话须 full access 开关，否则拒绝提交', async () => {
  const workdir = await makeWorkdir()
  setSchtasksRunner(makeFakeRunner([]))
  let dispose = null
  try {
    await setFullAccessEnabled(false)
    let made = boot(workdir)
    dispose = made.dispose
    made.services.get('bgjobEngines').registerEngine(extEngine({ sandboxPolicy: 'off-strict' }))
    const exec = execOf(workdir)
    await assert.rejects(
      () => made.services.get('bgjobs').decideJobSandbox({}, exec, 'ext_submit', 'ext'),
      /cannot be sandboxed and always runs with full permissions/,
    )
    // full access 在每个 apply 实例里缓存一次 ⇒ 换实例验证「开」的分支
    dispose()
    await setFullAccessEnabled(true)
    made = boot(workdir)
    dispose = made.dispose
    made.services.get('bgjobEngines').registerEngine(extEngine({ sandboxPolicy: 'off-strict' }))
    assert.equal(await made.services.get('bgjobs').decideJobSandbox({}, exec, 'ext_submit', 'ext'), 'off')
  } finally {
    if (dispose) dispose()
    setSchtasksRunner(null)
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('契约字段：未声明 sandboxPolicy = inherit（继承会话模式），未声明 pidFiles = run.pid(owned)', async () => {
  const workdir = await makeWorkdir()
  const { services, dispose } = boot(workdir)
  try {
    services.get('bgjobEngines').registerEngine(extEngine())
    const api = services.get('bgjobs')
    const exec = execOf(workdir)
    // 受限会话缺省继承 read-only（不请求更宽模式 ⇒ 无审批）
    assert.equal(await api.decideJobSandbox({}, exec, 'ext_submit', 'ext'), 'read-only')
    assert.deepEqual(pidFilesOf({}), DEFAULT_PID_FILES)
    assert.deepEqual(pidFilesOf({ pidFiles: [{ name: 'a.pid' }] }), [{ name: 'a.pid', owned: false }])
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('契约字段：未注册引擎 fail loud（not registered），不产生任务目录', async () => {
  const workdir = await makeWorkdir()
  setSchtasksRunner(makeFakeRunner([]))
  const { services, dispose } = boot(workdir)
  try {
    const api = services.get('bgjobs')
    await assert.rejects(
      () => api.decideJobSandbox({}, execOf(workdir), 'nope_submit', 'nope'),
      /engine "nope" not registered/,
    )
    const res = await api.submitJob('t', 'echo hi', workdir, 's', 'nope', 'off')
    assert.equal(res.ok, false)
    assert.match(res.error, /engine "nope" not registered/)
  } finally {
    dispose()
    setSchtasksRunner(null)
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('契约字段：buildMeta 返回同名字段也不能覆盖 pidFiles / resultFile', async () => {
  const workdir = await makeWorkdir()
  setSchtasksRunner(makeFakeRunner([]))
  const { services, dispose } = boot(workdir)
  try {
    services.get('bgjobEngines').registerEngine(extEngine({
      sandboxPolicy: 'off-unrestricted',
      pidFiles: [{ name: 'svc.pid', owned: false }],
      resultFile: 'result.json',
      buildMeta: (_ctx, baseMeta) => {
        const jobDir = path.dirname(baseMeta.jsonPath)
        return {
          engine: 'ext', cmdPath: path.join(jobDir, 'cmd.bat'), launchVbsPath: path.join(jobDir, 'launch.vbs'),
          // 插件试图用 buildMeta 改写契约字段：宿主必须忽略
          pidFiles: [{ name: 'evil.pid', owned: true }],
          resultFile: 'evil.json',
        }
      },
    }))
    const res = await services.get('bgjobs').submitJob('覆盖尝试', 'echo hi', workdir, 's-contract', 'ext', 'off')
    assert.equal(res.ok, true, JSON.stringify(res))
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.deepEqual(meta.pidFiles, [{ name: 'svc.pid', owned: false }], '契约字段宿主所有：buildMeta 不得覆盖')
    assert.equal(meta.resultFile, 'result.json')
  } finally {
    dispose()
    setSchtasksRunner(null)
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('契约字段：越界文件名在注册期 fail loud，且注册后契约字段不可改写', () => {
  assert.throws(() => extEngine({ pidFiles: [{ name: '../../evil.pid' }] }), /plain file name/)
  assert.throws(() => extEngine({ pidFiles: [{ name: 'sub\\svc.pid' }] }), /plain file name/)
  assert.throws(() => extEngine({ pidFiles: [{ name: 'C:evil.pid' }] }), /plain file name/)
  assert.throws(() => extEngine({ resultFile: '../evil.json' }), /plain file name/)
  assert.throws(() => extEngine({ resultFile: 'C:\\evil.json' }), /plain file name/)
  const eng = extEngine({ pidFiles: [{ name: 'svc.pid', owned: false }], resultFile: 'result.json' })
  assert.throws(() => { eng.sandboxPolicy = 'off-unrestricted' }, TypeError)
  assert.throws(() => { eng.pidFiles = [] }, TypeError)
  assert.throws(() => { eng.resultFile = 'x.json' }, TypeError)
})

test('契约字段：pidFiles=[] = 显式无 pid 文件；job meta 里的越界名字读取时被丢弃', async () => {
  const workdir = await makeWorkdir()
  try {
    assert.deepEqual(pidFilesOf({ pidFiles: [] }), [], '空数组不回落到 run.pid')
    assert.deepEqual(
      pidFilesOf({ pidFiles: [{ name: '../../evil.pid' }, { name: 'ok.pid', owned: true }] }),
      [{ name: 'ok.pid', owned: true }],
      '非法名字被丢弃，合法条目保留',
    )
    // 篡改 job.json 后 readJobPid 不得读取任务目录之外的文件
    const jobDir = path.join(workdir, 'job')
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(workdir, 'evil.pid'), String(process.pid), 'utf8')
    assert.equal(await readJobPid(jobDir, [{ name: '../evil.pid', owned: true }]), null)
  } finally {
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('契约字段：off-unrestricted 不查询会话策略服务（服务故障也不影响决策）', async () => {
  const workdir = await makeWorkdir()
  const { services, dispose } = boot(workdir, {
    sandboxPolicy: { resolve: () => { throw new Error('sandbox policy service boom') } },
  })
  try {
    services.get('bgjobEngines').registerEngine(extEngine({ sandboxPolicy: 'off-unrestricted' }))
    const mode = await services.get('bgjobs').decideJobSandbox({ sandbox: 'read-only' }, execOf(workdir), 'ext_submit', 'ext')
    assert.equal(mode, 'off')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})
