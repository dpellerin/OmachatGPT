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
  property bool expectedStop: false
  property string notice: "Connecting to ChatGPT…"
  property string streamingId: ""
  property string noticeBeforeCopy: ""
  property double backendStartedAt: 0
  property int coldStarts: 0
  property int warmReopens: 0
  property int lastBackendReadyMs: -1
  property int lastFirstTokenMs: -1
  property int lastResponseMs: -1

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

  ListModel { id: conversation }

  function open(payloadJson) {
    root.opened = true
    warmShutdownTimer.stop()
    if (backend.running) root.warmReopens++
    root.startBackend()
    Qt.callLater(function() { if (root.opened) prompt.forceActiveFocus() })
  }

  function close() {
    root.opened = false
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

  function startBackend() {
    if (backend.running || root.bridgePath === "") return
    warmShutdownTimer.stop()
    root.expectedStop = false
    root.connected = false
    root.thinking = false
    root.notice = "Connecting to ChatGPT…"
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
    if (!text || !root.connected || root.thinking) return
    prompt.text = ""
    conversation.append({ messageId: "user-" + Date.now(), messageRole: "user", body: text, messageFinal: true })
    root.streamingId = ""
    root.thinking = true
    root.notice = "Thinking…"
    root.sendCommand({ type: "send", text: text })
    root.scrollToEnd()
  }

  function newChat() {
    if (!root.connected || root.thinking) return
    root.connected = false
    root.notice = "Starting a new chat…"
    root.sendCommand({ type: "newChat" })
  }

  function interrupt() {
    if (!root.thinking) return
    root.notice = "Stopping…"
    root.sendCommand({ type: "interrupt" })
  }

  function scrollToEnd() {
    Qt.callLater(function() {
      if (conversationView.count > 0) conversationView.positionViewAtEnd()
    })
  }

  function replaceMessages(messages) {
    conversation.clear()
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
        root.scrollToEnd()
        return
      }
    }
    conversation.append({ messageId: id, messageRole: "assistant", body: String(delta || ""), messageFinal: false })
    root.scrollToEnd()
  }

  function replaceMessage(itemId, text) {
    var id = String(itemId || root.streamingId || ("assistant-" + Date.now()))
    root.streamingId = id
    for (var i = 0; i < conversation.count; i++) {
      if (conversation.get(i).messageId === id) {
        conversation.setProperty(i, "body", String(text || ""))
        conversation.setProperty(i, "messageFinal", true)
        root.scrollToEnd()
        return
      }
    }
    conversation.append({ messageId: id, messageRole: "assistant", body: String(text || ""), messageFinal: true })
    root.scrollToEnd()
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
      root.replaceMessages(event.messages || [])
      root.connected = true
      root.thinking = false
      root.notice = event.notice || "Ready"
      Qt.callLater(function() { if (root.opened) prompt.forceActiveFocus() })
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
      root.notice = "Ready"
      Qt.callLater(function() { if (root.opened) prompt.forceActiveFocus() })
    } else if (event.type === "metric") {
      if (event.name === "first-token") root.lastFirstTokenMs = Number(event.durationMs)
      else if (event.name === "response") root.lastResponseMs = Number(event.durationMs)
    } else if (event.type === "error" || event.type === "fatal") {
      root.streamingId = ""
      root.thinking = false
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
      width: Math.min(Style.space(540), panel.width - Style.gapsOut * 2)
      height: Math.min(Style.space(820), panel.height - Style.gapsOut * 2)
      anchors.right: parent.right
      anchors.rightMargin: Style.gapsOut
      anchors.verticalCenter: parent.verticalCenter
      color: Color.popups.background
      borderSpec: root.borderSpec
      radius: Style.cornerRadius
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: {} }

      Column {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: Style.space(10)

        Item {
          width: parent.width
          height: Style.space(30)

          Text {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "Quick Chat"
            color: root.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: "GPT 5.6 Luna  ·  low"
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }

        Rectangle { width: parent.width; height: 1; color: Color.popups.border }

        ListView {
          id: conversationView
          width: parent.width
          height: Math.max(
            Style.space(120),
            parent.height - Style.space(138)
              - Math.max(0, composer.height - Style.spacing.controlHeight)
          )
          model: conversation
          clip: true
          spacing: Style.space(14)
          boundsBehavior: Flickable.StopAtBounds

          delegate: Item {
            id: messageDelegate
            required property string messageId
            required property string messageRole
            required property string body
            required property bool messageFinal
            readonly property bool fromUser: messageRole === "user"
            width: conversationView.width
            height: messageBubble.height

            Rectangle {
              id: messageBubble
              width: parent.fromUser ? Math.round(parent.width * 0.9) : parent.width
              height: messageColumn.implicitHeight + (parent.fromUser ? Style.space(14) : 0)
              anchors.left: parent.fromUser ? undefined : parent.left
              anchors.right: parent.fromUser ? parent.right : undefined
              color: parent.fromUser
                ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.075)
                : "transparent"
              radius: Style.cornerRadius
              border.width: 0

              HoverHandler { id: messageHover }

              Column {
                id: messageColumn
                anchors.fill: parent
                anchors.margins: parent.parent.fromUser ? Style.space(7) : 0
                spacing: Style.space(4)

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

                Item {
                  width: parent.width
                  height: messageCopyButton.implicitHeight

                  PanelActionButton {
                    id: messageCopyButton
                    anchors.left: messageDelegate.fromUser ? undefined : parent.left
                    anchors.right: messageDelegate.fromUser ? parent.right : undefined
                    anchors.verticalCenter: parent.verticalCenter
                    size: Style.space(20)
                    iconText: "\uDB80\uDD8F"
                    foreground: root.foreground
                    hoverColor: root.accent
                    opacity: messageHover.hovered ? 1.0 : 0.68
                    fontFamily: Style.font.family
                    fontSize: Style.font.caption
                    onClicked: root.copyToClipboard(messageDelegate.body, "Message")
                  }
                }
              }
            }
          }

          Text {
            anchors.centerIn: parent
            width: parent.width - Style.space(36)
            visible: conversation.count === 0 && root.connected
            text: "What’s on your mind?\n\nYour Quick Chat resumes when you reopen it."
            color: root.dim
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }
        }

        Rectangle { width: parent.width; height: 1; color: Color.popups.border }

        Text {
          width: parent.width
          text: root.notice
          color: root.thinking ? root.accent : (root.connected ? root.dim : root.urgent)
          elide: Text.ElideRight
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        ScrollView {
          id: composer
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
            enabled: root.connected && !root.thinking
            placeholderText: root.thinking ? "Press Esc to stop" : "Message ChatGPT"
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
                if (root.thinking) root.interrupt()
                else root.dismiss()
                event.accepted = true
              } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_N) {
                root.newChat()
                event.accepted = true
              } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                         && !(event.modifiers & Qt.ShiftModifier)) {
                root.sendMessage()
                event.accepted = true
              } else if (event.key === Qt.Key_PageUp) {
                conversationView.contentY = Math.max(0, conversationView.contentY - conversationView.height * 0.75)
                event.accepted = true
              } else if (event.key === Qt.Key_PageDown) {
                conversationView.contentY = Math.min(
                  Math.max(0, conversationView.contentHeight - conversationView.height),
                  conversationView.contentY + conversationView.height * 0.75
                )
                event.accepted = true
              }
            }
          }
        }

        Text {
          width: parent.width
          text: "Enter send  ·  Shift+Enter newline  ·  Ctrl+N new  ·  PgUp/PgDn  ·  Esc close"
          color: root.dim
          horizontalAlignment: Text.AlignHCenter
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
