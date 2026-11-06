/*
 * Boot check. A classic script (not a module) on purpose: an old phone browser that cannot even parse app.js still runs
 * this file. When neither the login layer nor the main shell is visible a few seconds after load, the reason is written
 * on the screen, so nobody needs a console to see why the page is blank.
 * Plain ES5 only.
 */
(function () {
  'use strict'

  var errors = []
  var panel = null
  var startedAt = Date.now()
  var SHOW_AFTER_MS = 4500
  var GIVE_UP_MS = 90000

  function short(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').slice(0, 240)
  }

  function where(file, line, col) {
    var name = String(file || '').replace(location.origin, '')
    if (!name) return ''
    return ' @ ' + name + (line ? ':' + line + (col ? ':' + col : '') : '')
  }

  function note(text) {
    errors.push(short(text))
    if (errors.length > 12) errors.shift()
    window.__saErrors = errors
  }

  // Capture phase, so a failed <script>/<link> (which does not bubble) is recorded too.
  window.addEventListener('error', function (event) {
    var target = event.target
    if (target && target !== window && (target.src || target.href)) {
      note('资源没加载到：' + String(target.src || target.href).replace(location.origin, ''))
      return
    }
    if (/ResizeObserver/.test(event.message || '')) return
    note('脚本出错：' + (event.message || '未知') + where(event.filename, event.lineno, event.colno))
  }, true)

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    note('没处理的失败：' + (reason && reason.message ? reason.message : reason))
  })

  function visible(id) {
    var element = document.getElementById(id)
    return Boolean(element) && !element.hidden
  }

  function appIsUp() {
    return visible('shell') || visible('login-layer')
  }

  function supportsModules() {
    return typeof HTMLScriptElement !== 'undefined' && 'noModule' in HTMLScriptElement.prototype
  }

  function lines() {
    var out = []
    if (!supportsModules()) {
      out.push('这个浏览器太旧，运行不了后台页面。请换成较新的 Safari 或 Chrome。')
    }
    if (errors.length) {
      out.push('捕获到的报错：')
      for (var index = 0; index < errors.length; index += 1) out.push('· ' + errors[index])
    } else {
      out.push('没有捕获到脚本报错：可能是网络太慢、请求被拦截，或者浏览器没执行脚本。')
    }
    out.push('')
    out.push('地址：' + location.pathname + location.search + location.hash)
    out.push('安全连接：' + (window.isSecureContext ? '是' : '否（普通 HTTP）'))
    out.push('浏览器：' + short(navigator.userAgent))
    return out
  }

  function paint() {
    if (!panel) {
      panel = document.createElement('div')
      panel.setAttribute('role', 'alert')
      panel.setAttribute('data-boot-panel', '')
      panel.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;overflow:auto;'
        + 'background:#fbfcfb;color:#131a17;padding:20px 18px 40px;font:15px/1.65 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
      document.body.appendChild(panel)
    }
    panel.innerHTML = ''
    var title = document.createElement('h1')
    title.style.cssText = 'font-size:20px;margin:0 0 8px;'
    title.textContent = '页面没有正常打开'
    panel.appendChild(title)
    var note1 = document.createElement('p')
    note1.style.cssText = 'margin:0 0 12px;color:#43514c;'
    note1.textContent = '下面这些是浏览器给出的原因。把这一屏截图发给开发者就够了。'
    panel.appendChild(note1)
    var box = document.createElement('pre')
    box.style.cssText = 'white-space:pre-wrap;word-break:break-all;background:#f3f5f4;border:1px solid #d3dbd6;border-radius:6px;padding:12px;margin:0 0 16px;font:13px/1.6 ui-monospace,Consolas,monospace;'
    box.textContent = lines().join('\n')
    panel.appendChild(box)
    var button = document.createElement('button')
    button.type = 'button'
    button.textContent = '重新加载'
    button.style.cssText = 'min-height:44px;padding:0 20px;border:0;border-radius:12px;background:#131a17;color:#fbfcfb;font-size:15px;'
    button.onclick = function () { location.reload() }
    panel.appendChild(button)
  }

  function tick() {
    var elapsed = Date.now() - startedAt
    if (appIsUp()) {
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
      panel = null
      return
    }
    if (elapsed >= SHOW_AFTER_MS) paint()
  }

  var timer = setInterval(function () {
    tick()
    if (Date.now() - startedAt > GIVE_UP_MS && appIsUp()) clearInterval(timer)
  }, 1000)
})()
