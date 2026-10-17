import QtQuick
import QtQuick.Shapes

/*
 * AtlasDecorLayer.qml — OPTIONAL DECORATION LAYER ONLY.
 *
 * This component is not an application shell and owns no navigation, buttons,
 * session state, Steam model, keyboard shortcuts, or business logic.
 * Integrate it INSIDE the project's EXISTING background/decorative host.
 * Keep its host geometry unchanged; do not add it as a Layout-managed item.
 *
 * Set artworkSource to the project's packaged URL (qrc:/...) after inspecting
 * the actual resource aliases. The standalone relative path is only a sample.
 */
Item {
    id: root
    property url artworkSource: "qrc:/qml/assets/bird-study-sheet.svg"
    property bool motionEnabled: true
    property bool reduceMotion: false
    property real artworkOpacity: 0.14
    property real motionIntensity: 0.35
    property color lineColor: "#2455B7"
    property bool orbitLinesVisible: true

    // Transparent and input-inert. Do not introduce a new control or action.
    enabled: false
    focus: false
    opacity: 1.0
    clip: true

    Item {
        id: motionGroup
        anchors.fill: parent
        opacity: root.artworkOpacity
        property real driftX: 0
        transform: Translate { x: motionGroup.driftX }

        Image {
            anchors.fill: parent
            source: root.artworkSource
            fillMode: Image.PreserveAspectFit
            smooth: true
            mipmap: true
            asynchronous: true
            cache: true
            opacity: 1.0
        }

        // Transform-only movement: preserve every source bird contour.
        SequentialAnimation on driftX {
            running: root.motionEnabled && !root.reduceMotion && root.visible && root.width > 0
            loops: Animation.Infinite
            NumberAnimation {
                to: Math.max(0, root.width) * 0.008
                duration: Math.max(18000, 36000 - root.motionIntensity * 12000)
                easing.type: Easing.InOutSine
            }
            NumberAnimation {
                to: -Math.max(0, root.width) * 0.008
                duration: Math.max(18000, 36000 - root.motionIntensity * 12000)
                easing.type: Easing.InOutSine
            }
        }
    }

    Shape {
        anchors.fill: parent
        visible: root.orbitLinesVisible
                 && root.motionEnabled
                 && !root.reduceMotion
                 && root.width > 0 && root.height > 0
        opacity: root.artworkOpacity * 0.55

        ShapePath {
            strokeColor: root.lineColor
            strokeWidth: 1
            fillColor: "transparent"
            dashPattern: [4, 9]
            startX: 0
            startY: root.height * 0.82
            PathCubic {
                x: root.width
                y: root.height * 0.22
                control1X: root.width * 0.20
                control1Y: root.height * 0.12
                control2X: root.width * 0.72
                control2Y: root.height * 0.94
            }
        }
    }
}
