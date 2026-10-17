import QtQuick

// Opt-in render-cadence probe. This is not a GPU timer and does not measure RSS.
// Keep disabled in normal release builds unless diagnostic mode is requested.
Item {
    id: root
    width: 0
    height: 0
    opacity: 0
    enabled: false
    focus: false

    property bool profilingEnabled: false
    property bool applicationActive: Qt.application.state === Qt.ApplicationActive
    property bool windowActive: true
    property bool pageVisible: true
    readonly property bool environmentActive: applicationActive && windowActive && pageVisible
    property real frameBudgetMs: 16.67
    property int capacity: 120
    property int sampleCount: 0
    property int cursor: 0
    property var samples: []
    property var latestMetrics: ({})

    signal metricsUpdated(var metrics)

    Component.onCompleted: {
        samples = []
        for (var i = 0; i < capacity; ++i)
            samples.push(0)
    }

    function recordFrame(seconds) {
        var ms = seconds * 1000
        if (!isFinite(ms) || ms <= 0 || ms > 2000)
            return
        samples[cursor] = ms
        cursor = (cursor + 1) % capacity
        sampleCount = Math.min(sampleCount + 1, capacity)
    }

    function publishMetrics() {
        if (sampleCount < 2)
            return
        var values = []
        var total = 0
        var maxMs = 0
        var overBudget = 0
        for (var i = 0; i < sampleCount; ++i) {
            var v = samples[i]
            values.push(v)
            total += v
            maxMs = Math.max(maxMs, v)
            if (v > frameBudgetMs)
                overBudget++
        }
        values.sort(function(a, b) { return a - b })
        var average = total / sampleCount
        var median = values[Math.floor((sampleCount - 1) * 0.50)]
        var p95 = values[Math.min(sampleCount - 1, Math.floor((sampleCount - 1) * 0.95))]
        latestMetrics = {
            samples: sampleCount,
            estimatedFps: average > 0 ? 1000 / average : 0,
            averageFrameMs: average,
            medianFrameMs: median,
            p95FrameMs: p95,
            maxFrameMs: maxMs,
            overBudgetFrames: overBudget,
            overBudgetPercent: 100 * overBudget / sampleCount,
            frameBudgetMs: frameBudgetMs
        }
        metricsUpdated(latestMetrics)
    }

    FrameAnimation {
        running: root.profilingEnabled && root.environmentActive
        onTriggered: root.recordFrame(frameTime)
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.profilingEnabled && root.environmentActive
        onTriggered: root.publishMetrics()
    }

    function reset() {
        samples = []
        for (var i = 0; i < capacity; ++i)
            samples.push(0)
        sampleCount = 0
        cursor = 0
        latestMetrics = ({})
    }
}
