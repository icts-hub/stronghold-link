import QtQuick
import QtQuick.Shapes

// Original outline motif used by FlightAtlasBackground.
// Coordinates live in a 180 x 145 design space and scale with this item's width.
Item {
    id: root
    property int serial: 1
    property color paperColor: "#bdcbc7"
    property color lineColor: "#315d9c"
    property bool showSerial: true

    // Internal drawing surface is scaled uniformly to preserve line-art proportions.
    Shape {
        id: drawing
        width: 180
        height: 145
        x: root.width * 96 / 180
        y: root.width * 75 / 180
        scale: root.width / 180
        transformOrigin: Item.TopLeft
        ShapePath {
            strokeColor: root.lineColor
            strokeWidth: 1.45
            fillColor: root.paperColor
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg {
                path: "M-70 7 L-52 0 C-36 -5 -20 -5 -5 0 C8 4 19 4 29 -3 C33 -9 37 -12 42 -11 C45 -10 45 -6 43 -4 L64 -3 L45 2 L43 6 C37 14 27 15 16 11 L1 7 C-11 12 -23 26 -33 43 C-31 24 -24 12 -12 6 C-31 4 -45 14 -61 20 L-80 25 L-65 11 Z"
            }
        }
        ShapePath {
            strokeColor: root.lineColor
            strokeWidth: 1.45
            fillColor: root.paperColor
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg {
                path: "M-8 5 C-20 -5 -30 -21 -36 -39 L-27 -33 L-29 -46 L-18 -38 L-18 -52 L-8 -42 L-5 -56 L3 -41 L9 -45 L13 -30 L21 -32 L24 -17 L31 -19 L32 -4 L17 7 Z M1 4 C11 -8 22 -25 40 -36 L36 -21 L48 -30 L42 -15 L53 -17 L40 -1 L18 10 Z"
            }
        }
        ShapePath {
            strokeColor: root.lineColor
            strokeWidth: 1.05
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg {
                path: "M-52 4 L-33 7 L-14 7 M-27 -30 L-16 -13 M-17 -39 L-4 -18 M-6 -42 L5 -21 M7 -29 L13 -14 M21 -14 L18 -4 M-28 10 L-19 20 M8 12 L22 16 L36 11"
            }
        }
        Text {
            visible: root.showSerial
            x: -11
            y: 31
            width: 20
            horizontalAlignment: Text.AlignHCenter
            text: ("0" + root.serial).slice(-2)
            color: root.lineColor
            font.family: "Georgia"
            font.pixelSize: 10
            opacity: 0.86
        }
    }
}
