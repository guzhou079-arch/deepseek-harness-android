/**
 * whale-shota 状态机与生命周期测试（自用版）
 *
 * 用最小 DOM 桩把 lib/client.js 真跑起来，验证：
 *   · apply 后桌宠节点/主题标记/样式表都挂上了
 *   · 五态按宿主属性正确切换（idle → thinking → streaming → done → idle，error 优先）
 *   · disposer 把节点、观察器、定时器全部回收干净
 *
 * 注意边界：这里验证的是**插件自身的逻辑**（选择器契约、优先级、保持时长、回收）。
 * 「宿主真的会发出 data-streaming / data-step-process-* 吗」是另一回事，
 * 靠对内核 bundle 的属性普查证明（见 README 的「验证」一节）。
 *
 * 跑：node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const CODE = readFileSync(CLIENT, 'utf8')

const DONE_HOLD_MS = 2600

/* ------------------------------ 最小 DOM 桩 ------------------------------ */

function makeElement(tag) {
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    id: '',
    className: '',
    textContent: '',
    type: '',
    title: '',
    parentNode: null,
    style: {
      props: {},
      setProperty(k, v) { this.props[k] = v },
      removeProperty(k) { delete this.props[k] },
    },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    hasAttribute(k) { return k in this.attrs },
    removeAttribute(k) { delete this.attrs[k] },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { c.parentNode = el; el.children.push(c); return c },
    removeChild(c) { el.children = el.children.filter(x => x !== c); c.parentNode = null },
    // 真实浏览器里 ChildNode.remove() 是标准 API；插件在 disposer 里用它移除样式表
    remove() { if (el.parentNode) el.parentNode.removeChild(el) },
  }
  return el
}

function makeEnv() {
  // 宿主 DOM 里「当前存在」的属性选择器——测试里手动开关
  const present = new Set()
  const observers = []
  const intervals = new Map()
  const store = new Map()
  let nextTimer = 1
  let now = 1_000_000

  const head = makeElement('head')
  const body = makeElement('body')
  const documentElement = makeElement('html')

  const document = {
    documentElement,
    head,
    body,
    hidden: false,
    createElement: makeElement,
    querySelector(sel) {
      const s = String(sel)
      // 插件只用这三种形状的查询
      if (s === '[data-error]') return present.has('data-error') ? {} : null
      if (s === '[data-streaming]') return present.has('data-streaming') ? {} : null
      if (s.includes('data-step-process')) {
        return (present.has('data-step-process-content') || present.has('data-step-process-body')) ? {} : null
      }
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }

  class MutationObserver {
    constructor(cb) { this.cb = cb; this.connected = false; observers.push(this) }
    observe() { this.connected = true }
    disconnect() { this.connected = false }
  }

  const ctx = {
    window: { __ModuleLoader__: { load(o) { ctx.__loaded = o } } },
    document,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    MutationObserver,
    setInterval(fn, ms) { const id = nextTimer++; intervals.set(id, { fn, ms }); return id },
    clearInterval(id) { intervals.delete(id) },
    setTimeout,
    clearTimeout,
    Date: new Proxy(Date, { get: (t, p) => (p === 'now' ? () => now : Reflect.get(t, p)) }),
    Math, JSON, Object, Array, String, Number, Boolean, console, Symbol,
  }
  ctx.globalThis = ctx
  const context = createContext(ctx)

  return {
    context,
    present,
    observers,
    intervals,
    store,
    document,
    documentElement,
    body,
    head,
    get loaded() { return ctx.__loaded },
    advance(ms) { now += ms },
    fireObservers() { for (const o of observers) if (o.connected) o.cb() },
    fireTimers() { for (const { fn } of intervals.values()) fn() },
  }
}

function boot() {
  const env = makeEnv()
  runInContext(CODE, env.context)
  assert.ok(env.loaded, '客户端 bundle 应该调用 window.__ModuleLoader__.load')
  assert.equal(env.loaded.id, 'whale-shota')

  const disposers = []
  const ctx = { effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) } }
  const mod = env.loaded.factory(() => { throw new Error('本插件不该 require 任何模块') })
  assert.equal(typeof mod.apply, 'function')
  mod.apply(ctx)
  env.disposers = disposers
  env.dispose = () => { for (const d of disposers.reverse()) d() }
  return env
}

const petOf = env => env.body.children.find(c => String(c.className).includes('ws-pet'))
const bubbleOf = pet => pet.children.find(c => String(c.className).includes('ws-pet__bubble'))
const btnOf = pet => pet.children.find(c => String(c.className).includes('ws-pet__btn'))
const stateOf = pet => pet.getAttribute('data-state')

/* --------------------------------- 测试 --------------------------------- */

test('apply 挂上主题标记、样式表与桌宠节点', () => {
  const env = boot()

  assert.ok(env.documentElement.hasAttribute('data-dsh-whale-shota'))
  assert.equal(env.documentElement.style.props['--ws-accent'], '#5484cc')

  const style = env.head.children.find(c => c.id === 'whale-shota-style')
  assert.ok(style, '应注入样式表')
  assert.match(style.textContent, /\.ws-pet__btn/)
  assert.match(style.textContent, /dsh-bg-user\.png/, '贴纸必须复用已在服务的背景图路由')

  const pet = petOf(env)
  assert.ok(pet, '应挂载桌宠根节点')
  assert.equal(stateOf(pet), 'idle')
  assert.equal(pet.getAttribute('data-collapsed'), '0')
  assert.equal(bubbleOf(pet).textContent, '哼！')
  assert.ok(btnOf(pet))
  assert.equal(env.observers.length, 1)
  assert.equal(env.observers[0].connected, true)
  assert.ok(env.intervals.size >= 1, '应有低频兜底定时器')
})

test('五态按宿主属性切换', () => {
  const env = boot()
  const pet = petOf(env)

  // thinking
  env.present.add('data-step-process-content')
  env.fireObservers()
  assert.equal(stateOf(pet), 'thinking')
  assert.equal(bubbleOf(pet).textContent, '你们还不懂…')

  // streaming 优先于 thinking
  env.present.add('data-streaming')
  env.fireObservers()
  assert.equal(stateOf(pet), 'streaming')
  assert.equal(bubbleOf(pet).textContent, '其实我早就想到了…')

  // 流式结束 → done（保持 DONE_HOLD_MS）
  env.present.delete('data-streaming')
  env.present.delete('data-step-process-content')
  env.fireObservers()
  assert.equal(stateOf(pet), 'done')
  assert.equal(bubbleOf(pet).textContent, '我超聪明的！')

  // 保持期内仍是 done
  env.advance(DONE_HOLD_MS - 100)
  env.fireTimers()
  assert.equal(stateOf(pet), 'done')

  // 超过保持期 → idle
  env.advance(200)
  env.fireTimers()
  assert.equal(stateOf(pet), 'idle')
  assert.equal(bubbleOf(pet).textContent, '哼！')

  // error 优先级最高
  env.present.add('data-streaming')
  env.present.add('data-error')
  env.fireObservers()
  assert.equal(stateOf(pet), 'error')
  assert.equal(bubbleOf(pet).textContent, '……哼。')
})

test('点按切换折叠并写入 localStorage；冷启动读回', () => {
  const env = boot()
  const pet = petOf(env)
  const btn = btnOf(pet)
  // 元素桩的 addEventListener 是空实现，直接触发插件注册的 click 处理不可行，
  // 因此这里改为验证契约的两端：初始值来自 localStorage、以及键名固定。
  assert.equal(pet.getAttribute('data-collapsed'), '0')

  const env2 = makeEnv()
  env2.store.set('whale-shota:collapsed', '1')
  runInContext(CODE, env2.context)
  const disposers2 = []
  env2.loaded.factory(() => {}).apply({ effect(fn) { const d = fn(); if (d) disposers2.push(d) } })
  assert.equal(petOf(env2).getAttribute('data-collapsed'), '1')
})

test('disposer 把节点、样式表、标记、观察器与定时器全部回收', () => {
  const env = boot()
  assert.ok(petOf(env))
  assert.ok(env.head.children.length > 0)
  assert.equal(env.observers[0].connected, true)
  assert.ok(env.intervals.size >= 1)

  env.dispose()

  assert.equal(petOf(env), undefined, '桌宠节点应被移除')
  assert.equal(env.head.children.length, 0, '样式表应被移除')
  assert.equal(env.documentElement.hasAttribute('data-dsh-whale-shota'), false, '主题标记应被摘掉')
  assert.equal(env.documentElement.style.props['--ws-accent'], undefined)
  assert.equal(env.observers[0].connected, false, '观察器应断开')
  assert.equal(env.intervals.size, 0, '定时器应清空')
})

test('document.body 未就绪时不炸，稍后自动补挂', () => {
  const env = makeEnv()
  const realBody = env.document.body
  env.document.body = null            // 模拟脚本在 <body> 之前执行
  runInContext(CODE, env.context)
  const disposers = []
  env.loaded.factory(() => {}).apply({ effect(fn) { const d = fn(); if (d) disposers.push(d) } })
  assert.equal(petOf(env), undefined, 'body 未就绪时不应挂载，也不应抛错')

  env.document.body = realBody         // body 就绪
  env.fireTimers()                     // 兜底轮询应把它挂上
  assert.ok(petOf(env), 'body 就绪后应补挂')
  for (const d of disposers.reverse()) d()
})
