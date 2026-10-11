// A Node script that runs inside the sandbox and drives Chromium over the
// Chrome DevTools Protocol, which Chromium only serves on localhost. Uploaded
// by lib/sandbox-tools.ts and run as `node <script> <command> '<json args>'`;
// it prints one JSON result. Needs Node 22+ for the global WebSocket.
// Plain JS in a string: no backticks or ${} inside
export const BROWSER_SCRIPT = String.raw`
import { spawn, execSync } from "node:child_process"
import { openSync } from "node:fs"

const PORT = 9222
const ORIGIN = "http://127.0.0.1:" + PORT
// Remote debugging is refused on the default profile, so the bot gets its own
const PROFILE = "/home/daytona/.config/sangi-browser"
const LOAD_TIMEOUT_MS = 10000

// Roles worth showing the model: things to act on, and headings to orient by
const ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "option", "listbox", "treeitem", "heading",
])
const STATES = ["focused", "checked", "selected", "expanded", "pressed", "disabled"]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Connection {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }
  open() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url)
      this.socket.onopen = () => resolve(this)
      this.socket.onerror = () => reject(new Error("Couldn't connect to the browser."))
      this.socket.onmessage = (event) => {
        const message = JSON.parse(event.data)
        const call = this.pending.get(message.id)
        if (!call) return
        this.pending.delete(message.id)
        if (message.error) call.reject(new Error(message.error.message))
        else call.resolve(message.result)
      }
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.text)
    return result.value
  }
  close() {
    this.socket.close()
  }
}

async function listPages() {
  const response = await fetch(ORIGIN + "/json/list")
  const targets = await response.json()
  return targets.filter((target) => target.type === "page")
}

async function isRunning() {
  try {
    await listPages()
    return true
  } catch {
    return false
  }
}

// The tab on screen is the only visible one; background tabs are hidden
async function activePage() {
  const pages = await listPages()
  if (pages.length === 0) throw new Error("The browser has no open tabs.")
  for (const page of pages) {
    const connection = await new Connection(page.webSocketDebuggerUrl).open()
    const state = await connection.evaluate("document.visibilityState").catch(() => null)
    if (state === "visible") return connection
    connection.close()
  }
  return new Connection(pages[0].webSocketDebuggerUrl).open()
}

async function pageState(page) {
  const { url, title, loading } = await page.evaluate(
    "({ url: location.href, title: document.title, loading: document.readyState !== 'complete' })"
  )
  return { url, title, loading, tabs: (await listPages()).length }
}

async function waitForLoad(page) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  while (Date.now() < deadline) {
    const ready = await page.evaluate("document.readyState").catch(() => null)
    if (ready === "complete") return
    await sleep(250)
  }
}

// Viewport point to screen point, for clicking with the mouse instead
async function screenOffset(page) {
  return page.evaluate(
    "({ x: screenX + (outerWidth - innerWidth) / 2, y: screenY + outerHeight - innerHeight })"
  )
}

async function center(page, backendNodeId) {
  const { model } = await page.send("DOM.getBoxModel", { backendNodeId })
  const quad = model.content
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  }
}

async function nodeObject(page, backendNodeId) {
  const { object } = await page.send("DOM.resolveNode", { backendNodeId })
  return object.objectId
}

const commands = {
  // The page on screen, or null when the browser isn't running
  async status() {
    if (!(await isRunning())) return { browser: null }
    const page = await activePage()
    return { browser: await pageState(page) }
  },

  // Opens a tab, starting the browser first if it isn't running with
  // debugging on (e.g. one the bot started by hand)
  async open({ url }) {
    if (await isRunning()) {
      const response = await fetch(ORIGIN + "/json/new?" + encodeURI(url), { method: "PUT" })
      const target = await response.json()
      await fetch(ORIGIN + "/json/activate/" + target.id)
    } else {
      try {
        execSync("pkill -x chromium")
        await sleep(1000)
      } catch {}
      const log = openSync("/tmp/chromium.log", "a")
      spawn("chromium", [
        "--remote-debugging-port=" + PORT,
        "--user-data-dir=" + PROFILE,
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        url,
      ], { detached: true, stdio: ["ignore", log, log] }).unref()
      const deadline = Date.now() + LOAD_TIMEOUT_MS
      while (!(await isRunning())) {
        if (Date.now() > deadline) throw new Error("The browser didn't start in time.")
        await sleep(250)
      }
    }
    // A new tab takes a moment to become the visible one
    await sleep(500)
    const page = await activePage()
    await waitForLoad(page)
    return { browser: await pageState(page) }
  },

  async elements({ name, role, limit = 40 }) {
    const page = await activePage()
    await page.send("Accessibility.enable")
    const { nodes } = await page.send("Accessibility.getFullAXTree")
    const viewport = await page.evaluate("({ width: innerWidth, height: innerHeight })")
    const offset = await screenOffset(page)
    const wanted = name ? name.toLowerCase() : null

    const onScreen = []
    const offScreen = []
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue
      const nodeRole = node.role ? node.role.value : ""
      const nodeName = node.name ? String(node.name.value).trim() : ""
      if (role ? nodeRole !== role : !ROLES.has(nodeRole)) continue
      if (wanted && !nodeName.toLowerCase().includes(wanted)) continue
      if (!nodeName && nodeRole === "heading") continue

      let point
      try {
        point = await center(page, node.backendDOMNodeId)
      } catch {
        continue // Not rendered
      }
      const states = (node.properties || [])
        .filter((p) => STATES.includes(p.name) && p.value.value && p.value.value !== "false")
        .map((p) => (p.value.value === "mixed" ? p.name + " (mixed)" : p.name))
      const element = {
        id: String(node.backendDOMNodeId),
        role: nodeRole,
        name: nodeName.slice(0, 120),
      }
      if (node.value && node.value.value !== undefined && node.value.value !== "") {
        element.value = String(node.value.value).slice(0, 120)
      }
      if (states.length) element.states = states
      const visible = point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height
      if (visible) {
        element.center = {
          x: Math.round(offset.x + point.x),
          y: Math.round(offset.y + point.y),
        }
        onScreen.push(element)
      } else {
        offScreen.push(element)
      }
    }
    const all = onScreen.concat(offScreen)
    return {
      browser: await pageState(page),
      elements: all.slice(0, limit),
      total: all.length,
    }
  },

  // A real mouse click at the element's center, after scrolling it into view
  async click({ id }) {
    const page = await activePage()
    const backendNodeId = Number(id)
    await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId })
    const { x, y } = await center(page, backendNodeId)
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
    return {}
  },

  // Replaces the field's text the way typing would, so pages notice it
  async fill({ id, text }) {
    const page = await activePage()
    const backendNodeId = Number(id)
    await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId })
    await page.send("DOM.focus", { backendNodeId })
    const objectId = await nodeObject(page, backendNodeId)
    await page.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { if (typeof this.select === 'function') this.select(); else document.execCommand('selectAll') }",
    })
    if (text) {
      await page.send("Input.insertText", { text })
    } else {
      await page.send("Runtime.evaluate", { expression: "document.execCommand('delete')" })
    }
    const { result } = await page.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return 'value' in this ? this.value : this.innerText }",
      returnByValue: true,
    })
    return { value: String(result.value ?? "") }
  },

  async text() {
    const page = await activePage()
    const text = await page.evaluate("document.body ? document.body.innerText : ''")
    return { browser: await pageState(page), text }
  },
}

const [command, rawArgs = "{}"] = process.argv.slice(2)
try {
  if (!commands[command]) throw new Error("Unknown command: " + command)
  const result = await commands[command](JSON.parse(rawArgs))
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }))
  process.exit(1)
}
`
