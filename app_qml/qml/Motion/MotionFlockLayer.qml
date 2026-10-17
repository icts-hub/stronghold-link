import QtQuick

// Decorative background only. Place behind existing controls; never replace the
// page root or wrap/reparent interactive content. `enabled: false` prevents hits.
Item {
    id: root
    objectName: "MotionFlockLayer"
    anchors.fill: parent
    enabled: false
    focus: false
    clip: true

    property var profile: null
    property url birdSceneSource: Qt.resolvedUrl("../assets/motifs/bird-pose-library.svg")
    property url haloSource: Qt.resolvedUrl("../assets/motifs/halo-system.svg")
    property bool active: true
    property bool showHalo: false
    property real sceneOpacity: 0.15
    property real haloOpacity: 0.08
    property real driftPixels: 2.5

    Item {
        id: flockViewport
        anchors.fill: parent
        Image {
            id: birds
            anchors.fill: parent
            source: root.birdSceneSource
            fillMode: Image.PreserveAspectFit
            asynchronous: true
            cache: true
            smooth: true
            mipmap: true
            opacity: root.sceneOpacity
            transform: Translate { id: flockShift; x: 0; y: 0 }
        }
    }

    Image {
        id: halo
        visible: root.showHalo
        anchors.centerIn: parent
        width: Math.min(root.width, root.height) * 0.72
        height: width
        source: root.haloSource
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        cache: true
        smooth: true
        opacity: root.haloOpacity
        transform: Rotation {
            id: haloRotation
            origin.x: halo.width / 2
            origin.y: halo.height / 2
            angle: 0
        }
    }

    SequentialAnimation {
        id: flockDrift
        running: root.profile !== null && root.profile.motionAllowed
        paused: !root.active || !root.visible || (root.profile !== null && !root.profile.environmentActive)
        loops: Animation.Infinite
        NumberAnimation {
            target: flockShift
            property: "x"
            from: -root.driftPixels
            to: root.driftPixels
            duration: root.profile ? root.profile.scaledDuration(42000) : 42000
            easing.type: Easing.InOutSine
        }
        NumberAnimation {
            target: flockShift
            property: "x"
            from: root.driftPixels
            to: -root.driftPixels
            duration: root.profile ? root.profile.scaledDuration(42000) : 42000
            easing.type: Easing.InOutSine
        }
    }

    NumberAnimation {
        target: haloRotation
        property: "angle"
        from: 0
        to: 360
        duration: root.profile ? root.profile.scaledDuration(110000) : 110000
        loops: Animation.Infinite
        running: root.showHalo && root.profile !== null && root.profile.motionAllowed
        paused: !root.active || !root.visible || (root.profile !== null && !root.profile.environmentActive)
        easing.type: Easing.Linear
    }

    Connections {
        target: root.profile
        ignoreUnknownSignals: true
        function onAnimationsEnabledChanged() { if (root.profile && !root.profile.motionAllowed) { flockShift.x = 0; haloRotation.angle = 0 } }
        function onReducedMotionChanged() { if (root.profile && !root.profile.motionAllowed) { flockShift.x = 0; haloRotation.angle = 0 } }
    }
}
