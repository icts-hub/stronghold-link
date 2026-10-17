import QtQuick

// Frame-synchronised clock for custom Canvas/JS animation only.
// Prefer NumberAnimation/Animator for ordinary property changes.
Item {
    id: root
    width: 0
    height: 0
    opacity: 0
    enabled: false
    focus: false

    property var profile: null
    property bool active: true
    property real elapsedSeconds: 0
    property real deltaSeconds: 0
    property real safeDeltaSeconds: 0

    signal tick(real elapsedSeconds, real deltaSeconds, real safeDeltaSeconds)

    FrameAnimation {
        id: frameClock
        running: root.active && root.profile !== null
                 && root.profile.motionAllowed && root.profile.environmentActive
        onTriggered: {
            var dt = Math.max(0, frameTime)
            root.deltaSeconds = dt
            // Used for damped followers only. Do not use this capped value as the
            // master timeline, or motion speed would vary after a hitch.
            root.safeDeltaSeconds = Math.min(dt, 0.05)
            root.elapsedSeconds += dt
            root.tick(root.elapsedSeconds, dt, root.safeDeltaSeconds)
        }
    }

    function resetClock() {
        elapsedSeconds = 0
        deltaSeconds = 0
        safeDeltaSeconds = 0
    }
}
