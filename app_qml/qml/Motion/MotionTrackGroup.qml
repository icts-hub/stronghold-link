import QtQuick

// Coordinates a small known set of MotionPropertyTrack instances. A track's own
// delayMs provides intentional staggering; no independent per-element timers needed.
QtObject {
    id: root
    property var tracks: []

    function play() {
        for (var i = 0; i < tracks.length; ++i) {
            var track = tracks[i]
            if (track && typeof track.play === "function")
                track.play()
        }
    }

    function snapToEnd() {
        for (var i = 0; i < tracks.length; ++i) {
            var track = tracks[i]
            if (track && typeof track.snapToEnd === "function")
                track.snapToEnd()
        }
    }

    function cancel(restoreStart) {
        for (var i = 0; i < tracks.length; ++i) {
            var track = tracks[i]
            if (track && typeof track.cancel === "function")
                track.cancel(restoreStart)
        }
    }
}
