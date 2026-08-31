// The three ways a type name resolves, side by side:
//   Backdrop  — the implicit same-directory import (Backdrop.qml, no line)
//   Meter     — an explicit quoted import through the resolver seam
//   Gauge     — an explicit module import, registered with registerQmlModule
//   Button    — QtQuick.Controls, registered with registerControls
//
// And two ways to place things. Most of this document is QtQuick.Layouts —
// ColumnLayout/RowLayout lowered onto the renderer's own flex engine, with
// the laid-out geometry readable back in bindings. Absolute x/y appears
// only where it earns its keep: Backdrop's title chrome, and the Meter,
// whose Behavior animates the width slot itself.
import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "./widgets"
import Demo 1.0

Backdrop {
    id: root
    width: 560
    height: 430
    title: "QML on react-x11"

    property int count: 0
    property string filter: ""

    // Minimal absolute positioning: the animated meter (its Behavior and
    // the state Transition ease the width slot itself).
    Meter {
        id: meter
        x: 20; y: 84
        level: root.count
        MouseArea {
            anchors.fill: parent
            onClicked: root.state = root.state === "calm" ? "" : "calm"
        }
    }
    states: [
        State {
            name: "calm"
            PropertyChanges { target: meter; color: "#7f8c8d"; width: 60 }
        }
    ]
    transitions: [
        Transition { NumberAnimation { properties: "width"; duration: 300 } }
    ]

    // Everything below: QtQuick.Layouts.
    RowLayout {
        x: 20; y: 128
        width: root.width - 40
        height: root.height - 148
        spacing: 16

        ColumnLayout {
            Layout.preferredWidth: 264
            Layout.alignment: Qt.AlignTop
            spacing: 12

            Gauge {
                Layout.fillWidth: true
                Layout.preferredHeight: 10
                value: root.count % 8
                max: 8
            }

            RowLayout {
                spacing: 8
                Repeater {
                    model: meter.hues
                    Rectangle {
                        Layout.preferredWidth: 48
                        Layout.preferredHeight: 32
                        radius: 4
                        color: modelData
                        MouseArea {
                            anchors.fill: parent
                            onClicked: root.count = root.count + index + 1
                        }
                    }
                }
            }

            RowLayout {
                spacing: 10
                Rectangle {
                    Layout.preferredWidth: 120
                    Layout.preferredHeight: 36
                    radius: 8
                    color: bumpArea.pressed ? "#1f6feb" : "#2f81f7"
                    MouseArea {
                        id: bumpArea
                        anchors.fill: parent
                        onClicked: root.count++
                    }
                    Text {
                        anchors.centerIn: parent
                        text: "count++"
                        color: "white"
                        font.bold: true
                    }
                }
                Button {
                    Layout.preferredWidth: 130
                    Layout.preferredHeight: 36
                    text: "React button"
                    onClicked: root.count = 0
                }
            }

            Text {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                color: "#c9d1d9"
                font.pixelSize: 13
                text: "Backdrop.qml resolves implicitly, Meter through import \"./widgets\", the Gauge from a registerQmlModule module — and this whole panel is ColumnLayout/RowLayout on the renderer's flex engine. Edit any .qml file while this runs; count survives the reload."
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 8

            TextInput {
                id: search
                Layout.fillWidth: true
                Layout.preferredHeight: 28
                color: "white"
                onTextChanged: root.filter = text.toLowerCase()
            }
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 1
                color: "#2a3440"
            }
            ListView {
                id: contacts
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 2
                model: ListModel {
                    ListElement { name: "Bill Smith"; number: "555 3264" }
                    ListElement { name: "John Brown"; number: "555 8426" }
                    ListElement { name: "Sam Wise"; number: "555 0473" }
                    ListElement { name: "Anna Gray"; number: "555 1200" }
                    ListElement { name: "Iris Blue"; number: "555 7351" }
                }
                delegate: Rectangle {
                    width: contacts.width
                    height: 30
                    color: index % 2 === 0 ? "#161c23" : "#1b232c"
                    visible: root.filter === "" || name.toLowerCase().indexOf(root.filter) !== -1
                    Text { x: 8; y: 6; color: "#c9d1d9"; text: name + "  ·  " + number }
                }
            }
        }
    }
}
