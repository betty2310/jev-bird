import { WORLD, createGame, startGame, flap, step, snapshot, decisionState, decisionPlan } from './engine.js';
import { Renderer } from './renderer.js';
import { AutoPilot } from './autopilot.js';
import { FlightTelemetry, actionMeasurement } from './telemetry.js';

const $ = (id) => document.getElementById(id);
let runId = 1;
let game = createGame(undefined, runId);
let mode = 'manual';
let paused = false;
let sound = false;
let audioContext;
let decisions = 0;
let best = { manual: 0, auto: 0 };
let toastTimeout;
let dialogAttempt = 0;
let lastStatePaint = 0;
let accumulator = 0;
let lastFrameTime = performance.now();
try {
  const stored = JSON.parse(localStorage.getItem('pipeworks-best') || '{}');
  for (const k of ['manual', 'auto']) if (Number.isSafeInteger(stored[k]) && stored[k] >= 0) best[k] = stored[k];
} catch { /* Local records are optional. */ }

const renderer = new Renderer($('game'));
const telemetry = new FlightTelemetry();
const auto = new AutoPilot({
  sessionId: telemetry.sessionId,
  getSimulationTime: () => game.time * 1000,
  onTrace: (event, data) => telemetry.emit(event, { ...data, mode, paused, observedState: snapshot(game) }),
  onActivity: (busy) => $('auto-panel').classList.toggle('thinking', busy),
  onDecision: (decision) => {
    const before = snapshot(game);
    if (mode !== 'auto' || paused || game.phase !== 'playing' || decision.runId !== game.runId) {
      telemetry.emit('action_discarded', actionMeasurement(decision, before, before, 'discarded', 'inactive_run'));
      return;
    }
    decisions++;
    $('decision-count').textContent = decisions;
    $('latency').replaceChildren(document.createTextNode(decision.latencyMs), Object.assign(document.createElement('small'), { textContent: ' ms' }));
    if (decision.stale) {
      telemetry.emit('action_discarded', actionMeasurement(decision, before, before, 'discarded', 'stale_response'));
      $('decision-word').replaceChildren(document.createTextNode('Too late'), decisionDot());
      $('observation-copy').textContent = 'That state has passed. Taking a fresh look.';
      return;
    }
    $('decision-word').replaceChildren(document.createTextNode(decision.action === 'FLAP' ? 'A little lift.' : 'Let it glide.'), decisionDot());
    const description = decisionState(game, 0).atExpectedArrival.observations;
    $('observation-copy').textContent = `${capitalize(description.verticalMotion)} · ${description.relativeToGapCenter}.`;
    for (const [name, option] of [['flap', 'FLAP'], ['wait', 'WAIT']]) {
      const percent = Math.round(decision.probabilities[option] * 100);
      $(`${name}-probability`).style.width = `${percent}%`;
      $(`${name}-percent`).textContent = `${percent}%`;
    }
    if (decision.action === 'FLAP') doFlap('auto');
    telemetry.emit('action_applied', { mode, ...actionMeasurement(decision, before, snapshot(game)) });
  },
  onError: (message) => {
    paused = true;
    telemetry.emit('paused', { mode, reason: 'api_error', state: snapshot(game) });
    auto.disconnect();
    updateOverlay();
    $('decision-word').textContent = 'Connection lost';
    $('observation-copy').textContent = 'Reconnect Auto or switch to You to keep flying.';
    document.querySelector('.auto-connection>span:nth-child(2)').textContent = 'Jev is disconnected';
    $('play-label').textContent = 'Reconnect Auto';
    toast(message);
  },
});

function decisionDot() { return Object.assign(document.createElement('span'), { className: 'decision-dot' }); }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function announce(message) { $('game-announcement').textContent = message; }
function toast(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5500);
}

function tone(kind) {
  if (!sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    void audioContext.resume();
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    const now = audioContext.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(kind === 'flap' ? 530 : kind === 'score' ? 740 : 220, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'flap' ? 780 : kind === 'score' ? 1040 : 80, now + 0.12);
    gain.gain.setValueAtTime(0.045, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(now); oscillator.stop(now + 0.2);
  } catch { /* Sound is decorative; the game works without Web Audio. */ }
}

function updateBest() {
  $('best-score').textContent = String(best[mode]).padStart(2, '0');
  $('record-score').textContent = best[mode];
}

function reset(playing = false, previousMode = mode) {
  if (game.phase === 'playing') telemetry.emit('run_end', { mode: previousMode, reason: 'reset', state: snapshot(game) });
  auto.cancel('reset');
  game = createGame(20260919, ++runId);
  paused = false; accumulator = 0; decisions = 0; renderer.particles = [];
  $('stage-score').textContent = '0';
  $('decision-count').textContent = '0';
  $('decision-word').replaceChildren(document.createTextNode('Ready to fly'), decisionDot());
  $('observation-copy').textContent = 'One little decision at a time.';
  for (const option of ['flap', 'wait']) { $(`${option}-probability`).style.width = '0%'; $(`${option}-percent`).textContent = '—'; }
  if (playing) { startGame(game); telemetry.emit('run_start', { mode, state: snapshot(game) }); }
  updateOverlay();
}

function doFlap(source = 'manual') {
  const before = source === 'manual' ? snapshot(game) : null;
  if (flap(game)) {
    tone('flap');
    if (source === 'manual') telemetry.emit('manual_flap', { mode, before, after: snapshot(game) });
  }
}

function play() {
  if ($('key-dialog').open) return;
  if (mode === 'auto' && !auto.connected) return openKeyDialog();
  if (game.phase === 'over') reset();
  if (paused) { paused = false; accumulator = 0; telemetry.emit('resumed', { mode, state: snapshot(game) }); }
  else if (game.phase === 'ready') { startGame(game); tone('flap'); telemetry.emit('run_start', { mode, state: snapshot(game) }); }
  updateOverlay();
  $('game').focus({ preventScroll: true });
}

function manualInput() {
  if ($('key-dialog').open) return;
  if (game.phase !== 'playing' || paused) return play();
  if (mode === 'manual') doFlap();
}

function pause() {
  if (game.phase !== 'playing') return;
  if (paused && mode === 'auto' && !auto.connected) return openKeyDialog();
  paused = !paused;
  accumulator = 0;
  auto.cancel('pause_changed');
  telemetry.emit(paused ? 'paused' : 'resumed', { mode, state: snapshot(game) });
  updateOverlay();
  announce(paused ? 'Flight paused.' : 'Flight resumed.');
}

function setMode(next) {
  if (next === mode) return;
  const previous = mode;
  mode = next;
  auto.cancel('mode_changed');
  reset(false, previous);
  telemetry.emit('mode_changed', { from: previous, mode, state: snapshot(game) });
  $('manual-mode').classList.toggle('selected', mode === 'manual');
  $('auto-mode').classList.toggle('selected', mode === 'auto');
  $('manual-mode').setAttribute('aria-pressed', mode === 'manual');
  $('auto-mode').setAttribute('aria-pressed', mode === 'auto');
  $('manual-panel').hidden = mode !== 'manual';
  $('auto-panel').hidden = mode !== 'auto';
  $('stage-mode').hidden = mode !== 'auto';
  $('pilot-label').textContent = mode === 'manual' ? 'YOU’RE THE PILOT' : 'JEV IS THE PILOT';
  document.querySelector('.pilot-status').classList.toggle('auto', mode === 'auto');
  updateBest();
}

function updateOverlay() {
  const over = game.phase === 'over';
  const ready = game.phase === 'ready';
  $('game-overlay').hidden = !(over || ready || paused);
  $('game-stage').classList.toggle('over', over);
  $('game-stage').classList.toggle('paused', paused);
  $('pause-button').disabled = game.phase !== 'playing';
  $('pause-button').setAttribute('aria-label', paused ? 'Resume game' : 'Pause game');
  $('pause-button').title = paused ? 'Resume (P)' : 'Pause (P)';
  $('final-score').hidden = !over;
  if (over) {
    $('overlay-eyebrow').textContent = 'EVERY FLIGHT IS A LITTLE ADVENTURE';
    $('overlay-title').textContent = game.score > 0 ? 'A lovely little flight.' : 'Wings up. Try again.';
    $('overlay-copy').textContent = game.death === 'water' ? 'A splash landing. It happens to the best of us.' : game.death === 'ceiling' ? 'A little too close to the sun.' : 'That pipe came out of nowhere. Almost.';
    $('final-value').textContent = game.score;
    $('play-label').textContent = 'One more flight';
    $('start-hint').textContent = 'or press space to try again';
  } else if (paused) {
    $('overlay-eyebrow').textContent = 'TAKE A BREATHER';
    $('overlay-title').textContent = 'The sky can wait.';
    $('overlay-copy').textContent = 'Your little bird will be right here.';
    $('play-label').textContent = mode === 'auto' && !auto.connected ? 'Reconnect Auto' : 'Keep flying';
    $('start-hint').textContent = 'or press P to resume';
  } else {
    $('overlay-eyebrow').textContent = mode === 'auto' ? 'A LITTLE HELP FROM JEV' : 'A LITTLE FLIGHT OF FANCY';
    $('overlay-title').textContent = mode === 'auto' ? 'Meet your wingmate.' : 'Hello, little bird.';
    $('overlay-copy').replaceChildren(document.createTextNode(mode === 'auto' ? 'You bring the curiosity.' : 'The sky is yours.'), document.createElement('br'), document.createTextNode(mode === 'auto' ? 'Jev brings the little decisions.' : 'Let’s see how far you can go.'));
    $('play-label').textContent = mode === 'auto' ? 'Let Jev fly' : 'Let’s fly';
    $('start-hint').replaceChildren(document.createTextNode('or press '), Object.assign(document.createElement('kbd'), { textContent: 'space' }), document.createTextNode(' to start'));
  }
}

function openKeyDialog() {
  if (mode === 'auto' && auto.connected) return;
  if (game.phase === 'playing' && !paused) { paused = true; auto.cancel(); updateOverlay(); }
  $('key-error').hidden = true;
  $('key-dialog').showModal();
  $('api-key').focus();
}

function cancelKeyDialog() {
  dialogAttempt++;
  if (!auto.connected) auto.cancel();
  $('api-key').value = '';
  $('connect-button').disabled = false;
  $('connect-button').querySelector('span').textContent = 'Connect Auto';
  $('key-dialog').close();
}

$('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = $('api-key').value.trim();
  if (key.length < 8) return;
  const attempt = ++dialogAttempt;
  $('key-error').hidden = true;
  $('connect-button').disabled = true;
  $('connect-button').querySelector('span').textContent = 'Meeting Jev…';
  try {
    await auto.connect(key, decisionState(createGame()));
    if (attempt !== dialogAttempt) return;
    $('api-key').value = '';
    $('key-dialog').close();
    if (mode === 'auto') reset(); else setMode('auto');
    document.querySelector('.auto-connection>span:nth-child(2)').textContent = 'Jev is connected';
    telemetry.emit('auto_connected', { mode, state: snapshot(game) });
    toast('Your co-pilot is ready. Let’s see how far Jev can fly.');
    $('play-button').focus({ preventScroll: true });
  } catch (error) {
    if (attempt !== dialogAttempt) return;
    $('key-error').textContent = error.message;
    $('key-error').hidden = false;
  } finally {
    if (attempt === dialogAttempt) {
      $('connect-button').disabled = false;
      $('connect-button').querySelector('span').textContent = 'Connect Auto';
    }
  }
});

$('close-dialog').addEventListener('click', cancelKeyDialog);
$('key-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelKeyDialog(); });
$('key-dialog').addEventListener('click', event => { if (event.target === $('key-dialog')) { const r = $('key-dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) cancelKeyDialog(); } });
$('manual-mode').addEventListener('click', () => { if (mode !== 'manual') { auto.disconnect(); setMode('manual'); } });
$('auto-mode').addEventListener('click', () => { if (!auto.connected) openKeyDialog(); else setMode('auto'); });
$('try-auto').addEventListener('click', openKeyDialog);
$('disconnect-button').addEventListener('click', () => { telemetry.emit('auto_disconnected', { mode, state: snapshot(game) }); auto.disconnect(); setMode('manual'); toast('Auto disconnected. You have the controls.'); });
$('play-button').addEventListener('click', play);
$('game').addEventListener('pointerdown', event => { if (event.button > 0) return; event.preventDefault(); $('game').focus({ preventScroll: true }); manualInput(); });
$('pause-button').addEventListener('click', pause);
$('restart-button').addEventListener('click', () => { reset(); $('play-button').focus({ preventScroll: true }); });
$('sound-button').addEventListener('click', () => {
  sound = !sound;
  $('sound-icon').setAttribute('href', sound ? '#i-sound' : '#i-mute');
  $('sound-button').setAttribute('aria-label', sound ? 'Mute sound' : 'Enable sound');
  $('sound-button').setAttribute('aria-pressed', sound);
  $('sound-button').title = sound ? 'Mute sound' : 'Enable sound';
  if (sound) tone('score');
});
$('state-toggle').addEventListener('click', () => {
  $('state-panel').hidden = !$('state-panel').hidden;
  $('state-toggle').setAttribute('aria-expanded', !$('state-panel').hidden);
  $('state-toggle').querySelector('span').textContent = $('state-panel').hidden ? '+' : '−';
  lastStatePaint = -Infinity;
});

window.addEventListener('keydown', event => {
  if ($('key-dialog').open || event.target.closest('input,textarea,select') || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  if (event.code === 'Space') {
    // Keep standard keyboard activation for other controls.
    if (event.target.closest('button,a')) return;
    event.preventDefault(); manualInput();
  } else if (event.code === 'KeyP' || event.code === 'Escape') { event.preventDefault(); pause(); }
  else if (event.code === 'KeyR') { event.preventDefault(); reset(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.phase === 'playing' && !paused) { paused = true; auto.cancel('tab_hidden'); telemetry.emit('paused', { mode, reason: 'tab_hidden', state: snapshot(game) }); updateOverlay(); }
  if (document.hidden) void telemetry.flush();
  lastFrameTime = performance.now(); accumulator = 0;
});
window.addEventListener('pagehide', () => { telemetry.emit('page_exit', { mode, state: snapshot(game) }); auto.disconnect(); void telemetry.flush(); });

function frame(now) {
  const elapsed = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  if (game.phase === 'playing' && !paused) {
    accumulator += elapsed;
    const oldScore = game.score;
    while (accumulator >= WORLD.tick && game.phase === 'playing') { step(game); accumulator -= WORLD.tick; }
    if (game.score !== oldScore) { $('stage-score').textContent = game.score; tone('score'); telemetry.emit('score', { mode, state: snapshot(game) }); }
    if (game.phase === 'over') {
      telemetry.emit('run_end', { mode, reason: game.death, state: snapshot(game) });
      auto.cancel('game_over'); renderer.burst(game); tone('crash');
      void telemetry.flush();
      if (game.score > best[mode]) {
        best[mode] = game.score;
        try { localStorage.setItem('pipeworks-best', JSON.stringify(best)); } catch { /* Optional. */ }
        updateBest();
      }
      updateOverlay(); announce(`Flight finished. ${game.score} pipes passed.`);
    } else if (mode === 'auto') auto.tick(() => decisionPlan(game, auto.delayMs), now);
  }
  renderer.draw(game, now, elapsed);
  if (!$('state-panel').hidden && now - lastStatePaint > 180) {
    const state = mode === 'auto' ? decisionPlan(game, auto.delayMs) : snapshot(game);
    $('state-label').textContent = mode === 'auto' ? 'STATE PREPARED FOR JEV' : 'LIVE GAME STATE';
    $('state-output').textContent = JSON.stringify(state, (_, v) => typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v, 2);
    lastStatePaint = now;
  }
  requestAnimationFrame(frame);
}

// Read-only inspection for the experiment. Never exposes the API key or controller.
Object.defineProperty(window, 'pipeworks', { value: Object.freeze({
  getState: () => ({ ...snapshot(game), mode, paused }),
  getDecisionState: () => decisionPlan(game, auto.delayMs),
}), writable: false });
updateBest(); updateOverlay(); requestAnimationFrame(frame);
