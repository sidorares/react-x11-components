// The *implicit same-directory import*: nothing imports this file — using
// `Backdrop { }` in any document beside it resolves it by name, and a
// local <Name>.qml shadows module types, exactly as in Qt.
import QtQuick 2.15

Rectangle {
    id: chrome
    color: "#101418"
    radius: 10

    property string title: "QML on react-x11"
    property string clock: ""

    Timer {
        interval: 1000; running: true; repeat: true
        onTriggered: chrome.clock = new Date().toLocaleTimeString()
    }

    Text {
        x: 20; y: 16
        text: chrome.title
        color: "white"
        font.pixelSize: 24
        font.bold: true
    }
    Text {
        x: 20; y: 52
        text: chrome.clock === "" ? "starting clock…" : chrome.clock
        color: "#8899aa"
        font.pixelSize: 13
    }
}
