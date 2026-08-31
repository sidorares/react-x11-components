// Reached through the *explicit quoted import* — `import "./widgets"` in
// qml-demo.qml — the second resolver-seam path.
import QtQuick 2.15

Rectangle {
    property int level: 0
    property var hues: ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#3498db"]

    width: 60 + (level % 8) * 55
    height: 30
    radius: 6
    color: hues[level % hues.length]
    Behavior on width { NumberAnimation { duration: 220 } }

    Text {
        anchors.centerIn: parent
        text: level
        color: "white"
        font.bold: true
    }
}
