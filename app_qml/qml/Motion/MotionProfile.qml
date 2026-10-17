import QtQuick

// Shared animation policy. Instantiate once in the existing root and pass it to
// animation helpers; do not change layout or business state to adopt this object.
QtObject {
    id: root

    // Bind animationsEnabled to the project's existing motion setting if one exists.
    property bool animationsEnabled: true
    property bool reducedMotion: false

    // Bind these to the existing application/window/page lifecycle.
    // applicationActive follows Qt's application state; the host should also
    // reflect Window.visibility and page visibility into the remaining values.
    property bool applicationActive: Qt.application.state === Qt.ApplicationActive
    property bool windowActive: true
    property bool pageVisible: true

    // > 1 means quicker playback; < 1 means slower playback.
    property real speedMultiplier: 1.0

    readonly property bool motionAllowed: animationsEnabled && !reducedMotion
    readonly property bool environmentActive: applicationActive && windowActive && pageVisible

    // Shared durations in milliseconds. These are starting points, not a mandate
    // to animate every property.
    readonly property int durationMicro: 110
    readonly property int durationShort: 180
    readonly property int durationStandard: 280
    readonly property int durationLong: 440
    readonly property int durationHero: 680

    readonly property int easingEnter: Easing.OutCubic
    readonly property int easingExit: Easing.InCubic
    readonly property int easingStandard: Easing.InOutCubic
    readonly property int easingQuietLoop: Easing.InOutSine
    readonly property int easingEmphasis: Easing.OutQuad

    function scaledDuration(baseMs) {
        if (!motionAllowed || baseMs <= 0)
            return 0
        var speed = Math.max(0.5, Math.min(2.0, speedMultiplier))
        return Math.max(1, Math.round(baseMs / speed))
    }

    function isAnimationAllowed(itemVisible) {
        return motionAllowed && environmentActive && itemVisible
    }
}
