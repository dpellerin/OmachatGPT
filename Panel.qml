import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
  id: root

  property var shell: null
  property var manifest: null
  property bool opened: false
  property bool connected: false
  property bool thinking: false
  property bool modelChangePending: false
  property bool expectedStop: false
  property bool settingsOpen: false
  property string pendingOpenAction: ""
  property string notice: "Connecting to ChatGPT…"
  property string modelIndicator: ""
  property string selectedModel: ""
  property var availableModels: []
  property string streamingId: ""
  property bool userScrolled: false
  property bool nearBottom: true
  property bool stickToBottomOnLayout: false
  property real savedScrollY: 0
  property bool savedNearBottom: true
  property string noticeBeforeCopy: ""
  property string lastRequest: ""
  property bool lastTurnFailed: false
  property double backendStartedAt: 0
  property int coldStarts: 0
  property int warmReopens: 0
  property int lastBackendReadyMs: -1
  property int lastFirstTokenMs: -1
  property int lastResponseMs: -1

  // OpenRouter settings state
  property bool openRouterConfigured: false
  property string openRouterKey: ""
  property bool showOpenRouterKey: false
  property var openRouterModels: [
    { model: "deepseek/deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", provider: "openrouter" },
    { model: "mistralai/mistral-large-4-0", displayName: "Mistral Large 4", provider: "openrouter" },
    { model: "qwen/qwen3.8-flash", displayName: "Qwen 3.8 Flash", provider: "openrouter" },
    { model: "moonshotai/kimi-k3", displayName: "Kimi K3", provider: "openrouter" },
    { model: "z-ai/glm-5.3-flashx", displayName: "GLM 5.3 FlashX", provider: "openrouter" },
    { model: "google/gemma-4-26b-a4b-it", displayName: "Gemma 4 26B A4B", provider: "openrouter" },
    { model: "deepseek/deepseek-v4-pro-0813", displayName: "DeepSeek V4 Pro", provider: "openrouter" }
  ]
  property var defaultOpenRouterModels: [
    { model: "deepseek/deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", provider: "openrouter" },
    { model: "mistralai/mistral-large-4-0", displayName: "Mistral Large 4", provider: "openrouter" },
    { model: "qwen/qwen3.8-flash", displayName: "Qwen 3.8 Flash", provider: "openrouter" },
    { model: "moonshotai/kimi-k3", displayName: "Kimi K3", provider: "openrouter" },
    { model: "z-ai/glm-5.3-flashx", displayName: "GLM 5.3 FlashX", provider: "openrouter" },
    { model: "google/gemma-4-26b-a4b-it", displayName: "Gemma 4 26B A4B", provider: "openrouter" },
    { model: "deepseek/deepseek-v4-pro-0813", displayName: "DeepSeek V4 Pro", provider: "openrouter" }
  ]
  property string newModelInput: ""
  property string openRouterStatus: "Enter an OpenRouter API key to use open-weight models alongside OpenAI."
  property string settingsError: ""

  // Global shortcut settings state
  property string shortcutBind: "ALT + SPACE"
  property string shortcutLabel: "Option+Space"
  property bool recordingShortcut: false
  property string shortcutStatus: "Click the shortcut button, then press a combination including Option, Ctrl, or Super. Escape cancels."

  readonly property int warmTimeoutMs: 300000

  readonly property string pluginId: (manifest && manifest.id) || "dpellerin.omachatgpt"
  readonly property string sourceDir: (manifest && manifest.__sourceDir) || ""
  readonly property string bridgePath: sourceDir !== ""
    ? sourceDir + "/dist/bridge.js"
    : Qt.resolvedUrl("dist/bridge.js").toString().replace(/^file:\/\//, "")
  readonly property color foreground: Color.popups.text
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color codeBackground: "#17191d"
  readonly property color codeForeground: "#d8dde5"
  readonly property color codeMuted: "#89919c"
  readonly property color codeBorder: "#292d34"
  readonly property var borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
  readonly property string barPosition: shell && shell.barConfig ? String(shell.barConfig.position || "top") : "top"
  readonly property bool barVertical: barPosition === "left" || barPosition === "right"
  readonly property int defaultBarSize: barVertical ? Style.bar.sizeVertical : Style.bar.sizeHorizontal
  readonly property int liveBarSize: shell && shell.bar
    ? (shell.bar.barHidden ? 0 : Math.max(0, shell.bar.barSize))
    : defaultBarSize
  readonly property int topClearance: (barPosition === "top" ? liveBarSize : 0) + Style.gapsOut
  readonly property int rightClearance: (barPosition === "right" ? liveBarSize : 0) + Style.gapsOut

  readonly property var openAiModelsList: {
    var out = []
    for (var i = 0; i < root.availableModels.length; i++) {
      var item = root.availableModels[i]
      if (item && item.provider !== "openrouter" && String(item.model || "").indexOf("/") === -1) {
        out.push(item)
      }
    }
    return out
  }

  readonly property var openRouterModelsList: {
    var out = []
    for (var i = 0; i < root.availableModels.length; i++) {
      var item = root.availableModels[i]
      if (item && (item.provider === "openrouter" || String(item.model || "").indexOf("/") !== -1)) {
        out.push(item)
      }
    }
    return out
  }

  ListModel { id: conversation }

  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(String(payloadJson || "{}")) } catch (e) { payload = ({}) }
    root.opened = true
    warmShutdownTimer.stop()
    if (backend.running) root.warmReopens++
    root.startBackend()

    var action = String((payload && payload.action) || "")
    if (action === "settings") {
      root.openSettings()
    } else if (action === "chat") {
      root.settingsOpen = false
      modelPopup.close()
    } else if (action === "newChat") {
      root.settingsOpen = false
      modelPopup.close()
      if (root.connected && !root.thinking && !root.modelChangePending) {
        root.newChat()
      } else {
        root.pendingOpenAction = "newChat"
      }
    }

    Qt.callLater(function() {
      if (!root.opened) return
      if (conversationView) conversationView.restoreScrollAfterOpen()
      if (root.settingsOpen) keyField.forceActiveFocus()
      else prompt.forceActiveFocus()
    })
  }

  function close() {
    if (conversationView && conversationView.height > Style.space(200)) {
      root.savedScrollY = conversationView.contentY
      root.savedNearBottom = root.nearBottom
    }
    root.opened = false
    root.recordingShortcut = false
    modelPopup.close()
    if (root.thinking) root.interrupt()
    if (backend.running) warmShutdownTimer.restart()
  }

  function dismiss() {
    if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
    else root.close()
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function openSettings() {
    modelPopup.close()
    root.settingsOpen = true
    root.settingsError = ""
    root.updateOpenRouterStatus(false)
    Qt.callLater(function() {
      if (root.opened && root.settingsOpen) keyField.forceActiveFocus()
    })
  }

  function closeSettings() {
    root.settingsOpen = false
    root.recordingShortcut = false
    root.settingsError = ""
    Qt.callLater(function() {
      if (root.opened && !root.settingsOpen) prompt.forceActiveFocus()
    })
  }

  function toggleSettings() {
    if (root.settingsOpen) root.closeSettings()
    else root.openSettings()
  }

  function startBackend() {
    if (backend.running || root.bridgePath === "") return
    warmShutdownTimer.stop()
    root.expectedStop = false
    root.connected = false
    root.thinking = false
    root.modelChangePending = false
    root.lastTurnFailed = false
    root.notice = "Connecting to ChatGPT…"
    root.modelIndicator = ""
    root.selectedModel = ""
    root.availableModels = []
    root.backendStartedAt = Date.now()
    root.coldStarts++
    backend.command = ["node", root.bridgePath]
    backend.running = true
  }

  function stopBackend() {
    warmShutdownTimer.stop()
    if (!backend.running) return
    root.expectedStop = true
    root.connected = false
    root.thinking = false
    backend.running = false
  }

  function reconnectBackend() {
    root.stopBackend()
    Qt.callLater(function() { root.startBackend() })
  }

  function metrics(payloadJson) {
    return JSON.stringify({
      coldStarts: root.coldStarts,
      warmReopens: root.warmReopens,
      backendReadyMs: root.lastBackendReadyMs,
      firstTokenMs: root.lastFirstTokenMs,
      responseMs: root.lastResponseMs,
      backendWarm: backend.running,
      warmTimeoutMs: root.warmTimeoutMs
    })
  }

  function sendCommand(command) {
    if (backend.running) backend.write(JSON.stringify(command) + "\n")
  }

  function displayModelName(model) {
    var slug = String(model || "")
    if (slug === "") return ""
    for (var i = 0; i < root.availableModels.length; i++) {
      var candidate = root.availableModels[i]
      if (candidate && candidate.model === slug && candidate.displayName) {
        return String(candidate.displayName)
      }
    }
    for (var j = 0; j < root.openRouterModels.length; j++) {
      var orCandidate = root.openRouterModels[j]
      if (orCandidate && orCandidate.model === slug && orCandidate.displayName) {
        return String(orCandidate.displayName)
      }
    }
    var rawName = slug.indexOf("/") !== -1 ? slug.split("/").slice(1).join("/") : slug
    var parts = rawName.split(/[-_]+/)
    if (parts.length === 0 || parts[0] === "") return slug
    var label = parts[0].toLowerCase() === "gpt" && parts.length > 1
      ? "GPT-" + parts[1]
      : (parts[0].charAt(0).toUpperCase() + parts[0].slice(1))
    var start = parts[0].toLowerCase() === "gpt" ? 2 : 1
    for (var k = start; k < parts.length; k++) {
      var word = parts[k]
      if (/^v?\d+(\.\d+)*[a-z]*$/i.test(word) || /^(vl|it|moe|glm|llm|ai)$/i.test(word)) {
        label += " " + word.toUpperCase()
      } else {
        label += " " + word.charAt(0).toUpperCase() + word.slice(1)
      }
    }
    return label
  }

  function updateModelSelection(model) {
    root.selectedModel = String(model || "")
    root.modelIndicator = root.displayModelName(model)
  }

  function updateOpenRouterStatus(saved) {
    var trimmed = String(root.openRouterKey || "").trim()
    root.openRouterConfigured = trimmed !== ""
    var count = root.openRouterModels ? root.openRouterModels.length : 0
    if (trimmed === "") {
      root.openRouterStatus = saved
        ? "Saved · Add an API key to enable OpenRouter models in the header picker."
        : "Enter an OpenRouter API key to use open-weight models alongside OpenAI."
    } else {
      root.openRouterStatus = (saved ? "Saved · " : "")
        + count + " OpenRouter model" + (count === 1 ? "" : "s") + " enabled in the header picker."
    }
  }

  function applyOpenRouterPayload(event, saved) {
    if (event.defaultOpenRouterModels && Array.isArray(event.defaultOpenRouterModels) && event.defaultOpenRouterModels.length > 0) {
      root.defaultOpenRouterModels = event.defaultOpenRouterModels
    }
    if (event.openRouterModels && Array.isArray(event.openRouterModels) && event.openRouterModels.length > 0) {
      root.openRouterModels = event.openRouterModels
    }
    if (typeof event.openRouterKey === "string") {
      root.openRouterKey = event.openRouterKey
      if (keyField && keyField.text !== event.openRouterKey) {
        keyField.text = event.openRouterKey
      }
    }
    if (typeof event.openRouterConfigured === "boolean") {
      root.openRouterConfigured = event.openRouterConfigured
    }
    if (typeof event.shortcutBind === "string" && event.shortcutBind !== "") {
      root.shortcutBind = event.shortcutBind
    }
    if (typeof event.shortcutLabel === "string" && event.shortcutLabel !== "") {
      root.shortcutLabel = event.shortcutLabel
      root.syncBarWidgetShortcut(event.shortcutLabel, event.shortcutBind || root.shortcutBind)
    }
    root.updateOpenRouterStatus(saved === true)
  }

  function syncBarWidgetShortcut(label, bind) {
    if (!root.shell || typeof root.shell.updateEntryInline !== "function") return
    root.shell.updateEntryInline(root.pluginId, {
      id: root.pluginId,
      shortcutLabel: String(label || "Option+Space"),
      shortcutBind: String(bind || "ALT + SPACE")
    })
  }

  function beginShortcutRecording() {
    root.settingsError = ""
    root.recordingShortcut = true
    root.shortcutStatus = "Press a combination including Option, Ctrl, or Super (Escape cancels)…"
    Qt.callLater(function() {
      if (shortcutRecorderButton) shortcutRecorderButton.forceActiveFocus()
    })
  }

  function cancelShortcutRecording() {
    root.recordingShortcut = false
    root.shortcutStatus = "Click the shortcut button, then press a combination including Option, Ctrl, or Super. Escape cancels."
  }

  function keyEventToShortcutSpec(event) {
    var key = event.key
    if (key === Qt.Key_Shift || key === Qt.Key_Control || key === Qt.Key_Alt || key === Qt.Key_Meta || key === Qt.Key_Super_L || key === Qt.Key_Super_R) {
      return null
    }
    var mods = []
    if (event.modifiers & Qt.MetaModifier) mods.push("Super")
    if (event.modifiers & Qt.ControlModifier) mods.push("Ctrl")
    if (event.modifiers & Qt.AltModifier) mods.push("Option")
    if (event.modifiers & Qt.ShiftModifier) mods.push("Shift")
    if (mods.length === 0) {
      return { error: "Include Option, Ctrl, or Super in the shortcut." }
    }
    var keyName = ""
    if (key === Qt.Key_Space) keyName = "Space"
    else if (key === Qt.Key_Return || key === Qt.Key_Enter) keyName = "Return"
    else if (key === Qt.Key_Tab || key === Qt.Key_Backtab) keyName = "Tab"
    else if (key === Qt.Key_Backspace) keyName = "Backspace"
    else if (key === Qt.Key_Delete) keyName = "Delete"
    else if (key === Qt.Key_Home) keyName = "Home"
    else if (key === Qt.Key_End) keyName = "End"
    else if (key === Qt.Key_PageUp) keyName = "PageUp"
    else if (key === Qt.Key_PageDown) keyName = "PageDown"
    else if (key === Qt.Key_Up) keyName = "Up"
    else if (key === Qt.Key_Down) keyName = "Down"
    else if (key === Qt.Key_Left) keyName = "Left"
    else if (key === Qt.Key_Right) keyName = "Right"
    else if (key === Qt.Key_Comma) keyName = "comma"
    else if (key === Qt.Key_Period) keyName = "period"
    else if (key === Qt.Key_Slash) keyName = "slash"
    else if (key === Qt.Key_Semicolon) keyName = "semicolon"
    else if (key === Qt.Key_Apostrophe) keyName = "apostrophe"
    else if (key === Qt.Key_BracketLeft) keyName = "bracketleft"
    else if (key === Qt.Key_BracketRight) keyName = "bracketright"
    else if (key === Qt.Key_Backslash) keyName = "backslash"
    else if (key === Qt.Key_Minus) keyName = "minus"
    else if (key === Qt.Key_Equal) keyName = "equal"
    else if (key === Qt.Key_QuoteLeft) keyName = "grave"
    else if (key >= Qt.Key_F1 && key <= Qt.Key_F12) keyName = "F" + (key - Qt.Key_F1 + 1)
    else if (key >= Qt.Key_A && key <= Qt.Key_Z) keyName = String.fromCharCode(65 + (key - Qt.Key_A))
    else if (key >= Qt.Key_0 && key <= Qt.Key_9) keyName = String.fromCharCode(48 + (key - Qt.Key_0))
    if (keyName === "") {
      return { error: "Unsupported shortcut key. Try a letter, number, Space, or function key." }
    }
    return { spec: mods.join("+") + "+" + keyName }
  }

  function applyShortcutSpec(spec) {
    var raw = String(spec || "").trim()
    if (raw === "") return
    root.recordingShortcut = false
    root.settingsError = ""
    root.shortcutStatus = "Saving shortcut…"
    if (backend.running) {
      root.sendCommand({ type: "saveShortcut", shortcut: raw })
    } else {
      root.startBackend()
    }
  }

  function saveOpenRouter() {
    var trimmedKey = String(keyField ? keyField.text : root.openRouterKey).trim()
    root.openRouterKey = trimmedKey
    if (keyField && keyField.text !== trimmedKey) keyField.text = trimmedKey
    if (!root.openRouterModels || root.openRouterModels.length === 0) {
      root.openRouterModels = root.defaultOpenRouterModels.slice()
    }
    root.settingsError = ""
    root.updateOpenRouterStatus(true)
    var modelsPayload = []
    for (var i = 0; i < root.openRouterModels.length; i++) {
      var item = root.openRouterModels[i]
      if (item && item.model) {
        modelsPayload.push({ model: String(item.model), displayName: String(item.displayName || item.model) })
      }
    }
    if (backend.running) {
      root.sendCommand({
        type: "saveOpenRouterConfig",
        key: trimmedKey,
        models: modelsPayload
      })
    } else {
      root.startBackend()
    }
  }

  function pasteOpenRouterKey() {
    var raw = String(Quickshell.clipboardText || "").trim()
    if (raw === "") {
      root.settingsError = "Clipboard does not contain text to paste."
      return
    }
    root.openRouterKey = raw
    if (keyField) keyField.text = raw
    root.saveOpenRouter()
  }

  function parseModelEntry(raw) {
    var trimmed = String(raw || "").trim()
    if (trimmed === "") return null
    var parts = trimmed.split("|")
    var slug = String(parts[0] || "").trim()
    if (slug === "") return null
    var customName = parts.length > 1 ? String(parts.slice(1).join("|")).trim() : ""
    if (customName !== "") {
      return { model: slug, displayName: customName, provider: "openrouter" }
    }
    for (var i = 0; i < root.defaultOpenRouterModels.length; i++) {
      var preset = root.defaultOpenRouterModels[i]
      if (preset && String(preset.model).toLowerCase() === slug.toLowerCase()) {
        return { model: preset.model, displayName: preset.displayName, provider: "openrouter" }
      }
    }
    return { model: slug, displayName: root.displayModelName(slug), provider: "openrouter" }
  }

  function addOpenRouterModel() {
    var text = addModelField ? addModelField.text : root.newModelInput
    var entry = root.parseModelEntry(text)
    if (!entry) return
    var next = []
    var replaced = false
    for (var i = 0; i < root.openRouterModels.length; i++) {
      var current = root.openRouterModels[i]
      if (current && current.model === entry.model) {
        next.push(entry)
        replaced = true
      } else if (current) {
        next.push(current)
      }
    }
    if (!replaced) next.push(entry)
    root.openRouterModels = next
    root.newModelInput = ""
    if (addModelField) addModelField.text = ""
    root.saveOpenRouter()
  }

  function removeOpenRouterModel(modelSlug) {
    if (root.openRouterModels.length <= 1) return
    var next = []
    for (var i = 0; i < root.openRouterModels.length; i++) {
      var current = root.openRouterModels[i]
      if (current && current.model !== modelSlug) next.push(current)
    }
    if (next.length === 0) next = root.defaultOpenRouterModels.slice()
    root.openRouterModels = next
    root.saveOpenRouter()
  }

  function resetOpenRouterModels() {
    root.openRouterModels = root.defaultOpenRouterModels.slice()
    root.saveOpenRouter()
  }

  function chooseModel(modelSlug) {
    modelPopup.close()
    if (!root.connected || root.thinking || root.modelChangePending) return
    if (modelSlug === root.selectedModel) return
    root.modelChangePending = true
    root.notice = "Changing model…"
    root.sendCommand({ type: "selectModel", model: modelSlug })
  }

  function copyToClipboard(value, label) {
    var text = String(value || "")
    if (text === "") return
    Quickshell.clipboardText = text
    root.noticeBeforeCopy = root.notice
    root.notice = String(label || "Text") + " copied"
    copyNoticeTimer.restart()
  }

  function sendMessage() {
    var text = prompt.text.trim()
    if (!text || !root.connected || root.thinking || root.modelChangePending) return
    prompt.text = ""
    root.lastRequest = text
    root.lastTurnFailed = false
    root.userScrolled = false
    root.nearBottom = true
    conversation.append({ messageId: "user-" + Date.now(), messageRole: "user", body: text, messageFinal: true })
    root.streamingId = ""
    root.thinking = true
    root.notice = "Thinking…"
    root.sendCommand({ type: "send", text: text })
    root.scrollToEnd()
  }

  function retryLastMessage() {
    if (!root.connected || root.thinking || root.modelChangePending || root.lastRequest === "") return
    prompt.text = root.lastRequest
    root.sendMessage()
  }

  function newChat() {
    if (!root.connected || root.thinking || root.modelChangePending) return
    root.settingsOpen = false
    root.connected = false
    root.lastTurnFailed = false
    root.notice = "Starting a new chat…"
    root.sendCommand({ type: "newChat" })
  }

  function interrupt() {
    if (!root.thinking) return
    root.notice = "Stopping…"
    root.sendCommand({ type: "interrupt" })
  }

  function scrollToEnd() {
    root.userScrolled = false
    root.nearBottom = true
    root.savedNearBottom = true
    root.stickToBottomOnLayout = true
    Qt.callLater(function() {
      if (conversationView) conversationView.scrollToBottom()
    })
  }

  function scrollToLatestMessageTop() {
    if (root.userScrolled) return
    root.stickToBottomOnLayout = false
    Qt.callLater(function() {
      if (!root.userScrolled && conversationView) {
        conversationView.scrollToLatestTop()
      }
    })
  }

  function replaceMessages(messages) {
    conversation.clear()
    root.userScrolled = false
    root.nearBottom = true
    root.savedNearBottom = true
    root.stickToBottomOnLayout = true
    for (var i = 0; i < messages.length; i++) {
      var message = messages[i] || {}
      conversation.append({
        messageId: String(message.id || ("message-" + i)),
        messageRole: String(message.role || "assistant"),
        body: String(message.text || ""),
        messageFinal: true
      })
    }
    root.scrollToEnd()
  }

  function appendDelta(itemId, delta) {
    var id = String(itemId || root.streamingId || ("assistant-" + Date.now()))
    root.streamingId = id
    for (var i = 0; i < conversation.count; i++) {
      if (conversation.get(i).messageId === id) {
        conversation.setProperty(i, "body", conversation.get(i).body + String(delta || ""))
        root.scrollToLatestMessageTop()
        return
      }
    }
    root.userScrolled = false
    conversation.append({ messageId: id, messageRole: "assistant", body: String(delta || ""), messageFinal: false })
    root.scrollToLatestMessageTop()
  }

  function replaceMessage(itemId, text) {
    var id = String(itemId || root.streamingId || ("assistant-" + Date.now()))
    root.streamingId = id
    for (var i = 0; i < conversation.count; i++) {
      if (conversation.get(i).messageId === id) {
        conversation.setProperty(i, "body", String(text || ""))
        conversation.setProperty(i, "messageFinal", true)
        root.scrollToLatestMessageTop()
        return
      }
    }
    root.userScrolled = false
    conversation.append({ messageId: id, messageRole: "assistant", body: String(text || ""), messageFinal: true })
    root.scrollToLatestMessageTop()
  }

  function messageParts(markdown) {
    var source = String(markdown || "")
    var parts = []
    var fence = /```([^\n`]*)\n([\s\S]*?)```/g
    var cursor = 0
    var match

    while ((match = fence.exec(source)) !== null) {
      var prose = source.slice(cursor, match.index)
      if (prose) root.appendMarkdownParts(parts, prose)
      parts.push({
        kind: "code",
        content: String(match[2] || "").replace(/\n$/, ""),
        language: String(match[1] || "").trim()
      })
      cursor = fence.lastIndex
    }

    var remainder = source.slice(cursor)
    var unfinished = remainder.match(/^([\s\S]*?)```([^\n`]*)\n([\s\S]*)$/)
    if (unfinished) {
      if (unfinished[1]) root.appendMarkdownParts(parts, unfinished[1])
      parts.push({
        kind: "code",
        content: String(unfinished[3] || ""),
        language: String(unfinished[2] || "").trim()
      })
    } else if (remainder) root.appendMarkdownParts(parts, remainder)
    if (parts.length === 0) parts.push({ kind: "markdown", content: "", language: "" })
    return parts
  }

  function appendMarkdownBlock(parts, kind, lines) {
    var content = lines.join("\n").replace(/^\n+|\n+$/g, "")
    if (content !== "") parts.push({ kind: kind, content: content, language: "" })
    lines.length = 0
  }

  function appendMarkdownParts(parts, markdown) {
    var lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n")
    var proseLines = []
    var listLines = []
    var inList = false

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var listItem = /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line)
      var continuation = /^\s{2,}\S/.test(line)
      var blank = line.trim() === ""

      if (!inList && listItem) {
        root.appendMarkdownBlock(parts, "markdown", proseLines)
        inList = true
      } else if (inList && !listItem && !continuation && !blank) {
        root.appendMarkdownBlock(parts, "list", listLines)
        inList = false
      }

      if (inList) listLines.push(line)
      else proseLines.push(line)
    }

    if (inList) root.appendMarkdownBlock(parts, "list", listLines)
    else root.appendMarkdownBlock(parts, "markdown", proseLines)
  }

  function displayMarkdown(markdown, finalized) {
    var source = String(markdown || "")
    if (finalized) return source
    return source
      .replace(/\uE200cite(?:\uE202[^\uE201]*)?\uE201/g, "")
      .replace(/\uE200cite[^\uE201]*$/g, "")
      .replace(/!?\[([^\]\n]+)\]\((?:https?:\/\/)?[^)\n]*$/g, "$1")
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
  }

  function richMarkdown(markdown, finalized) {
    var source = root.displayMarkdown(markdown, finalized)
    var links = []
    var code = []

    source = source.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, function(_, label, url) {
      var token = "\uE100LINK" + links.length + "\uE101"
      links.push({ label: label, url: url })
      return token
    })
    source = source.replace(/`([^`\n]+)`/g, function(_, value) {
      var token = "\uE100CODE" + code.length + "\uE101"
      code.push(value)
      return token
    })

    var lines = root.escapeHtml(source).split("\n")
    for (var i = 0; i < lines.length; i++) {
      lines[i] = lines[i]
        .replace(/^#{1,6}\s+(.+)$/, "<b>$1</b>")
        .replace(/^\s*[-+*]\s+/, "•  ")
        .replace(/^\s*(\d+)[.)]\s+/, "$1.  ")
        .replace(/^\s*&gt;\s?/, "│  ")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/__([^_\n]+)__/g, "<b>$1</b>")
        .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
    }
    var html = lines.join("<br>")

    for (var codeIndex = 0; codeIndex < code.length; codeIndex++) {
      html = html.replace(
        "\uE100CODE" + codeIndex + "\uE101",
        "<tt>" + root.escapeHtml(code[codeIndex]) + "</tt>"
      )
    }
    var accentHex = String(root.accent)
    for (var linkIndex = 0; linkIndex < links.length; linkIndex++) {
      var link = links[linkIndex]
      html = html.replace(
        "\uE100LINK" + linkIndex + "\uE101",
        "<a href=\"" + root.escapeHtml(link.url) + "\" style=\"color: " + accentHex
          + "; text-decoration: underline;\"><span style=\"color: " + accentHex + ";\">"
          + root.escapeHtml(link.label) + "</span></a>"
      )
    }
    return html
  }

  function handleBackendLine(line) {
    var event
    try { event = JSON.parse(String(line || "")) } catch (e) { return }
    if (event.type === "ready") {
      root.lastBackendReadyMs = root.backendStartedAt > 0
        ? Math.max(0, Math.round(Date.now() - root.backendStartedAt))
        : -1
      root.applyOpenRouterPayload(event, false)
      root.replaceMessages(event.messages || [])
      root.connected = true
      root.thinking = false
      root.modelChangePending = false
      root.lastTurnFailed = false
      root.notice = event.notice || "Ready"
      root.availableModels = event.models || []
      root.updateModelSelection(event.model)
      if (root.pendingOpenAction === "newChat") {
        root.pendingOpenAction = ""
        root.newChat()
        return
      }
      Qt.callLater(function() {
        if (!root.opened) return
        if (root.settingsOpen) keyField.forceActiveFocus()
        else prompt.forceActiveFocus()
      })
    } else if (event.type === "modelsUpdated") {
      root.applyOpenRouterPayload(event, true)
      root.availableModels = event.models || []
      if (event.model) root.updateModelSelection(event.model)
      if (!root.connected && root.availableModels.length > 0) {
        root.connected = true
        root.notice = "Ready"
      }
    } else if (event.type === "shortcutUpdated") {
      root.recordingShortcut = false
      if (event.shortcutBind) root.shortcutBind = String(event.shortcutBind)
      if (event.shortcutLabel) root.shortcutLabel = String(event.shortcutLabel)
      root.syncBarWidgetShortcut(root.shortcutLabel, root.shortcutBind)
      root.shortcutStatus = "Saved · Global shortcut is now " + root.shortcutLabel + " (active in Hyprland)."
    } else if (event.type === "modelSelected") {
      root.modelChangePending = false
      root.updateModelSelection(event.model)
      root.notice = "Ready"
      Qt.callLater(function() { if (root.opened && !root.settingsOpen) prompt.forceActiveFocus() })
    } else if (event.type === "activeModel") {
      var activeName = root.displayModelName(event.model)
      root.modelIndicator = event.model && event.model !== root.selectedModel
        ? activeName + " · routed"
        : activeName
    } else if (event.type === "delta") {
      root.appendDelta(event.itemId, event.delta)
    } else if (event.type === "message") {
      root.replaceMessage(event.itemId, event.text)
    } else if (event.type === "searching") {
      root.notice = "Searching the web…"
    } else if (event.type === "done") {
      root.streamingId = ""
      root.thinking = false
      root.connected = true
      if (!root.lastTurnFailed) root.notice = "Ready"
      Qt.callLater(function() { if (root.opened && !root.settingsOpen) prompt.forceActiveFocus() })
    } else if (event.type === "metric") {
      if (event.name === "first-token") root.lastFirstTokenMs = Number(event.durationMs)
      else if (event.name === "response") root.lastResponseMs = Number(event.durationMs)
    } else if (event.type === "error" || event.type === "fatal") {
      root.applyOpenRouterPayload(event, false)
      root.modelChangePending = false
      if (root.selectedModel) root.updateModelSelection(root.selectedModel)
      root.streamingId = ""
      root.thinking = Boolean(event.busy)
      root.lastTurnFailed = true
      root.notice = String(event.message || "Something went wrong.")
      if (event.type === "fatal") root.connected = false
    }
  }

  Process {
    id: backend
    stdinEnabled: true
    stdout: SplitParser { onRead: function(line) { root.handleBackendLine(line) } }
    stderr: SplitParser {
      onRead: function(line) {
        if (String(line || "").trim() !== "") root.notice = String(line).trim()
      }
    }
    onExited: function(exitCode) {
      if (!root.expectedStop) {
        root.connected = false
        root.thinking = false
        if (root.opened && (root.notice === "Connecting to ChatGPT…" || root.notice === "Ready"))
          root.notice = "ChatGPT stopped unexpectedly (exit " + exitCode + ")"
      }
      root.expectedStop = false
    }
  }

  Timer {
    id: warmShutdownTimer
    interval: root.warmTimeoutMs
    repeat: false
    onTriggered: if (!root.opened) root.stopBackend()
  }

  Timer {
    id: copyNoticeTimer
    interval: 1400
    repeat: false
    onTriggered: {
      if (/ copied$/.test(root.notice)) root.notice = root.noticeBeforeCopy || "Ready"
    }
  }

  Component.onDestruction: root.stopBackend()

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omachatgpt"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.opened ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

    Rectangle {
      anchors.fill: parent
      color: Qt.rgba(0, 0, 0, 0.38)
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: Math.min(Style.space(560), Math.max(Style.space(420), panel.width) - root.rightClearance - Style.gapsOut)
      height: Math.min(Style.space(820), Math.max(Style.space(560), panel.height) - root.topClearance - Style.gapsOut)
      anchors.top: parent.top
      anchors.topMargin: root.topClearance
      anchors.right: parent.right
      anchors.rightMargin: root.rightClearance
      color: Color.popups.background
      borderSpec: root.borderSpec
      radius: Style.cornerRadius
      padding: Style.spacing.panelPadding

      MouseArea {
        anchors.fill: parent
        onClicked: if (modelPopup.opened) modelPopup.close()
      }

      Column {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: Style.space(10)

        // ---------- Header ----------
        Item {
          width: parent.width
          height: Style.space(32)

          Row {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: "\uDB80\uDF69"
              color: root.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.title
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: root.settingsOpen ? "OmachatGPT Settings" : "OmachatGPT"
              color: root.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.title
              font.bold: true
            }
          }

          Row {
            id: headerControls
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            // Unified Model Picker Trigger (OpenAI + OpenRouter)
            BorderSurface {
              id: modelPickerButton
              visible: !root.settingsOpen
              width: Math.min(
                Style.space(260),
                Math.max(Style.space(140), modelPickerLabel.implicitWidth + Style.space(34))
              )
              height: Style.space(28)
              radius: Style.cornerRadius
              enabled: !root.thinking && !root.modelChangePending
              opacity: enabled ? 1.0 : 0.55

              readonly property bool _hot: modelPickerMouse.containsMouse || modelPopup.opened
              readonly property var _spec: Border.controlSpec(modelPopup.opened ? "focus" : (_hot ? "hover-cursor" : "normal"), root.foreground, root.accent)

              color: Style.controlFill(modelPopup.opened, _hot, root.foreground, root.accent)
              borderSpec: _spec

              Text {
                id: modelPickerLabel
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.leftMargin: Style.space(10)
                anchors.right: modelChevron.left
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
                text: root.modelIndicator || "Select Model"
                color: root.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
                elide: Text.ElideRight
              }

              Text {
                id: modelChevron
                textFormat: Text.PlainText
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                text: "󰅀"
                color: root.dim
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              MouseArea {
                id: modelPickerMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: parent.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: {
                  if (!parent.enabled) return
                  if (modelPopup.opened) modelPopup.close()
                  else modelPopup.open()
                }
              }

              PanelToolTip {
                visible: modelPickerMouse.containsMouse && !modelPopup.opened
                text: "Select OpenAI or OpenRouter model"
                fontFamily: Style.font.family
              }

              Popup {
                id: modelPopup
                x: modelPickerButton.width - width
                y: modelPickerButton.height + Style.space(4)
                width: Style.space(260)
                padding: Style.space(6)
                modal: false
                focus: true
                closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

                background: BorderSurface {
                  color: Color.popups.background
                  borderSpec: root.borderSpec
                  radius: Style.cornerRadius
                }

                contentItem: Flickable {
                  implicitHeight: Math.min(Style.space(420), modelMenuColumn.implicitHeight)
                  contentWidth: width
                  contentHeight: modelMenuColumn.implicitHeight
                  clip: true
                  boundsBehavior: Flickable.StopAtBounds
                  interactive: contentHeight > height
                  ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                  Column {
                    id: modelMenuColumn
                    width: parent.width
                    spacing: Style.space(2)

                    // OpenAI Section
                    PanelSectionHeader {
                      visible: root.openAiModelsList.length > 0
                      text: "OPENAI"
                      foreground: root.foreground
                      fontFamily: Style.font.family
                      leftPadding: Style.space(8)
                      bottomPadding: Style.space(2)
                    }

                    Repeater {
                      model: root.openAiModelsList
                      delegate: ModelMenuItem {
                        required property var modelData
                        width: modelMenuColumn.width
                        label: String(modelData.displayName || modelData.model)
                        selected: modelData.model === root.selectedModel
                        onTriggered: root.chooseModel(modelData.model)
                      }
                    }

                    PanelSeparator {
                      visible: root.openAiModelsList.length > 0
                      foreground: root.foreground
                    }

                    // OpenRouter Section
                    PanelSectionHeader {
                      text: "OPENROUTER"
                      foreground: root.foreground
                      fontFamily: Style.font.family
                      leftPadding: Style.space(8)
                      topPadding: root.openAiModelsList.length > 0 ? Style.space(4) : 0
                      bottomPadding: Style.space(2)
                    }

                    Repeater {
                      model: root.openRouterModelsList
                      delegate: ModelMenuItem {
                        required property var modelData
                        width: modelMenuColumn.width
                        label: String(modelData.displayName || modelData.model)
                        selected: modelData.model === root.selectedModel
                        onTriggered: root.chooseModel(modelData.model)
                      }
                    }

                    ModelMenuItem {
                      visible: root.openRouterModelsList.length === 0
                      width: modelMenuColumn.width
                      label: "Configure OpenRouter in Settings…"
                      selected: false
                      accentText: true
                      onTriggered: root.openSettings()
                    }

                    PanelSeparator {
                      visible: root.openRouterModelsList.length > 0
                      foreground: root.foreground
                    }

                    ModelMenuItem {
                      visible: root.openRouterModelsList.length > 0
                      width: modelMenuColumn.width
                      label: "OpenRouter Settings…"
                      selected: false
                      onTriggered: root.openSettings()
                    }
                  }
                }
              }
            }

            // Close Settings Button (only visible inside Settings view)
            PanelActionButton {
              visible: root.settingsOpen
              size: Style.space(28)
              iconText: "󰅖"
              tooltipText: "Back to chat (Esc)"
              foreground: root.accent
              hoverColor: root.accent
              bordered: true
              fontFamily: Style.font.family
              fontSize: Style.font.body
              onClicked: root.closeSettings()
            }
          }
        }

        Rectangle { width: parent.width; height: 1; color: Color.popups.border }

        // ---------- Settings View ----------
        Flickable {
          id: settingsScroll
          visible: root.settingsOpen
          width: parent.width
          height: parent.height - Style.space(76)
          contentWidth: width
          contentHeight: settingsColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Escape) {
              root.closeSettings()
              event.accepted = true
            } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_Comma) {
              root.closeSettings()
              event.accepted = true
            }
          }

          Column {
            id: settingsColumn
            width: settingsScroll.width
            spacing: Style.space(14)

            // Global Shortcut Card
            BorderSurface {
              width: parent.width
              implicitHeight: shortcutCardColumn.implicitHeight + Style.space(28)
              color: Style.normalFillFor(root.foreground, root.accent)
              borderSpec: Border.controlSpec("normal", root.foreground, root.accent)
              radius: Style.cornerRadius
              padding: Style.space(14)

              Column {
                id: shortcutCardColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Style.space(14)
                spacing: Style.space(10)

                Item {
                  width: parent.width
                  height: Style.spacing.controlHeight

                  Text {
                    textFormat: Text.PlainText
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Global shortcut"
                    color: root.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                  }

                  Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(6)

                    BorderSurface {
                      id: shortcutRecorderButton
                      focus: true
                      width: Math.max(Style.space(135), shortcutRecorderLabel.implicitWidth + Style.space(24))
                      height: Style.spacing.controlHeight
                      radius: Style.cornerRadius

                      readonly property bool _hot: shortcutRecorderMouse.containsMouse || root.recordingShortcut
                      color: Style.controlFill(root.recordingShortcut, _hot, root.foreground, root.accent)
                      borderSpec: Border.controlSpec(
                        root.recordingShortcut ? "focus" : (_hot ? "hover-cursor" : "normal"),
                        root.foreground,
                        root.accent
                      )

                      Text {
                        id: shortcutRecorderLabel
                        textFormat: Text.PlainText
                        anchors.centerIn: parent
                        text: root.recordingShortcut ? "Press shortcut…" : root.shortcutLabel
                        color: root.recordingShortcut ? root.accent : root.foreground
                        font.family: Style.font.family
                        font.pixelSize: Style.font.bodySmall
                        font.bold: true
                      }

                      MouseArea {
                        id: shortcutRecorderMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          if (root.recordingShortcut) root.cancelShortcutRecording()
                          else root.beginShortcutRecording()
                        }
                      }

                      Keys.priority: Keys.BeforeItem
                      Keys.onPressed: function(event) {
                        if (!root.recordingShortcut) return
                        if (event.key === Qt.Key_Escape) {
                          root.cancelShortcutRecording()
                          event.accepted = true
                          return
                        }
                        var parsed = root.keyEventToShortcutSpec(event)
                        if (!parsed) {
                          event.accepted = true
                          return
                        }
                        if (parsed.error) {
                          root.shortcutStatus = parsed.error
                          event.accepted = true
                          return
                        }
                        root.applyShortcutSpec(parsed.spec)
                        event.accepted = true
                      }
                    }

                    Button {
                      visible: root.shortcutLabel !== "Option+Space"
                      text: "Reset"
                      height: Style.spacing.controlHeight
                      bordered: true
                      foreground: root.foreground
                      accent: root.accent
                      fontFamily: Style.font.family
                      fontSize: Style.font.caption
                      tooltipText: "Reset shortcut to Option+Space"
                      onClicked: root.applyShortcutSpec("Option+Space")
                    }
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.shortcutStatus
                  color: root.recordingShortcut ? root.accent : root.dim
                  wrapMode: Text.WordWrap
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                }
              }
            }

            // OpenRouter Configuration Card
            BorderSurface {
              width: parent.width
              implicitHeight: openRouterCardColumn.implicitHeight + Style.space(28)
              color: Style.normalFillFor(root.foreground, root.accent)
              borderSpec: Border.controlSpec("normal", root.foreground, root.accent)
              radius: Style.cornerRadius
              padding: Style.space(14)

              Column {
                id: openRouterCardColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Style.space(14)
                spacing: Style.space(10)

                Item {
                  width: parent.width
                  height: Style.space(22)

                  Text {
                    textFormat: Text.PlainText
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    text: "OpenRouter"
                    color: root.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                  }

                  Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(6)

                    Rectangle {
                      width: Style.space(8)
                      height: Style.space(8)
                      radius: width / 2
                      anchors.verticalCenter: parent.verticalCenter
                      color: root.openRouterConfigured ? "#3fb950" : root.dim
                    }

                    Text {
                      textFormat: Text.PlainText
                      anchors.verticalCenter: parent.verticalCenter
                      text: root.openRouterConfigured ? "Active" : "Not configured"
                      color: root.openRouterConfigured ? root.foreground : root.dim
                      font.family: Style.font.family
                      font.pixelSize: Style.font.caption
                    }
                  }
                }

                Item {
                  width: parent.width
                  height: Style.spacing.controlHeight

                  TextField {
                    id: keyField
                    anchors.left: parent.left
                    anchors.right: keyButtonsRow.left
                    anchors.rightMargin: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    height: Style.spacing.controlHeight
                    password: !root.showOpenRouterKey
                    placeholderText: "OpenRouter API key (sk-or-v1-…)"
                    text: root.openRouterKey
                    foreground: root.foreground
                    accent: root.accent
                    onAccepted: root.saveOpenRouter()
                    Keys.onEscapePressed: root.closeSettings()
                  }

                  Row {
                    id: keyButtonsRow
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(6)

                    PanelActionButton {
                      size: Style.spacing.controlHeight
                      iconText: root.showOpenRouterKey ? "󰈉" : "󰈈"
                      tooltipText: root.showOpenRouterKey ? "Hide API key" : "Show API key"
                      foreground: root.foreground
                      hoverColor: root.accent
                      bordered: true
                      fontFamily: Style.font.family
                      onClicked: root.showOpenRouterKey = !root.showOpenRouterKey
                    }

                    Button {
                      text: "Paste"
                      height: Style.spacing.controlHeight
                      bordered: true
                      foreground: root.foreground
                      accent: root.accent
                      fontFamily: Style.font.family
                      fontSize: Style.font.caption
                      tooltipText: "Paste API key from clipboard and save"
                      onClicked: root.pasteOpenRouterKey()
                    }

                    Button {
                      text: "Save Key"
                      height: Style.spacing.controlHeight
                      bordered: true
                      selected: true
                      foreground: root.foreground
                      accent: root.accent
                      fontFamily: Style.font.family
                      fontSize: Style.font.caption
                      onClicked: root.saveOpenRouter()
                    }
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.openRouterStatus
                  color: root.dim
                  wrapMode: Text.WordWrap
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                }

                PanelSeparator { foreground: root.foreground }

                Item {
                  width: parent.width
                  height: Style.space(26)

                  Text {
                    textFormat: Text.PlainText
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Open-source models"
                    color: root.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }

                  Button {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Reset Defaults"
                    bordered: true
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: Style.font.family
                    fontSize: Style.font.caption
                    horizontalPadding: Style.space(8)
                    verticalPadding: Style.space(3)
                    onClicked: root.resetOpenRouterModels()
                  }
                }

                Column {
                  width: parent.width
                  spacing: Style.space(5)

                  Repeater {
                    model: root.openRouterModels
                    delegate: BorderSurface {
                      required property var modelData
                      width: parent.width
                      height: Style.space(30)
                      radius: Style.cornerRadius
                      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
                      borderSpec: Border.none()

                      Item {
                        anchors.fill: parent
                        anchors.leftMargin: Style.space(10)
                        anchors.rightMargin: Style.space(6)

                        Text {
                          id: rowDisplayName
                          textFormat: Text.PlainText
                          anchors.left: parent.left
                          anchors.verticalCenter: parent.verticalCenter
                          text: String(modelData.displayName || modelData.model)
                          color: root.foreground
                          font.family: Style.font.family
                          font.pixelSize: Style.font.bodySmall
                          font.bold: true
                          elide: Text.ElideRight
                        }

                        Text {
                          textFormat: Text.PlainText
                          anchors.left: rowDisplayName.right
                          anchors.leftMargin: Style.space(8)
                          anchors.right: removeModelButton.left
                          anchors.rightMargin: Style.space(6)
                          anchors.verticalCenter: parent.verticalCenter
                          text: String(modelData.model || "")
                          color: root.dim
                          font.family: Style.font.family
                          font.pixelSize: Style.font.caption
                          elide: Text.ElideRight
                        }

                        PanelActionButton {
                          id: removeModelButton
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                          size: Style.space(22)
                          iconText: "󰅖"
                          tooltipText: "Remove " + String(modelData.displayName || modelData.model)
                          enabled: root.openRouterModels.length > 1
                          foreground: root.dim
                          hoverColor: root.urgent
                          fontFamily: Style.font.family
                          fontSize: Style.font.caption
                          onClicked: root.removeOpenRouterModel(modelData.model)
                        }
                      }
                    }
                  }
                }

                Item {
                  width: parent.width
                  height: Style.spacing.controlHeight

                  TextField {
                    id: addModelField
                    anchors.left: parent.left
                    anchors.right: addModelButton.left
                    anchors.rightMargin: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    height: Style.spacing.controlHeight
                    placeholderText: "Add model (slug or slug | Display Name)"
                    text: root.newModelInput
                    foreground: root.foreground
                    accent: root.accent
                    onTextChanged: root.newModelInput = text
                    onAccepted: root.addOpenRouterModel()
                    Keys.onEscapePressed: root.closeSettings()
                  }

                  Button {
                    id: addModelButton
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Add"
                    height: Style.spacing.controlHeight
                    bordered: true
                    enabled: String(addModelField.text || "").trim() !== ""
                    opacity: enabled ? 1.0 : 0.5
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: Style.font.family
                    fontSize: Style.font.caption
                    onClicked: root.addOpenRouterModel()
                  }
                }
              }
            }

            // Shortcut & Bar Info Card
            BorderSurface {
              width: parent.width
              implicitHeight: infoCardColumn.implicitHeight + Style.space(28)
              color: Style.normalFillFor(root.foreground, root.accent)
              borderSpec: Border.controlSpec("normal", root.foreground, root.accent)
              radius: Style.cornerRadius
              padding: Style.space(14)

              Column {
                id: infoCardColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Style.space(14)
                spacing: Style.space(8)

                Text {
                  textFormat: Text.PlainText
                  text: "Omarchy Bar & Shortcuts"
                  color: root.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.subtitle
                  font.bold: true
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: "• Bar icon: Click to open the pull-down menu (Open Chat, New Chat, Settings…).\n• Summon from anywhere with " + root.shortcutLabel + " (or `omarchy-shell shell toggle dpellerin.omachatgpt '{}'`).\n• OpenAI models use your local `codex login` session; OpenRouter models use the API key above."
                  color: root.dim
                  wrapMode: Text.WordWrap
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                }
              }
            }

            Text {
              visible: root.settingsError !== ""
              textFormat: Text.PlainText
              width: parent.width
              text: root.settingsError
              color: root.urgent
              wrapMode: Text.WordWrap
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }
        }

        // ---------- Chat Transcript View ----------
        Item {
          id: transcriptContainer
          visible: !root.settingsOpen
          width: parent.width
          height: Math.max(
            Style.space(120),
            parent.height - Style.space(142)
              - Math.max(0, composer.height - Style.spacing.controlHeight)
          )

          Flickable {
            id: conversationView
            anchors.fill: parent
            contentWidth: width
            contentHeight: conversationColumn.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.VerticalFlick
            interactive: contentHeight > height
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            readonly property real maxContentY: Math.max(0, contentHeight - height)

            function updateNearBottom() {
              if (!root.opened || height <= Style.space(200)) return
              root.nearBottom = (contentHeight <= height)
                || (contentY >= maxContentY - Style.space(60))
              if (root.nearBottom && root.userScrolled && contentY >= maxContentY - Style.space(12)) {
                root.userScrolled = false
              }
              root.savedScrollY = contentY
              root.savedNearBottom = root.nearBottom
            }

            function scrollBy(deltaY) {
              root.stickToBottomOnLayout = false
              if (contentHeight <= height) {
                contentY = 0
                updateNearBottom()
                return
              }
              root.userScrolled = true
              contentY = Math.max(0, Math.min(maxContentY, contentY + deltaY))
              updateNearBottom()
            }

            function scrollToBottom() {
              root.userScrolled = false
              contentY = maxContentY
              updateNearBottom()
            }

            function restoreScrollAfterOpen() {
              if (root.savedNearBottom || root.stickToBottomOnLayout) {
                contentY = maxContentY
              } else {
                contentY = Math.max(0, Math.min(root.savedScrollY, maxContentY))
              }
              updateNearBottom()
            }

            function scrollToLatestTop() {
              root.stickToBottomOnLayout = false
              if (conversation.count === 0) {
                contentY = 0
                updateNearBottom()
                return
              }
              var lastItem = messageRepeater.itemAt(conversation.count - 1)
              if (!lastItem) {
                contentY = maxContentY
                updateNearBottom()
                return
              }
              contentY = Math.max(0, Math.min(lastItem.y, maxContentY))
              updateNearBottom()
            }

            onMovingChanged: {
              if (moving) {
                root.userScrolled = true
                root.stickToBottomOnLayout = false
              }
              updateNearBottom()
            }
            onContentYChanged: updateNearBottom()
            onContentHeightChanged: {
              if (!root.opened) return
              if (root.stickToBottomOnLayout && !root.userScrolled) {
                contentY = maxContentY
              } else if (contentY > maxContentY) {
                contentY = maxContentY
              }
              updateNearBottom()
            }
            onHeightChanged: {
              if (!root.opened || height <= Style.space(200)) return
              if (root.savedNearBottom || (root.stickToBottomOnLayout && !root.userScrolled)) {
                contentY = maxContentY
              } else if (contentY > maxContentY) {
                contentY = maxContentY
              }
              updateNearBottom()
            }

            WheelHandler {
              acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
              onWheel: function(event) {
                var dy = 0
                if (event.pixelDelta && event.pixelDelta.y !== 0) {
                  dy = -event.pixelDelta.y
                } else if (event.angleDelta && event.angleDelta.y !== 0) {
                  dy = -(event.angleDelta.y / 120.0) * Style.space(64)
                }
                if (dy !== 0) {
                  conversationView.scrollBy(dy)
                  event.accepted = true
                }
              }
            }

            Column {
              id: conversationColumn
              width: conversationView.width
              spacing: Style.space(14)

              Repeater {
                id: messageRepeater
                model: conversation

                delegate: Item {
                  id: messageDelegate
                  required property string messageId
                  required property string messageRole
                  required property string body
                  required property bool messageFinal
                  readonly property bool fromUser: messageRole === "user"
                  width: conversationColumn.width
                  height: messageBubble.height

                  Rectangle {
                    id: messageBubble
                    width: parent.width
                    height: messageColumn.implicitHeight + Style.space(24)
                    color: parent.fromUser
                      ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.08)
                      : "transparent"
                    radius: Style.cornerRadius
                    border.width: 0

                    HoverHandler { id: messageHover }

                    Column {
                      id: messageColumn
                      anchors.top: parent.top
                      anchors.left: parent.left
                      anchors.right: parent.right
                      anchors.margins: Style.space(12)
                      spacing: Style.space(8)

                      Item {
                        width: parent.width
                        height: Math.max(senderLabel.implicitHeight, messageCopyButton.implicitHeight)

                        Text {
                          id: senderLabel
                          textFormat: Text.PlainText
                          anchors.left: parent.left
                          anchors.verticalCenter: parent.verticalCenter
                          text: messageDelegate.fromUser ? "You" : "OmachatGPT"
                          color: root.dim
                          font.family: Style.font.family
                          font.pixelSize: Style.font.caption
                          font.bold: true
                        }

                        PanelActionButton {
                          id: messageCopyButton
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                          size: Style.space(20)
                          iconText: "\uDB80\uDD8F"
                          tooltipText: "Copy message"
                          foreground: root.dim
                          hoverColor: root.accent
                          opacity: messageHover.hovered ? 1.0 : 0.72
                          fontFamily: Style.font.family
                          fontSize: Style.font.caption
                          onClicked: root.copyToClipboard(messageDelegate.body, "Message")
                        }
                      }

                      Repeater {
                        model: parent.parent.parent.fromUser
                          ? [{ kind: "plain", content: parent.parent.parent.body, language: "" }]
                          : root.messageParts(parent.parent.parent.body)

                        delegate: Item {
                          required property var modelData
                          readonly property bool isCode: modelData.kind === "code"
                          readonly property bool isList: modelData.kind === "list"
                          width: messageColumn.width
                          height: isCode
                            ? codeBlock.height
                            : proseText.implicitHeight + (isList ? Style.space(8) : 0)

                          Text {
                            id: proseText
                            visible: !parent.isCode
                            y: parent.isList ? Style.space(4) : 0
                            width: parent.width
                            text: parent.modelData.kind === "plain"
                              ? parent.modelData.content
                              : root.richMarkdown(parent.modelData.content, messageDelegate.messageFinal)
                            wrapMode: Text.Wrap
                            textFormat: parent.modelData.kind === "plain"
                              ? Text.PlainText
                              : Text.RichText
                            color: root.foreground
                            linkColor: root.accent
                            font.family: Style.font.family
                            font.pixelSize: Style.font.body

                            HoverHandler {
                              cursorShape: proseText.linkAt(point.position.x, point.position.y) !== ""
                                ? Qt.PointingHandCursor
                                : Qt.IBeamCursor
                            }

                            onLinkActivated: function(link) {
                              Quickshell.execDetached(["omarchy-launch-browser", String(link)])
                              root.dismiss()
                            }
                          }

                          Rectangle {
                            id: codeBlock
                            visible: parent.isCode
                            width: parent.width
                            height: codeColumn.implicitHeight + Style.space(18)
                            color: root.codeBackground
                            radius: Math.max(4, Style.cornerRadius)
                            border.width: 1
                            border.color: root.codeBorder

                            HoverHandler { id: codeHover }

                            Column {
                              id: codeColumn
                              anchors.top: parent.top
                              anchors.left: parent.left
                              anchors.right: parent.right
                              anchors.margins: Style.space(9)
                              spacing: Style.space(6)

                              Item {
                                width: parent.width
                                height: Math.max(codeLanguage.implicitHeight, codeCopyButton.implicitHeight)

                                Text {
                                  id: codeLanguage
                                  anchors.left: parent.left
                                  anchors.verticalCenter: parent.verticalCenter
                                  text: String(codeBlock.parent.modelData.language || "code").toUpperCase()
                                  color: root.codeMuted
                                  font.family: Style.font.family
                                  font.pixelSize: Style.font.caption
                                  font.bold: true
                                }

                                PanelActionButton {
                                  id: codeCopyButton
                                  anchors.right: parent.right
                                  anchors.verticalCenter: parent.verticalCenter
                                  size: Style.space(20)
                                  iconText: "\uDB80\uDD8F"
                                  foreground: root.codeMuted
                                  hoverColor: root.codeForeground
                                  opacity: codeHover.hovered ? 1.0 : 0.72
                                  fontFamily: Style.font.family
                                  fontSize: Style.font.caption
                                  onClicked: root.copyToClipboard(codeBlock.parent.modelData.content, "Code")
                                }
                              }

                              Rectangle {
                                width: parent.width
                                height: 1
                                color: root.codeBorder
                              }

                              TextEdit {
                                width: parent.width
                                height: contentHeight
                                text: String(codeBlock.parent.modelData.content || "")
                                readOnly: true
                                selectByMouse: true
                                wrapMode: TextEdit.WrapAnywhere
                                textFormat: TextEdit.PlainText
                                color: root.codeForeground
                                selectionColor: "#3a4655"
                                selectedTextColor: root.codeForeground
                                font.family: Style.font.family
                                font.pixelSize: Style.font.body
                                horizontalAlignment: String(codeBlock.parent.modelData.language || "").toLowerCase() === "math"
                                  ? Text.AlignHCenter
                                  : Text.AlignLeft
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          Column {
            anchors.centerIn: parent
            width: parent.width - Style.space(36)
            visible: conversation.count === 0 && (root.connected || !backend.running)
            spacing: Style.space(10)

            Text {
              width: parent.width
              text: root.connected
                ? "What’s on your mind?\n\nChat with OpenAI or OpenRouter models — your conversation resumes when you reopen it."
                : "Connect an OpenAI Codex login or configure an OpenRouter API key in Settings to begin chatting."
              color: root.dim
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.Wrap
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Button {
              visible: !root.connected
              anchors.horizontalCenter: parent.horizontalCenter
              text: "Configure OpenRouter in Settings…"
              bordered: true
              selected: true
              foreground: root.foreground
              accent: root.accent
              fontFamily: Style.font.family
              fontSize: Style.font.caption
              onClicked: root.openSettings()
            }
          }

          Rectangle {
            id: latestPill
            visible: conversation.count > 0 && !root.nearBottom
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.margins: Style.space(10)
            z: 10
            width: latestRow.implicitWidth + Style.space(22)
            height: Style.space(28)
            radius: Style.cornerRadius
            color: latestMouse.containsMouse ? Qt.lighter(root.accent, 1.12) : root.accent
            border.width: 1
            border.color: Qt.lighter(root.accent, 1.25)

            Row {
              id: latestRow
              anchors.centerIn: parent
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: "↓"
                color: Color.popups.background
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: "Latest"
                color: Color.popups.background
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
              }
            }

            MouseArea {
              id: latestMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.scrollToEnd()
            }
          }
        }

        Rectangle {
          visible: !root.settingsOpen
          width: parent.width
          height: 1
          color: Color.popups.border
        }

        // ---------- Status & Action Row ----------
        Item {
          visible: !root.settingsOpen
          width: parent.width
          height: Style.space(22)

          Row {
            anchors.left: parent.left
            anchors.right: statusActionsRow.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            Rectangle {
              width: Style.space(6)
              height: Style.space(6)
              radius: width / 2
              anchors.verticalCenter: parent.verticalCenter
              color: root.lastTurnFailed || !root.connected
                ? root.urgent
                : (root.thinking ? root.accent : "#3fb950")
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width - Style.space(14)
              text: root.notice
              color: root.thinking ? root.accent : (root.connected && !root.lastTurnFailed ? root.dim : root.urgent)
              elide: Text.ElideRight
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          Row {
            id: statusActionsRow
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            Button {
              visible: root.lastTurnFailed && root.connected && !root.thinking && root.lastRequest !== ""
              text: "Retry"
              bordered: true
              foreground: root.foreground
              accent: root.accent
              fontFamily: Style.font.family
              fontSize: Style.font.caption
              horizontalPadding: Style.space(8)
              verticalPadding: Style.space(2)
              onClicked: root.retryLastMessage()
            }

            Button {
              visible: !root.connected
              text: "Reconnect"
              bordered: true
              foreground: root.foreground
              accent: root.accent
              fontFamily: Style.font.family
              fontSize: Style.font.caption
              horizontalPadding: Style.space(8)
              verticalPadding: Style.space(2)
              onClicked: root.reconnectBackend()
            }

            Button {
              visible: !root.connected && !root.openRouterConfigured
              text: "Settings"
              bordered: true
              selected: true
              foreground: root.foreground
              accent: root.accent
              fontFamily: Style.font.family
              fontSize: Style.font.caption
              horizontalPadding: Style.space(8)
              verticalPadding: Style.space(2)
              onClicked: root.openSettings()
            }
          }
        }

        // ---------- Composer ----------
        ScrollView {
          id: composer
          visible: !root.settingsOpen
          width: parent.width
          height: Math.min(
            Style.space(120),
            Math.max(
              Style.spacing.controlHeight,
              prompt.contentHeight + prompt.topPadding + prompt.bottomPadding
            )
          )
          clip: true
          ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
          ScrollBar.vertical.policy: height >= Style.space(120)
            ? ScrollBar.AsNeeded
            : ScrollBar.AlwaysOff

          readonly property var composerBorderSpec: Border.controlSpec(
            prompt.activeFocus ? "focus" : (hovered ? "hover-cursor" : "normal"),
            root.foreground,
            root.accent
          )

          background: BorderSurface {
            color: Style.controlFill(prompt.activeFocus, composer.hovered, root.foreground, root.accent)
            borderSpec: composer.composerBorderSpec
            radius: Style.cornerRadius
          }

          TextArea {
            id: prompt
            width: composer.availableWidth
            enabled: root.connected && !root.thinking && !root.modelChangePending
            placeholderText: root.thinking ? "Press Esc to stop" : "Message OmachatGPT"
            wrapMode: TextEdit.Wrap
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            color: root.foreground
            selectionColor: Style.selectionFillFor(root.foreground, root.accent)
            selectedTextColor: root.foreground
            placeholderTextColor: Qt.darker(root.foreground, 1.6)
            leftPadding: Style.spacing.controlPaddingX + Border.left(composer.composerBorderSpec)
            rightPadding: Style.spacing.controlPaddingX + Border.right(composer.composerBorderSpec)
            topPadding: Style.spacing.inputPaddingY + Border.top(composer.composerBorderSpec)
            bottomPadding: Style.spacing.inputPaddingY + Border.bottom(composer.composerBorderSpec)
            background: null

            Keys.priority: Keys.BeforeItem
            Keys.onPressed: function(event) {
              if (event.key === Qt.Key_Escape) {
                if (modelPopup.opened) modelPopup.close()
                else if (root.settingsOpen) root.closeSettings()
                else if (root.thinking) root.interrupt()
                else root.dismiss()
                event.accepted = true
              } else if ((event.modifiers & (Qt.ControlModifier | Qt.MetaModifier)) && event.key === Qt.Key_N) {
                root.newChat()
                event.accepted = true
              } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_Comma) {
                root.toggleSettings()
                event.accepted = true
              } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                         && !(event.modifiers & Qt.ShiftModifier)) {
                root.sendMessage()
                event.accepted = true
              } else if (event.key === Qt.Key_PageUp) {
                conversationView.scrollBy(-conversationView.height * 0.75)
                event.accepted = true
              } else if (event.key === Qt.Key_PageDown) {
                conversationView.scrollBy(conversationView.height * 0.75)
                event.accepted = true
              }
            }
          }
        }

        // ---------- Footer Hints ----------
        Text {
          width: parent.width
          text: root.settingsOpen
            ? "Enter save/add  ·  Esc back to chat"
            : "Enter send  ·  Shift+Enter newline  ·  Super+N new chat  ·  Ctrl+, settings  ·  Esc close"
          color: root.dim
          horizontalAlignment: Text.AlignHCenter
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  component ModelMenuItem: Rectangle {
    id: menuItem
    property string label: ""
    property bool selected: false
    property bool accentText: false
    signal triggered()

    height: Style.space(28)
    radius: Style.cornerRadius
    color: menuItemMouse.containsMouse
      ? Style.hoverFillFor(root.foreground, root.accent)
      : (selected ? Style.selectedFillFor(root.foreground, root.accent) : "transparent")

    Row {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        width: Style.space(14)
        text: menuItem.selected ? "✓" : ""
        color: root.accent
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.bold: true
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width - Style.space(22)
        text: menuItem.label
        color: menuItem.accentText ? root.accent : root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
        font.bold: menuItem.selected
        elide: Text.ElideRight
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    MouseArea {
      id: menuItemMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: menuItem.triggered()
    }
  }
}
