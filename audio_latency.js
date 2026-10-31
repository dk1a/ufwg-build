"use strict";
const LATENCY_HINT_SECONDS = 0.1;
(function installAudioLatencyHint() {
    const host = window;
    const found = host.AudioContext || host.webkitAudioContext;
    if (found == null) {
        return;
    }
    const Original = found;
    function Wrapped() {
        const raw = arguments[0];
        const opts = raw != null && typeof raw === "object"
            ? Object.assign({}, raw)
            : {};
        if (opts.latencyHint == null) {
            opts.latencyHint = LATENCY_HINT_SECONDS;
        }
        return new Original(opts);
    }
    Wrapped.prototype = Original.prototype;
    const wrapped = Wrapped;
    host.AudioContext = wrapped;
    if (host.webkitAudioContext != null) {
        host.webkitAudioContext = wrapped;
    }
})();
