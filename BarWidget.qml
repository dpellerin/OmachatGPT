import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "dpellerin.omachatgpt"

  readonly property string pluginId: moduleName || "dpellerin.omachatgpt"
  readonly property bool panelOpen: root.bar && root.bar.shell && typeof root.bar.shell.isPluginOpen === "function"
    ? root.bar.shell.isPluginOpen(pluginId)
    : false
  readonly property color foreground: Color.popups.text
  readonly property color accent: Color.accent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string configuredShortcutLabel: String(setting("shortcutLabel", "Option+Space"))

  property bool menuOpen: false
  property bool popoutSwitchClosing: false
  property int selectedIndex: 0

  readonly property var menuItems: [
    {
      action: "toggleChat",
      icon: "\uDB80\uDF69",
      label: root.panelOpen ? "Hide Chat" : "Open Chat",
      shortcut: root.configuredShortcutLabel
    },
    {
      action: "newChat",
      icon: "󰐕",
      label: "New Chat",
      shortcut: "Super+N"
    },
    {
      action: "settings",
      icon: "󰒓",
      label: "Settings…",
      shortcut: "Ctrl+,"
    }
  ]

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function open() {
    root.selectedIndex = 0
    root.menuOpen = true
  }

  function close() {
    root.menuOpen = false
  }

  function closeForPopoutSwitch() {
    root.popoutSwitchClosing = true
    root.close()
    Qt.callLater(function() { root.popoutSwitchClosing = false })
  }

  function toggleMenu() {
    if (root.menuOpen) root.close()
    else root.open()
  }

  function summonWithPayload(payload) {
    if (root.bar && root.bar.shell && typeof root.bar.shell.summon === "function") {
      root.bar.shell.summon(pluginId, JSON.stringify(payload || {}))
    } else if (root.bar) {
      root.bar.run("omarchy-shell shell summon " + pluginId + " '" + JSON.stringify(payload || {}) + "'")
    }
  }

  function togglePanel() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.toggle === "function") {
      root.bar.shell.toggle(pluginId, "{}")
    } else if (root.bar) {
      root.bar.run("omarchy-shell shell toggle " + pluginId + " '{}'")
    }
  }

  function triggerAction(action) {
    root.close()
    if (action === "toggleChat") {
      if (root.panelOpen) {
        if (root.bar && root.bar.shell && typeof root.bar.shell.hide === "function") {
          root.bar.shell.hide(pluginId)
        } else {
          root.togglePanel()
        }
      } else {
        root.summonWithPayload({ action: "chat" })
      }
    } else if (action === "newChat") {
      root.summonWithPayload({ action: "newChat" })
    } else if (action === "settings") {
      root.summonWithPayload({ action: "settings" })
    }
  }

  function moveCursor(delta) {
    if (root.menuItems.length === 0) return
    var next = (root.selectedIndex + delta + root.menuItems.length) % root.menuItems.length
    root.selectedIndex = next
  }

  function activateCursor() {
    var entry = root.menuItems[root.selectedIndex]
    if (entry) root.triggerAction(entry.action)
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uDB80\uDF69"
    tooltipText: root.menuOpen ? "" : ("OmachatGPT (" + root.configuredShortcutLabel + ")")
    active: root.menuOpen || root.panelOpen
    onPressed: function(_mouseButton) {
      root.toggleMenu()
    }
  }

  KeyboardPanel {
    id: dropdown
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.menuOpen
    focusTarget: keyCatcher
    padding: Style.space(6)
    contentWidth: dropdown.fittedContentWidth(Style.space(220))
    contentHeight: dropdown.fittedContentHeight(menuColumn.implicitHeight, Style.space(260))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(_dx, dy) {
        if (dy !== 0) root.moveCursor(dy > 0 ? 1 : -1)
      }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTextKey: function(t) {
        if (t === "c" || t === "C") root.triggerAction("toggleChat")
        else if (t === "n" || t === "N") root.triggerAction("newChat")
        else if (t === "s" || t === "S" || t === ",") root.triggerAction("settings")
      }

      Column {
        id: menuColumn
        width: parent.width
        spacing: Style.space(2)

        Repeater {
          model: root.menuItems
          delegate: Rectangle {
            id: rowItem
            required property var modelData
            required property int index
            readonly property bool highlighted: root.selectedIndex === index || rowMouse.containsMouse

            width: menuColumn.width
            height: Style.space(32)
            radius: Style.cornerRadius
            color: highlighted
              ? Style.hoverFillFor(root.foreground, root.accent)
              : "transparent"

            Item {
              anchors.fill: parent
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)

              Row {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)

                Text {
                  textFormat: Text.PlainText
                  width: Style.space(16)
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                  text: String(rowItem.modelData.icon || "")
                  color: rowItem.highlighted ? root.accent : root.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                }

                Text {
                  textFormat: Text.PlainText
                  anchors.verticalCenter: parent.verticalCenter
                  text: String(rowItem.modelData.label || "")
                  color: root.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.bold: rowItem.highlighted
                }
              }

              Text {
                textFormat: Text.PlainText
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                text: String(rowItem.modelData.shortcut || "")
                color: root.dim
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            MouseArea {
              id: rowMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onEntered: root.selectedIndex = rowItem.index
              onClicked: root.triggerAction(rowItem.modelData.action)
            }
          }
        }
      }
    }
  }
}
