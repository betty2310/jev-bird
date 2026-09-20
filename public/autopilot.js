export class AutoPilot {
  constructor({ request = (...args) => globalThis.fetch(...args), onDecision, onError, onActivity,
    onTrace = () => {}, sessionId = crypto.randomUUID(), getSimulationTime } = {}) {
    this.request = request;
    this.onDecision = onDecision || (() => {});
    this.onError = onError || (() => {});
    this.onActivity = onActivity || (() => {});
    this.onTrace = onTrace;
    this.sessionId = sessionId;
    this.getSimulationTime = getSimulationTime;
    this.inFlight = null;
    this.key = '';
    this.epoch = 0;
    this.controller = null;
    this.delayMs = 330;
    this.lastRequestAt = -Infinity;
    this.lastDecision = null;
  }

  get connected() { return Boolean(this.key); }
  get busy() { return this.controller !== null; }

  trace(event, data) { try { this.onTrace(event, data); } catch { /* Logging must not change decisions. */ } }

  cancel(reason = 'cancelled') {
    if (this.inFlight) this.trace('decision_cancelled', { ...this.inFlight, reason });
    this.epoch++;
    this.controller?.abort();
    this.controller = null;
    this.inFlight = null;
    this.onActivity(false);
  }

  disconnect() {
    this.cancel();
    this.key = '';
    this.lastDecision = null;
  }

  async connect(key, state) {
    this.disconnect();
    const result = await this.send(key.trim(), state, true);
    if (!result) throw new Error('Connection cancelled.');
    this.key = key.trim();
    // A cold request should not set the expected warm delay for the game.
    this.delayMs = Math.min(450, Math.max(250, result.latencyMs));
    return result;
  }

  async send(key, state, validating = false) {
    if (this.busy) return null;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    this.onActivity(true);
    const started = performance.now();
    const requestId = `${this.sessionId}-${crypto.randomUUID()}`;
    const client = { sessionId: this.sessionId, requestId, purpose: validating ? 'validation' : 'flight',
      sentAt: new Date().toISOString(), clockMs: started };
    this.inFlight = { requestId, runId: state.runId, frameId: state.frameId, purpose: client.purpose };
    this.trace('decision_requested', { ...this.inFlight, simulationTimeMs: state.simulationTimeMs,
      predictedDelayMs: state.decisionTiming?.expectedResponseDelayMs });
    this.lastRequestAt = started;
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await this.request('/api/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ state, client }), signal: controller.signal,
      });
      const data = await response.json();
      if (epoch !== this.epoch) {
        this.trace('decision_discarded', { requestId, reason: 'cancelled_epoch' });
        return null;
      }
      if (!response.ok) throw new Error(data.error || 'TypeSafe could not complete this decision.');
      if (data.runId !== state.runId || data.frameId !== state.frameId) {
        throw new Error('The decision response was invalid. Please reconnect.');
      }
      const latencyMs = Math.round(performance.now() - started);
      let selected = data;
      let forecast = state;
      // Match the state where the action will actually be applied. Simulation time
      // can lag wall time after a dropped render frame; the two are not interchangeable.
      const simulationAgeMs = this.getSimulationTime ? this.getSimulationTime() - state.simulationTimeMs : latencyMs;
      if (state.arrivalCases) {
        if (!Array.isArray(data.arrivalChoices) || data.arrivalChoices.length !== state.arrivalCases.length ||
            !state.arrivalCases.every(c => data.arrivalChoices.filter(a => a.id === c.id && ['FLAP', 'WAIT'].includes(a.action)).length === 1)) {
          throw new Error('The arrival-time decisions were incomplete. Please reconnect.');
        }
        forecast = state.arrivalCases.reduce((best, c) => Math.abs(c.delayMs - simulationAgeMs) < Math.abs(best.delayMs - simulationAgeMs) ? c : best);
        selected = data.arrivalChoices.find(c => c.id === forecast.id);
      }
      if (!['FLAP', 'WAIT'].includes(selected.action)) throw new Error('The decision response was invalid. Please reconnect.');
      const result = { ...data, ...selected, requestId, latencyMs, receivedAt: performance.now(), stale: latencyMs > 900,
        snapshotSimulationTimeMs: state.simulationTimeMs,
        selectedCaseId: forecast.id || null, selectionAgeMs: simulationAgeMs,
        expectedDelayMs: forecast.delayMs ?? state.decisionTiming?.expectedResponseDelayMs,
        expectedArrival: forecast.atExpectedArrival };
      this.trace('decision_received', { requestId, purpose: client.purpose, runId: state.runId, frameId: state.frameId,
        action: result.action, probabilities: result.probabilities, latencyMs, selectedCaseId: result.selectedCaseId, simulationAgeMs,
        upstreamMs: data.serviceMs, stale: result.stale, predictedDelayMs: result.expectedDelayMs });
      if (!validating) {
        this.delayMs = this.delayMs * 0.75 + Math.min(650, latencyMs) * 0.25;
        this.lastDecision = result;
        this.onDecision(result);
      }
      return result;
    } catch (error) {
      if (epoch !== this.epoch) return null;
      const message = error.name === 'AbortError' ? 'The connection timed out. Your flight is paused.' : error.message;
      this.trace('decision_failed', { requestId, runId: state.runId, frameId: state.frameId,
        code: error.name === 'AbortError' ? 'CLIENT_TIMEOUT' : 'REQUEST_FAILED', latencyMs: Math.round(performance.now() - started) });
      if (validating) throw new Error(message);
      this.onError(message);
      return null;
    } finally {
      clearTimeout(timeout);
      if (epoch === this.epoch) {
        this.controller = null;
        this.inFlight = null;
        this.onActivity(false);
      }
    }
  }

  tick(state, now = performance.now()) {
    if (!this.connected || this.busy || now - this.lastRequestAt < 180) return;
    void this.send(this.key, typeof state === 'function' ? state() : state);
  }
}
