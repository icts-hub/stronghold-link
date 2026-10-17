import QtQuick

// A reusable, time-based track for an existing item's numeric property.
// It must target an existing item's property; it does not create or reparent UI.
Item {
    id: root
    width: 0
    height: 0
    opacity: 0
    enabled: false
    focus: false

    property var profile: null
    property var target: null
    property string targetProperty: "opacity"
    property real fromValue: 0
    property real toValue: 1
    property int durationMs: 280
    property int delayMs: 0
    property int easingType: Easing.InOutCubic
    property bool active: true

    signal completed()
    signal cancelled()

    function writeValue(value) {
        if (!target || !targetProperty.length)
            return
        target[targetProperty] = value
    }

    function play() {
        if (!target || !targetProperty.length)
            return
        sequence.stop()
        if (!profile || !profile.motionAllowed) {
            writeValue(toValue)
            completed()
            return
        }
        writeValue(fromValue)
        sequence.start()
    }

    function snapToEnd() {
        sequence.stop()
        writeValue(toValue)
        completed()
    }

    function resetToStart() {
        sequence.stop()
        writeValue(fromValue)
    }

    function cancel(restoreStart) {
        sequence.stop()
        if (restoreStart)
            writeValue(fromValue)
        cancelled()
    }

    function applyPolicy() {
        // Reduced motion/disabled motion should leave a deterministic final state.
        // App/window/page inactivity pauses instead of snapping, via `paused` below.
        if (profile && !profile.motionAllowed && sequence.running) {
            sequence.stop()
            writeValue(toValue)
            completed()
        }
    }

    SequentialAnimation {
        id: sequence
        paused: root.profile ? (!root.profile.environmentActive || !root.active) : !root.active
        PauseAnimation {
            duration: root.profile ? root.profile.scaledDuration(root.delayMs) : root.delayMs
        }
        NumberAnimation {
            target: root.target
            property: root.targetProperty
            from: root.fromValue
            to: root.toValue
            duration: root.profile ? root.profile.scaledDuration(root.durationMs) : root.durationMs
            easing.type: root.easingType
        }
        onFinished: root.completed()
    }

    Connections {
        target: root.profile
        ignoreUnknownSignals: true
        function onAnimationsEnabledChanged() { root.applyPolicy() }
        function onReducedMotionChanged() { root.applyPolicy() }
    }
}
