// Time-based helpers for custom-drawn animation only. For ordinary UI properties,
// prefer Qt Quick's native NumberAnimation/Animator types.
function clamp(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(maxValue, value));
}

function lerp(a, b, t) {
    return a + (b - a) * clamp(t, 0, 1);
}

function smootherstep(t) {
    t = clamp(t, 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function cubicInOut(t) {
    t = clamp(t, 0, 1);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function outCubic(t) {
    return 1 - Math.pow(1 - clamp(t, 0, 1), 3);
}

// Exponential damping is frame-rate independent when dt is measured in seconds.
// safeDelta is recommended for follower motion only; use real elapsed time for timelines.
function damp(current, target, lambda, safeDeltaSeconds) {
    var dt = clamp(safeDeltaSeconds, 0, 0.05);
    var alpha = 1 - Math.exp(-Math.max(0, lambda) * dt);
    return current + (target - current) * alpha;
}

// Closed-form critically damped spring step for a scalar value.
// State is { position, velocity }; omega is angular frequency in rad/s.
function criticallyDamped(state, target, omega, safeDeltaSeconds) {
    var dt = clamp(safeDeltaSeconds, 0, 0.05);
    var w = Math.max(0.001, omega);
    var x = state.position - target;
    var v = state.velocity;
    var c = v + w * x;
    var decay = Math.exp(-w * dt);
    return {
        position: target + (x + c * dt) * decay,
        velocity: (v - w * c * dt) * decay
    };
}

var MotionMath = {
    clamp: clamp,
    lerp: lerp,
    smootherstep: smootherstep,
    cubicInOut: cubicInOut,
    outCubic: outCubic,
    damp: damp,
    criticallyDamped: criticallyDamped
};

// Guarded export allows Node tests without affecting the QML JS importer.
if (typeof module !== "undefined" && module.exports)
    module.exports = MotionMath;
