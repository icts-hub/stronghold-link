import QtQuick
import QtQuick.Shapes

// Drop-in, non-interactive decorative background for a Qt Quick page.
// Put page content above this item in the z-order; this component never handles input.
Item {
    id: root
    clip: true
    property color paperColor: "#b8c5c2"
    property color inkColor: "#315d9c"
    property color railColor: "#2055b6"
    property bool motionEnabled: true
    property bool showBirdNumbers: true
    property real motionSpeed: 1.0
    property int birdCount: birdSpecs.length

    // Normalized positions and scale factors preserve composition across window sizes.
    property var birdSpecs: [
        {x:.025,y:.39,s:.15,a:-18},{x:.085,y:.49,s:.13,a:12},{x:.13,y:.33,s:.15,a:-7},{x:.175,y:.58,s:.14,a:14},
        {x:.21,y:.42,s:.16,a:-12},{x:.255,y:.34,s:.14,a:17},{x:.29,y:.49,s:.17,a:-9},{x:.33,y:.39,s:.14,a:8},
        {x:.37,y:.30,s:.15,a:-14},{x:.405,y:.55,s:.16,a:12},{x:.44,y:.42,s:.15,a:-17},{x:.48,y:.34,s:.17,a:8},
        {x:.515,y:.49,s:.14,a:-8},{x:.555,y:.39,s:.15,a:15},{x:.59,y:.31,s:.16,a:-12},{x:.625,y:.48,s:.14,a:5},
        {x:.665,y:.38,s:.16,a:-16},{x:.70,y:.53,s:.15,a:13},{x:.735,y:.33,s:.15,a:-7},{x:.77,y:.44,s:.17,a:10},
        {x:.805,y:.35,s:.14,a:-13},{x:.84,y:.48,s:.15,a:14},{x:.875,y:.40,s:.17,a:-9},{x:.91,y:.33,s:.14,a:12},
        {x:.95,y:.47,s:.16,a:-12},{x:.25,y:.66,s:.13,a:-6},{x:.36,y:.22,s:.12,a:13},{x:.46,y:.59,s:.12,a:-10},
        {x:.57,y:.24,s:.13,a:9},{x:.68,y:.62,s:.12,a:-14},{x:.79,y:.63,s:.13,a:7},{x:.88,y:.56,s:.12,a:-12}
    ]

    Rectangle { anchors.fill: parent; color: root.paperColor }
    Rectangle { width: root.width * 0.1035; height: root.height; color: root.railColor }
    // Pale breaks across the cobalt rail echo paper registration marks.
    Repeater {
        model: [0.272, 0.349, 0.698]
        delegate: Rectangle {
            x: 0; y: modelData * root.height
            width: root.width * 0.1035; height: root.height * 0.026
            color: root.paperColor
        }
    }

    // Sparse technical-paper dot grid. Stable delegates avoid per-frame object creation.
    Repeater {
        model: 144
        delegate: Rectangle {
            width: 2; height: 2; radius: 1
            x: ((index * 137) % 1570) / 1600 * root.width
            y: ((index * 83) % 850) / 900 * root.height
            color: root.inkColor; opacity: 0.30
        }
    }

    Shape {
        anchors.fill: parent
        ShapePath {
            strokeColor: Qt.rgba(root.inkColor.r, root.inkColor.g, root.inkColor.b, 0.58); strokeWidth: 1.25; fillColor: "transparent"; PathSvg { path: "M165 300 A205 370 35 1 0 575 300 A205 370 35 1 0 165 300" }
        }
        ShapePath {
            strokeColor: Qt.rgba(root.inkColor.r, root.inkColor.g, root.inkColor.b, 0.58); strokeWidth: 1.5; fillColor: "transparent"; PathSvg { path: "M1035 445 A175 185 -18 1 0 1385 445 A175 185 -18 1 0 1035 445" }
        }
        ShapePath {
            strokeColor: Qt.rgba(root.inkColor.r, root.inkColor.g, root.inkColor.b, 0.5); strokeWidth: 1.2; fillColor: "transparent"; PathSvg { path: "M40 740 C250 620 285 150 575 50 S900 90 800 325 S625 660 430 820" }
        }
        ShapePath {
            strokeColor: Qt.rgba(root.inkColor.r, root.inkColor.g, root.inkColor.b, 0.42); strokeWidth: 1.1; fillColor: "transparent"; PathSvg { path: "M1060 470 C1150 295 1275 250 1435 360 S1510 575 1375 650" }
        }
        ShapePath {
            strokeColor: Qt.rgba(root.inkColor.r, root.inkColor.g, root.inkColor.b, 0.65); strokeWidth: 1.05; fillColor: "transparent"; PathSvg { path: "M0 445 H1600 M390 120 V146 M377 133 H403 M648 590 V776 M634 790 A14 14 0 1 0 662 790 A14 14 0 1 0 634 790" }
        }
    }

    Repeater {
        model: root.birdSpecs
        delegate: FlightBird {
            id: bird
            property real baseX: modelData.x * root.width - width / 2
            property real baseY: modelData.y * root.height - height / 2
            x: baseX; y: baseY
            width: Math.max(36, modelData.s * root.width)
            height: width * 145 / 180
            z: 2
            serial: (index * 7 + 11) % 43 + 1
            paperColor: root.paperColor
            lineColor: root.inkColor
            showSerial: root.showBirdNumbers
            rotation: modelData.a
            transformOrigin: Item.Center

            SequentialAnimation on x {
                running: root.motionEnabled && root.visible && bird.visible && root.motionSpeed > 0
                loops: Animation.Infinite
                NumberAnimation { to: bird.baseX + root.width * 0.009; duration: (5200 + (index % 8) * 620) / Math.max(0.2, root.motionSpeed); easing.type: Easing.InOutSine }
                NumberAnimation { to: bird.baseX - root.width * 0.009; duration: (5200 + (index % 8) * 620) / Math.max(0.2, root.motionSpeed); easing.type: Easing.InOutSine }
            }
            SequentialAnimation on y {
                running: root.motionEnabled && root.visible && bird.visible && root.motionSpeed > 0
                loops: Animation.Infinite
                NumberAnimation { to: bird.baseY - root.height * 0.012; duration: (4700 + (index % 6) * 540) / Math.max(0.2, root.motionSpeed); easing.type: Easing.InOutSine }
                NumberAnimation { to: bird.baseY + root.height * 0.008; duration: (4700 + (index % 6) * 540) / Math.max(0.2, root.motionSpeed); easing.type: Easing.InOutSine }
            }
        }
    }

    Text {
        x: root.width * 0.18; y: root.height * 0.475
        text: "羽翼向未知处延伸"
        color: "#304765"; opacity: 0.82
        font.family: "Songti SC"; font.pixelSize: Math.max(12, root.width * 0.0145)
        SequentialAnimation on opacity {
            running: root.motionEnabled && root.visible
            PauseAnimation { duration: 200 }
            NumberAnimation { to: 0.82; duration: 1600; easing.type: Easing.OutCubic }
        }
    }
    Text { x: root.width * 0.02; y: root.height * 0.025; text: "SH / FIELD RECORD                  VOL. 04 — ORNITHOLOGY"; color: root.inkColor; opacity: 0.68; font.pixelSize: Math.max(7, root.width * 0.0058); z: 3 }
    Text { x: root.width * 0.68; y: root.height * 0.965; text: "ARCHIVE : 06—17      •      LIVE MOTION STUDY"; color: root.inkColor; opacity: 0.68; font.pixelSize: Math.max(7, root.width * 0.0058); z: 3 }

    // Animation delegates are stopped while this background is hidden.
}
