/**
 * dsh-session-delete —— 浏览器半边
 * ============================================================================
 * 手写经典脚本，零构建：宿主 dsh-client-modules 只读 exports["./client"] 的
 * 字节，组合进 combo 由 shell 以 <script> 执行。因此不能用 import/export，
 * 顶层必须同步调用 window.__ModuleLoader__.load。
 *
 * 目标：在侧边栏会话列表上**长按（移动端）/ 右键（桌面）**删除会话。
 * 不改内核前端 bundle —— 会话行的 DOM 上本来就有 data-row-key="session:<id>"，
 * 用 document 级事件委托即可拿到 id，React 重渲染也不会丢监听。
 *
 * 确认框自己画：App 的 WebView 没实现 onJsConfirm，window.confirm() 会静默失效。
 *
 * 2026-10-22 修复两个真 bug（症状：长按弹出确认卡，但点「删除」没反应；
 * 以及偶尔删完之后侧边栏整块白屏）：
 *
 *   ① swallowClick 会吃掉确认卡自己的点击。长按触发的 click 在 Android WebView 里
 *      经常**根本不产生**（长按会抑制 click），于是那个标记要挂到 500ms 后才清，
 *      而用户在这段时间里点的第一下正好是「删除」按钮 → 被 capture 阶段吞掉。
 *      修法：命中确认卡/提示条内部的点击一律不吞。
 *   ② 旧实现删成功后 `row.remove()` 手动把**React 拥有的节点**从 DOM 里摘掉。
 *      引擎随后广播 api-session/removed，React 提交阶段要自己删这一行，
 *      发现节点已经不在了 → removeChild 抛 NotFoundError → 侧边栏白屏。
 *      修法：只改透明度做视觉反馈，节点交给 React 删；1.5s 后若还在就还原，
 *      绝不手动摘节点。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: () => {
    const PLUGIN_ID = 'dsh-session-delete'
    const ROW_SELECTOR = '[data-row-key^="session:"]'
    const PREFIX = 'session:'
    const LONG_PRESS_MS = 520
    const MOVE_SLOP = 12
    const CONFIRM_ATTR = 'data-dsd-confirm'
    /** 删成功后行淡出的时长；超时仍留在 DOM 就还原（等 React 自己摘）。 */
    const ROW_CLEAR_MS = 1500

    const NS = PLUGIN_ID
    /** 找不到词条时回落成 key 本身，所以这里只需保证两条词典键集一致。 */
    const zh = {
      untitled: '（未命名会话）',
      confirmTitle: '删除这个会话？',
      confirmBody: '「{label}」的会话记录会被彻底删除，无法恢复。',
      cancel: '取消',
      delete: '删除',
      cannotDeleteCurrent: '当前打开的会话删不掉：先切到别的会话或新建一个，再长按删除',
      deleted: '已删除会话',
      deleteFailed: '删除失败：{error}',
    }
    const en = {
      untitled: '(Untitled session)',
      confirmTitle: 'Delete this session?',
      confirmBody: 'The session "{label}" will be permanently deleted and cannot be recovered.',
      cancel: 'Cancel',
      delete: 'Delete',
      cannotDeleteCurrent: 'The open session cannot be deleted. Switch to another session or create a new one, then long-press again.',
      deleted: 'Session deleted',
      deleteFailed: 'Delete failed: {error}',
    }
    /** apply() 里换成 ctx.locale.bind(NS)；默认原样返回，保证未接入时不会炸。 */
    let T = (key) => key

    let timer = null
    let pressed = null
    let originX = 0
    let originY = 0
    let swallowClick = false

    /* ---------- 小工具 ---------- */

    const noop = () => {}

    function rowOf(target) {
      if (!target || typeof target.closest !== 'function') return null
      const row = target.closest(ROW_SELECTOR)
      if (!row) return null
      const key = row.getAttribute('data-row-key') || ''
      const id = key.slice(PREFIX.length).trim()
      return id.length >= 8 ? { row: row, id: id } : null
    }

    function rowLabel(row) {
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim()
      if (!text) return T('untitled')
      return text.length > 44 ? text.slice(0, 44) + '…' : text
    }

    function insideOverlay(target) {
      return Boolean(target && typeof target.closest === 'function' && target.closest('[' + CONFIRM_ATTR + ']'))
    }

    function cancelPress() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      pressed = null
    }

    function buzz(ms) {
      try { if (navigator.vibrate) navigator.vibrate(ms) } catch (error) { noop() }
    }

    /* ---------- 确认浮层（替代 window.confirm） ---------- */

    function closeConfirm() {
      const layer = document.querySelector('[' + CONFIRM_ATTR + ']')
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer)
      document.removeEventListener('keydown', onKeydown, true)
      swallowClick = false
    }

    function onKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeConfirm() }
    }

    function confirmDelete(label, onAccept) {
      closeConfirm()

      const layer = document.createElement('div')
      layer.setAttribute(CONFIRM_ATTR, '')
      layer.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483000',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(0,0,0,.42)', 'backdrop-filter:blur(2px)',
        'font:14px/1.55 -apple-system,system-ui,"PingFang SC",sans-serif',
      ].join(';')

      const card = document.createElement('div')
      card.style.cssText = [
        'box-sizing:border-box', 'width:min(86vw,340px)', 'padding:20px 20px 16px',
        'border-radius:14px', 'background:var(--dsw-alias-bg-primary,#1f1f22)',
        'color:var(--dsw-alias-label-primary,#f5f5f5)',
        'border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.12))',
        'box-shadow:0 18px 48px rgba(0,0,0,.45)',
      ].join(';')

      const title = document.createElement('div')
      title.textContent = T('confirmTitle')
      title.style.cssText = 'font-weight:600;font-size:15px;margin-bottom:10px'

      const body = document.createElement('div')
      body.textContent = T('confirmBody', { label: label })
      body.style.cssText = 'color:var(--dsw-alias-label-secondary,#a8a8ad);margin-bottom:18px;word-break:break-word'

      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end'

      const mkButton = (text, primary) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = text
        button.style.cssText = [
          'cursor:pointer', 'border-radius:8px', 'padding:8px 16px', 'font-size:13px',
          'font-family:inherit', 'border:1px solid transparent',
          primary
            ? 'background:#e5484d;color:#fff;border-color:#e5484d;font-weight:600'
            : 'background:transparent;color:var(--dsw-alias-label-secondary,#a8a8ad);'
              + 'border-color:var(--dsw-alias-border-secondary,rgba(255,255,255,.16))',
        ].join(';')
        return button
      }

      const cancelButton = mkButton(T('cancel'), false)
      const deleteButton = mkButton(T('delete'), true)
      cancelButton.addEventListener('click', (event) => { event.stopPropagation(); closeConfirm() })
      deleteButton.addEventListener('click', (event) => {
        event.stopPropagation()
        closeConfirm()
        onAccept()
      })

      actions.appendChild(cancelButton)
      actions.appendChild(deleteButton)
      card.appendChild(title)
      card.appendChild(body)
      card.appendChild(actions)
      layer.appendChild(card)
      layer.addEventListener('click', (event) => { if (event.target === layer) closeConfirm() })
      document.body.appendChild(layer)
      document.addEventListener('keydown', onKeydown, true)
      setTimeout(() => { try { deleteButton.focus() } catch (error) { noop() } }, 30)
    }

    /* ---------- 提示条 ---------- */

    function toast(message) {
      const previous = document.querySelector('[' + CONFIRM_ATTR + ']')
      if (previous && previous.parentNode && previous.textContent !== message) previous.parentNode.removeChild(previous)

      const layer = document.createElement('div')
      layer.setAttribute(CONFIRM_ATTR, '')
      layer.style.cssText = 'position:fixed;left:0;right:0;bottom:24px;z-index:2147483001;display:flex;justify-content:center;pointer-events:none'
      const box = document.createElement('div')
      box.textContent = message
      box.style.cssText = [
        'pointer-events:auto', 'max-width:86vw', 'padding:10px 16px', 'border-radius:10px',
        'background:rgba(40,40,44,.96)', 'color:#fff', 'font:13px/1.5 system-ui,sans-serif',
        'box-shadow:0 10px 30px rgba(0,0,0,.4)', 'word-break:break-word',
      ].join(';')
      layer.appendChild(box)
      layer.addEventListener('click', closeConfirm)
      document.body.appendChild(layer)
      setTimeout(closeConfirm, 2600)
    }

    /* ---------- 删除动作 ---------- */

    /**
     * 视觉上标记「这一行马上没了」。
     * ⚠️ 只改样式，绝不 remove()：节点归 React 所有，手动摘掉会让它下一次
     * commit 的 removeChild 抛 NotFoundError，整块侧边栏直接白屏。
     */
    function markDeleted(row) {
      try {
        row.style.transition = 'opacity 160ms ease'
        row.style.opacity = '0'
      } catch (error) { noop() }
      setTimeout(() => {
        try {
          if (row.isConnected && row.style.opacity === '0') {
            row.style.transition = ''
            row.style.opacity = ''
          }
        } catch (error) { noop() }
      }, ROW_CLEAR_MS)
    }

    function restoreRow(row, opacity) {
      try {
        row.style.transition = ''
        row.style.opacity = opacity
      } catch (error) { noop() }
    }

    function requestDelete(hit) {
      // 当前打开的会话删不得：它还挂着内存实例，删掉目录后下一句话立刻把目录写回来，
      // 表现就像"删了个寂寞"。会话行的 aria-selected 就是「这一行是当前会话」。
      if (hit.row.getAttribute('aria-selected') === 'true') {
        toast(T('cannotDeleteCurrent'))
        return
      }
      const label = rowLabel(hit.row)
      confirmDelete(label, () => {
        const previous = hit.row.style.opacity
        hit.row.style.opacity = '0.45'
        fetch('/dsh-session-admin/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ id: hit.id }),
        })
          .then((response) => response.json().catch(() => ({})).then((body) => ({ response: response, body: body })))
          .then((result) => {
            const body = result.body || {}
            if (!result.response.ok || body.ok === false) {
              throw new Error(body.error || ('HTTP ' + result.response.status))
            }
            markDeleted(hit.row)
            toast(T('deleted'))
          })
          .catch((error) => {
            restoreRow(hit.row, previous)
            toast(T('deleteFailed', { error: (error && error.message) || String(error) }))
          })
      })
    }

    /* ---------- 手势：长按 / 右键 ---------- */

    function pointOf(event) {
      const touch = event.touches && event.touches[0]
      return touch || event
    }

    function onPointerDown(event) {
      if (event.touches && event.touches.length !== 1) { cancelPress(); return }
      if (event.type === 'mousedown' && event.button !== 0) return
      const hit = rowOf(event.target)
      if (!hit) { cancelPress(); return }
      cancelPress()
      const point = pointOf(event)
      pressed = hit
      originX = point.clientX
      originY = point.clientY
      timer = setTimeout(() => {
        timer = null
        const target = pressed
        pressed = null
        swallowClick = true
        if (target) {
          buzz(26)
          requestDelete(target)
        }
      }, LONG_PRESS_MS)
    }

    function onPointerMove(event) {
      if (timer === null) return
      const point = pointOf(event)
      if (Math.abs(point.clientX - originX) > MOVE_SLOP || Math.abs(point.clientY - originY) > MOVE_SLOP) cancelPress()
    }

    function onPointerUp() {
      cancelPress()
      if (swallowClick) setTimeout(() => { swallowClick = false }, 500)
    }

    function onContextMenu(event) {
      const hit = rowOf(event.target)
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      buzz(20)
      requestDelete(hit)
    }

    function onClickCapture(event) {
      // 确认卡 / 提示条自己的点击永远不吞：长按后 WebView 往往不产生 click，
      // 那个标记会一直挂着，正好吃掉用户点的第一下「删除」。
      if (insideOverlay(event.target)) { swallowClick = false; return }
      if (!swallowClick) return
      swallowClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    /* ---------- 挂载 ---------- */

    function apply(ctx) {
      T = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'session-delete: zh')
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'session-delete: en')
      const options = { capture: true, passive: true }
      document.addEventListener('touchstart', onPointerDown, options)
      document.addEventListener('touchmove', onPointerMove, options)
      document.addEventListener('touchend', onPointerUp, options)
      document.addEventListener('touchcancel', onPointerUp, options)
      document.addEventListener('mousedown', onPointerDown, options)
      document.addEventListener('mousemove', onPointerMove, options)
      document.addEventListener('mouseup', onPointerUp, options)
      document.addEventListener('contextmenu', onContextMenu, true)
      document.addEventListener('click', onClickCapture, true)
    }

    return { name: PLUGIN_ID, inject: ['locale'], apply: apply }
  },
})
