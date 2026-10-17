import QtQuick
import QtQuick.Shapes

/*
 * Decorative-only atlas background.
 * Keep this item behind all interactive content: enabled=false prevents it
 * from intercepting pointer/touch events. No networking logic belongs here.
 */
Item {
    id: root
    property url artworkSource: "../../assets/bird-atlas-hero.png"
    property bool motionEnabled: true
    property real motionIntensity: 0.55
    property color lineColor: "#2455B7"
    clip: true

    Image {
        id: artwork
        anchors.fill: parent
        source: root.artworkSource
        fillMode: Image.PreserveAspectCrop
        smooth: true
        asynchronous: true
        cache: true
        opacity: 0.92
        scale: 1.02
        transformOrigin: Item.Center
        SequentialAnimation on scale {
            running: root.motionEnabled && root.visible
            loops: Animation.Infinite
            NumberAnimation { to: 1.075; duration: Math.max(15000, 34000 - root.motionIntensity * 18000); easing.type: Easing.InOutSine }
            NumberAnimation { to: 1.02; duration: Math.max(15000, 34000 - root.motionIntensity * 18000); easing.type: Easing.InOutSine }
        }
    }

    Rectangle {
        anchors.fill: parent
        color: "#E8EEEA"
        opacity: 0.20
    }

    Shape {
        anchors.fill: parent
        ShapePath {
            strokeColor: root.lineColor
            strokeWidth: 1
            strokeOpacity: 0.52
            fillColor: "transparent"
            dashPattern: [5, 7]
            startX: 0; startY: root.height * 0.88
            PathCubic {
                x: root.width * 0.48; y: root.height * 0.05
                control1X: root.width * 0.2; control1Y: root.height * 0.7
                control2X: root.width * 0.26; control2Y: root.height * 0.1
            }
        }
        ShapePath {
            strokeColor: root.lineColor
            strokeWidth: 1
            strokeOpacity: 0.42
            fillColor: "transparent"
            PathAngleArc {
                centerX: root.width * 0.76
                centerY: root.height * 0.55
                radiusX: Math.min(root.width, root.height) * 0.28
                radiusY: Math.min(root.width, root.height) * 0.28
                startAngle: 0
                sweepAngle: 360
            }
        }
    }

    // Crosshair anchors subtly pulse; these are not status indicators.
    Repeater {
        model: [0.22, 0.41, 0.74, 0.88]
        delegate: Rectangle {
            required property real modelData
            x: root.width * modelData
            y: root.height * (0.14 + (index % 2) * 0.61)
            width: 4; height: 4; radius: 2
            color: root.lineColor
            opacity: 0.55
        }
    }

    // Explicitly behind controls. This layer must never accept input.
    enabled: false
}
