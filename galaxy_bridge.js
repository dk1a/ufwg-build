"use strict";
const GALAXY_ORIGIN = "https://galaxy.click";
const MAX_SAVE_BYTES = 256000;
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_IO_TIMEOUT_MS = 8000;
const MAX_PROBE_ATTEMPTS = 2;
const EXPECTED_API_VERSION = 1;
class GalaxyBridgeImpl {
    constructor() {
        this.cachedInfo = null;
        this.pending = new Map();
        this.pendingProbe = null;
        this.listenerAttached = false;
        this.attachListener();
        if (!this.isTopLevel()) {
            this.postToGalaxy({ action: "info" });
        }
    }
    attachListener() {
        if (this.listenerAttached) {
            return;
        }
        this.listenerAttached = true;
        window.addEventListener("message", (event) => {
            this.onMessage(event);
        });
    }
    onMessage(event) {
        if (event.origin !== GALAXY_ORIGIN) {
            return;
        }
        if (event.source != null && event.source !== window.top) {
            return;
        }
        const data = event.data;
        if (data == null || typeof data !== "object" || typeof data.type !== "string") {
            return;
        }
        if (data.type === "info") {
            if (data.galaxy === true && typeof data.api_version === "number") {
                this.cachedInfo = {
                    type: "info",
                    galaxy: true,
                    api_version: data.api_version,
                    theme_preference: typeof data.theme_preference === "string"
                        ? data.theme_preference
                        : "none",
                    logged_in: data.logged_in === true,
                };
                this.finishPendingProbeFromCache();
            }
            return;
        }
        if (data.type === "saved") {
            const slot = typeof data.slot === "number" ? data.slot : 0;
            const key = this.requestKey("save", slot);
            const pending = this.pending.get(key);
            if (pending == null) {
                return;
            }
            window.clearTimeout(pending.timer);
            this.pending.delete(key);
            pending.resolve({
                ok: data.error !== true,
                slot,
                message: typeof data.message === "string" ? data.message : "",
            });
            return;
        }
        if (data.type === "save_content") {
            const slot = typeof data.slot === "number" ? data.slot : 0;
            const key = this.requestKey("load", slot);
            const pending = this.pending.get(key);
            if (pending == null) {
                return;
            }
            window.clearTimeout(pending.timer);
            this.pending.delete(key);
            const message = typeof data.message === "string" ? data.message : "";
            pending.resolve({
                ok: data.error !== true,
                slot,
                empty: data.error === true && message === "empty_slot",
                content: typeof data.content === "string" ? data.content : "",
                label: typeof data.label === "string" ? data.label : "",
                message,
            });
        }
    }
    requestKey(kind, slot) {
        return kind + ":" + String(slot);
    }
    postToGalaxy(payload) {
        try {
            if (window.top == null) {
                return false;
            }
            window.top.postMessage(payload, GALAXY_ORIGIN);
            return true;
        }
        catch (_err) {
            return false;
        }
    }
    isTopLevel() {
        try {
            return window.self === window.top;
        }
        catch (_err) {
            return false;
        }
    }
    hasUsableCache() {
        return (this.cachedInfo != null
            && this.cachedInfo.galaxy
            && this.cachedInfo.api_version === EXPECTED_API_VERSION);
    }
    probeFromCache() {
        const info = this.cachedInfo;
        return {
            embedded: true,
            logged_in: info.logged_in,
            api_version: info.api_version,
            message: "",
        };
    }
    finishPendingProbeFromCache() {
        if (this.pendingProbe == null || !this.hasUsableCache()) {
            return;
        }
        const pending = this.pendingProbe;
        this.pendingProbe = null;
        window.clearTimeout(pending.timer);
        pending.resolve(this.probeFromCache());
    }
    invokeCallback(callback, value) {
        callback(JSON.stringify(value));
    }
    failProbe(callback) {
        this.invokeCallback(callback, {
            embedded: true,
            logged_in: false,
            api_version: 0,
            message: "timeout",
        });
    }
    probe(callback, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
        this.attachListener();
        if (this.isTopLevel()) {
            this.invokeCallback(callback, {
                embedded: false,
                logged_in: false,
                api_version: 0,
                message: "",
            });
            return;
        }
        if (this.hasUsableCache()) {
            this.invokeCallback(callback, this.probeFromCache());
            return;
        }
        this.runProbeAttempt(callback, timeoutMs, 1);
    }
    runProbeAttempt(callback, timeoutMs, attempt) {
        if (this.hasUsableCache()) {
            this.invokeCallback(callback, this.probeFromCache());
            return;
        }
        if (this.pendingProbe != null) {
            window.clearTimeout(this.pendingProbe.timer);
            this.pendingProbe = null;
        }
        const timer = window.setTimeout(() => {
            this.pendingProbe = null;
            if (this.hasUsableCache()) {
                this.invokeCallback(callback, this.probeFromCache());
                return;
            }
            if (attempt < MAX_PROBE_ATTEMPTS) {
                this.runProbeAttempt(callback, timeoutMs, attempt + 1);
                return;
            }
            this.failProbe(callback);
        }, Math.max(timeoutMs, 1));
        this.pendingProbe = {
            resolve: (result) => {
                this.invokeCallback(callback, result);
            },
            timer,
        };
        if (!this.postToGalaxy({ action: "info" })) {
            this.pendingProbe = null;
            window.clearTimeout(timer);
            if (attempt < MAX_PROBE_ATTEMPTS) {
                this.runProbeAttempt(callback, timeoutMs, attempt + 1);
                return;
            }
            this.failProbe(callback);
        }
    }
    save(payload, callback) {
        const slot = typeof payload.slot === "number" ? payload.slot : 0;
        const data = typeof payload.data === "string" ? payload.data : "";
        if (data.length > MAX_SAVE_BYTES) {
            this.invokeCallback(callback, { ok: false, slot, message: "too_big" });
            return;
        }
        const key = this.requestKey("save", slot);
        const existing = this.pending.get(key);
        if (existing != null) {
            window.clearTimeout(existing.timer);
            this.pending.delete(key);
            existing.resolve({ ok: false, slot, message: "superseded" });
        }
        const timer = window.setTimeout(() => {
            this.pending.delete(key);
            this.invokeCallback(callback, { ok: false, slot, message: "server_error" });
        }, DEFAULT_IO_TIMEOUT_MS);
        this.pending.set(key, {
            kind: "save",
            slot,
            resolve: (value) => {
                this.invokeCallback(callback, value);
            },
            timer,
        });
        const message = {
            action: "save",
            slot,
            data,
        };
        if (typeof payload.label === "string" && payload.label !== "") {
            message.label = payload.label;
        }
        if (typeof payload.summary === "string" && payload.summary !== "") {
            message.summary = payload.summary;
        }
        if (!this.postToGalaxy(message)) {
            window.clearTimeout(timer);
            this.pending.delete(key);
            this.invokeCallback(callback, { ok: false, slot, message: "server_error" });
        }
    }
    load(slot, callback) {
        const normalizedSlot = typeof slot === "number" ? slot : 0;
        const key = this.requestKey("load", normalizedSlot);
        if (this.pending.has(key)) {
            this.invokeCallback(callback, {
                ok: false,
                slot: normalizedSlot,
                empty: false,
                content: "",
                label: "",
                message: "busy",
            });
            return;
        }
        const timer = window.setTimeout(() => {
            this.pending.delete(key);
            this.invokeCallback(callback, {
                ok: false,
                slot: normalizedSlot,
                empty: false,
                content: "",
                label: "",
                message: "server_error",
            });
        }, DEFAULT_IO_TIMEOUT_MS);
        this.pending.set(key, {
            kind: "load",
            slot: normalizedSlot,
            resolve: (value) => {
                this.invokeCallback(callback, value);
            },
            timer,
        });
        if (!this.postToGalaxy({ action: "load", slot: normalizedSlot })) {
            window.clearTimeout(timer);
            this.pending.delete(key);
            this.invokeCallback(callback, {
                ok: false,
                slot: normalizedSlot,
                empty: false,
                content: "",
                label: "",
                message: "server_error",
            });
        }
    }
}
;
window.GalaxyBridge =
    new GalaxyBridgeImpl();
