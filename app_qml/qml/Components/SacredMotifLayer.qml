import QtQuick

// Decorative-only QML layer. Mount it inside an existing background host, behind controls.
// It deliberately defines no navigation, buttons, MouseArea, focus, or business state.
Item {
    id: root
    objectName: "SacredMotifLayer"

    property url birdSceneSource: ""   // 参考图派生叠层不随发布包分发；此处置空，只用自绘 SVG
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

    // 纸面淡染：套件的语境是灰青纸面 + 钴蓝细线；直接铺在近白页面上会单薄，
    // 所以先压一层极淡的灰青（0.22），再叠线条。纯装饰，enabled:false 继承自父项。
    Rectangle {
        anchors.fill: parent
        color: "#c6d0cd"
        opacity: 0.22
    }


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
