import QtQuick

// A single screenshot-traced bird SVG. The silhouette is intentionally loaded as
// an asset rather than reconstructed with approximate QML geometry.
Item {
    id: root
    property int serial: 1
    property url source: Qt.resolvedUrl("../assets/birds/bird-01.svg")
    property bool showSerial: true
    property bool motionEnabled: true

    Image {
        anchors.fill: parent
        source: root.source
        fillMode: Image.PreserveAspectFit
        smooth: true
        asynchronous: true
        cache: true
    }
    Text {
        visible: root.showSerial
        x: root.width * 0.41; y: root.height * 0.62
        width: root.width * 0.2; height: root.height * 0.13
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        text: ("0" + root.serial).slice(-2)
        color: "#315d9c"; opacity: 0.82
        font.family: "Georgia"; font.pixelSize: Math.max(5, root.width * 0.055)
    }
}
