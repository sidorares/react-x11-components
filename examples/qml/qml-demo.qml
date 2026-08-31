// The three ways a type name resolves, side by side:
//   Backdrop  — the implicit same-directory import (Backdrop.qml, no line)
//   Meter     — an explicit quoted import through the resolver seam
//   Gauge     — an explicit module import, registered with registerQmlModule
//   Button    — QtQuick.Controls, registered with registerControls
import QtQuick 2.15
import QtQuick.Controls 2.15
import "./widgets"
import Demo 1.0

Backdrop {
    id: root
    width: 560
    height: 420
    title: "QML on react-x11"

    property int count: 0
    property string filter: ""

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

    Gauge {
        x: 20; y: 126; width: 260; height: 10
        value: root.count % 8
        max: 8
    }

    Row {
        x: 20; y: 148
        spacing: 8
        Repeater {
            model: meter.hues
            Rectangle {
                width: 48; height: 32; radius: 4
                color: modelData
                MouseArea {
                    anchors.fill: parent
                    onClicked: root.count = root.count + index + 1
                }
            }
        }
    }

    Rectangle {
        x: 20; y: 196; width: 120; height: 36; radius: 8
        color: bumpArea.pressed ? "#1f6feb" : "#2f81f7"
        MouseArea { id: bumpArea; anchors.fill: parent; onClicked: root.count++ }
        Text {
            anchors.centerIn: parent
            text: "count++"
            color: "white"
            font.bold: true
        }
    }

    Button {
        x: 156; y: 196
        width: 130; height: 36
        text: "React button"
        onClicked: root.count = 0
    }

    TextInput {
        id: search
        x: 300; y: 84; width: 240; height: 28
        color: "white"
        onTextChanged: root.filter = text.toLowerCase()
    }
    Rectangle { x: 300; y: 112; width: 240; height: 1; color: "#2a3440" }
    ListView {
        x: 300; y: 120; width: 240; height: 170
        spacing: 2
        model: ListModel {
            ListElement { name: "Bill Smith"; number: "555 3264" }
            ListElement { name: "John Brown"; number: "555 8426" }
            ListElement { name: "Sam Wise"; number: "555 0473" }
            ListElement { name: "Anna Gray"; number: "555 1200" }
            ListElement { name: "Iris Blue"; number: "555 7351" }
        }
        delegate: Rectangle {
            width: 240; height: 30
            color: index % 2 === 0 ? "#161c23" : "#1b232c"
            visible: root.filter === "" || name.toLowerCase().indexOf(root.filter) !== -1
            Text { x: 8; y: 6; color: "#c9d1d9"; text: name + "  ·  " + number }
        }
    }

    Text {
        x: 20; y: 250
        width: 260
        wrapMode: Text.WordWrap
        color: "#c9d1d9"
        font.pixelSize: 13
        text: "Backdrop.qml resolves implicitly from this directory, Meter through import \"./widgets\", the Gauge from a registerQmlModule module, the button from registerControls. Edit any of the .qml files while this runs — count survives the reload."
    }
}
