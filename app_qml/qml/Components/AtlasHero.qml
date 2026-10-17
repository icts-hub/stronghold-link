import QtQuick
import QtQuick.Controls

/* QML hero card concept, with decorative art separated from clickable UI. */
Rectangle {
    id: root
    property url artworkSource: "../../assets/bird-atlas-hero.png"
    property bool motionEnabled: true
    property real motionIntensity: 0.55
    property string title: qsTr("Find your flock.")
    property string subtitle: qsTr("One host · Friends invited · Your world")
    color: "#C5D1CD"
    border.color: "#AABBB7"
    border.width: 1
    clip: true

    AtlasBackdrop {
        anchors.fill: parent
        artworkSource: root.artworkSource
        motionEnabled: root.motionEnabled
        motionIntensity: root.motionIntensity
    }

    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: "#E8EEEA" }
            GradientStop { position: 0.28; color: "#DCE5DFD9" }
            GradientStop { position: 0.58; color: "#DCE5DF55" }
            GradientStop { position: 1.0; color: "#DCE5DF12" }
        }
    }

    Row {
        anchors.left: parent.left
        anchors.leftMargin: 22
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 18
        spacing: 12
        Text {
            text: "01"
            color: "#2455B7"
            font.family: "monospace"
            font.pixelSize: 28
        }
        Rectangle { width: 1; height: 35; color: "#7893B1"; anchors.verticalCenter: parent.verticalCenter }
        Column {
            anchors.verticalCenter: parent.verticalCenter
            spacing: 4
            Text { text: root.title; color: "#192D46"; font.pixelSize: 14; font.weight: Font.DemiBold }
            Text { text: root.subtitle; color: "#52677A"; font.pixelSize: 10 }
        }
    }

    Text {
        anchors.left: parent.left; anchors.top: parent.top
        anchors.leftMargin: 18; anchors.topMargin: 14
        text: "FIG. 01 — FLIGHT PATHS"
        color: "#31547C"; font.family: "monospace"; font.pixelSize: 8; letterSpacing: 1.1
    }
    Text {
        anchors.right: parent.right; anchors.top: parent.top
        anchors.rightMargin: 18; anchors.topMargin: 14
        text: "VECTOR STUDY / ACTIVE"
        color: "#31547C"; font.family: "monospace"; font.pixelSize: 8; letterSpacing: 1.1
    }
}
