import QtQuick

// Decorative-only QML layer. Mount it inside an existing background host, behind controls.
// It deliberately defines no navigation, buttons, MouseArea, focus, or business state.
Item {
    id: root
    objectName: "SacredMotifLayer"

    property url birdSceneSource: Qt.resolvedUrl("qrc:/qml/assets/reference/bird-scene-transparent-overlay.png")
    property url haloSource: Qt.resolvedUrl("qrc:/qml/assets/halos/halo-system.svg")
    property real sceneOpacity: 0.22
    property real haloOpacity: 0.10
    property bool motionEnabled: true
    property bool reducedMotion: false
    property bool pageVisible: true
    property bool showHalo: false

    enabled: false
    focus: false
    clip: true

    // Primary flock line art is a transparent pixel extraction of the supplied reference,
    // so the bird silhouettes are not replaced by generic icons.
    // Halo is optional and defaults off: activate only where the existing layout has clear negative space.
    Item {
        id: flockMotion
        anchors.fill: parent
        Image {
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
        running: root.motionEnabled && !root.reducedMotion && root.pageVisible && root.visible
        loops: Animation.Infinite
        NumberAnimation { target: flockShift; property: "x"; from: -3; to: 3; duration: 22000; easing.type: Easing.InOutSine }
        NumberAnimation { target: flockShift; property: "x"; from: 3; to: -3; duration: 22000; easing.type: Easing.InOutSine }
    }

    NumberAnimation {
        target: haloRotation
        property: "angle"
        from: 0
        to: 360
        duration: 110000
        loops: Animation.Infinite
        running: root.showHalo && root.motionEnabled && !root.reducedMotion && root.pageVisible && root.visible
        easing.type: Easing.Linear
    }
}
