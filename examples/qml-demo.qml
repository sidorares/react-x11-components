import QtQuick 2.15
import QtQuick.Controls 2.15

Rectangle {
    id: root
    width: 560
    height: 420
    color: "#101418"
    radius: 10

    property int count: 0
    property var palette: ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#3498db"]
    property string time: ""
    property string filter: ""

    Text {
        x: 20; y: 16
        text: "QML on react-x11"
        color: "white"
        font.pixelSize: 24
        font.bold: true
    }
    Text {
        x: 20; y: 52
        text: root.time === "" ? "starting clock…" : root.time
        color: "#8899aa"
        font.pixelSize: 13
    }
    Timer {
        interval: 1000; running: true; repeat: true
        onTriggered: root.time = new Date().toLocaleTimeString()
    }

    // A meter driven by bindings; the Behavior rides react-x11's own
    // transition engine. Click it: `states` swap its colour through a
    // Transition, also renderer-eased.
    Rectangle {
        id: meter
        x: 20; y: 84
        width: 60 + (root.count % 8) * 55
        height: 30
        radius: 6
        color: root.palette[root.count % root.palette.length]
        Behavior on width { NumberAnimation { duration: 220 } }
        Text {
            anchors.centerIn: parent
            text: root.count
            color: "white"
            font.bold: true
        }
        MouseArea { anchors.fill: parent; onClicked: root.state = root.state === "calm" ? "" : "calm" }
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

    Row {
        x: 20; y: 132
        spacing: 8
        Repeater {
            model: root.palette
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
        x: 20; y: 184; width: 120; height: 36; radius: 8
        color: bumpArea.pressed ? "#1f6feb" : "#2f81f7"
        MouseArea { id: bumpArea; anchors.fill: parent; onClicked: root.count++ }
        Text {
            anchors.centerIn: parent
            text: "count++"
            color: "white"
            font.bold: true
        }
    }

    // A react-x11 widget, instantiated from QML.
    Button {
        x: 156; y: 184
        width: 130; height: 36
        text: "React button"
        onClicked: root.count = 0
    }

    // The P1 corner: a filtered contact list — TextInput two-way, a
    // ListModel, and a windowed ListView.
    TextInput {
        id: search
        x: 300; y: 84; width: 240; height: 28
        color: "white"
        onTextChanged: root.filter = text.toLowerCase()
    }
    Rectangle { x: 300; y: 112; width: 240; height: 1; color: "#2a3440" }
    ListView {
        id: contacts
        x: 300; y: 120; width: 240; height: 160
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
        x: 20; y: 248
        width: 260
        wrapMode: Text.WordWrap
        color: "#c9d1d9"
        font.pixelSize: 13
        text: "Edit qml-demo.qml while this runs — the tree hot-swaps and `count` survives the reload. Click the meter for a state change through a Transition."
    }
}
