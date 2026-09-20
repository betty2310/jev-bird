export const WORLD = Object.freeze({
  width: 960, height: 540, ceilingY: 0, floorY: 490,
  gravity: 600, flapVelocity: -285, maxFallSpeed: 480,
  birdX: 242, radius: 15, pipeWidth: 78, pipeGap: 190,
  pipeSpacing: 300, pipeSpeed: 140, tick: 1 / 120,
});

export function createGame(seed = 20260919, runId = 1) {
  const game = {
    runId, seed: seed >>> 0, randomState: seed >>> 0, phase: 'ready',
    frame: 0, time: 0, score: 0, distance: 0, death: null,
    bird: { x: WORLD.birdX, y: 240, vy: 0, radius: WORLD.radius, lastFlap: -1 },
    pipes: [], nextPipeId: 1,
  };
  for (let i = 0; i < 4; i++) addPipe(game, 820 + i * WORLD.pipeSpacing);
  return game;
}

function random(game) {
  game.randomState = (Math.imul(game.randomState, 1664525) + 1013904223) >>> 0;
  return game.randomState / 4294967296;
}

function addPipe(game, x) {
  const previous = game.pipes.at(-1);
  const center = previous ? Math.max(155, Math.min(335, previous.center + (random(game) - 0.5) * 130)) : 250;
  game.pipes.push({ id: game.nextPipeId++, x, width: WORLD.pipeWidth, center,
    gapTop: center - WORLD.pipeGap / 2, gapBottom: center + WORLD.pipeGap / 2, passed: false });
}

export function startGame(game) {
  if (game.phase !== 'ready') return false;
  game.phase = 'playing';
  flap(game);
  return true;
}

export function flap(game) {
  if (game.phase !== 'playing') return false;
  game.bird.vy = WORLD.flapVelocity;
  game.bird.lastFlap = game.time;
  return true;
}

export function circleRect(bird, left, top, width, height) {
  const dx = bird.x - Math.max(left, Math.min(bird.x, left + width));
  const dy = bird.y - Math.max(top, Math.min(bird.y, top + height));
  return dx * dx + dy * dy <= bird.radius * bird.radius;
}

export function collision(game) {
  const b = game.bird;
  if (b.y - b.radius <= WORLD.ceilingY) return 'ceiling';
  if (b.y + b.radius >= WORLD.floorY) return 'water';
  for (const p of game.pipes) {
    if (circleRect(b, p.x, 0, p.width, p.gapTop) ||
        circleRect(b, p.x, p.gapBottom, p.width, WORLD.floorY - p.gapBottom)) return 'pipe';
  }
  return null;
}

function advanceBird(bird, dt) {
  const acceleratingFor = Math.max(0, Math.min(dt, (WORLD.maxFallSpeed - bird.vy) / WORLD.gravity));
  bird.y += bird.vy * acceleratingFor + 0.5 * WORLD.gravity * acceleratingFor ** 2 + WORLD.maxFallSpeed * (dt - acceleratingFor);
  bird.vy = Math.min(WORLD.maxFallSpeed, bird.vy + WORLD.gravity * dt);
}

export function step(game, dt = WORLD.tick) {
  if (game.phase !== 'playing') return;
  // Substeps make large caller deltas safe; app normally supplies a fixed 120 Hz tick.
  let remaining = Math.min(Math.max(dt, 0), 0.25);
  while (remaining > 1e-9 && game.phase === 'playing') {
    const t = Math.min(WORLD.tick, remaining);
    game.time += t;
    game.frame++;
    advanceBird(game.bird, t);
    game.distance += WORLD.pipeSpeed * t;
    for (const pipe of game.pipes) pipe.x -= WORLD.pipeSpeed * t;
    game.death = collision(game);
    if (game.death) {
      game.phase = 'over';
      break;
    }
    for (const p of game.pipes) {
      if (!p.passed && p.x + p.width < game.bird.x - game.bird.radius) {
        p.passed = true;
        game.score++;
      }
    }
    game.pipes = game.pipes.filter(p => p.x + p.width > -12);
    if (game.pipes.at(-1).x < WORLD.width + WORLD.pipeSpacing) {
      addPipe(game, game.pipes.at(-1).x + WORLD.pipeSpacing);
    }
    remaining -= t;
  }
}

export function snapshot(game) {
  return structuredClone({
    runId: game.runId, seed: game.seed, frameId: game.frame, simulationTimeMs: Math.round(game.time * 1000),
    phase: game.phase, score: game.score, bird: game.bird, world: WORLD, pipes: game.pipes,
  });
}

export function describePosition(bird, pipe, timeUntilPipe) {
  const motion = bird.vy < -40 ? 'rising' : bird.vy > 40 ? 'falling' : 'near the top of the arc, almost level';
  const relative = bird.y < pipe.center - 24 ? 'above the gap center' : bird.y > pipe.center + 24 ? 'below the gap center' : 'near the gap center';
  const top = bird.y - bird.radius - pipe.gapTop;
  const bottom = pipe.gapBottom - bird.y - bird.radius;
  return {
    verticalMotion: `${motion}${Math.abs(bird.vy) > 180 ? ' quickly' : ''}`,
    relativeToGapCenter: relative,
    upperEdge: top < 0 ? 'bird extends above the opening' : top < 35 ? 'close above the bird' : 'clear of the bird',
    lowerEdge: bottom < 0 ? 'bird extends below the opening' : bottom < 35 ? 'close below the bird' : 'clear of the bird',
    floor: WORLD.floorY - bird.y - bird.radius < 85 ? 'close below the bird' : 'far below',
    ceiling: bird.y - bird.radius < 85 ? 'close above the bird' : 'far above',
    pipeApproach: timeUntilPipe <= 0 ? 'crossing this pipe now' : timeUntilPipe < 0.6 ? 'reaching this pipe very soon' : 'time to line up with the opening',
  };
}

export function decisionState(game, estimatedDelayMs = 330, nextDecisionMs = estimatedDelayMs) {
  const delay = Math.max(0, Math.min(0.9, estimatedDelayMs / 1000));
  const relevant = game.pipes.filter(p => p.x + p.width >= game.bird.x - game.bird.radius).slice(0, 2);
  const current = snapshot(game);
  current.pipes = relevant.map(p => ({ ...p, vx: -WORLD.pipeSpeed }));
  // No actions are applied locally: these are observations of the anticipated state
  // when this request returns. Jev still chooses every subsequent flap.
  const projectedBird = { ...game.bird };
  advanceBird(projectedBird, delay);
  const projectedPipes = relevant.map(p => ({ ...p, x: p.x - WORLD.pipeSpeed * delay }));
  const target = projectedPipes.find(p => p.x + p.width >= game.bird.x - game.bird.radius) || projectedPipes.at(-1);
  const timeUntil = Math.max(0, (target.x - projectedBird.x - projectedBird.radius) / WORLD.pipeSpeed);
  const horizon = Math.max(0.4, Math.min(0.75, nextDecisionMs / 1000 * 1.35));
  const previews = {};
  for (const action of ['FLAP', 'WAIT']) {
    const b = { ...projectedBird, vy: action === 'FLAP' ? WORLD.flapVelocity : projectedBird.vy };
    let hit = null;
    let firstHitMs = null;
    for (let t = 0; t <= horizon; t += WORLD.tick) {
      if (b.y - b.radius <= WORLD.ceilingY) hit ||= 'ceiling';
      if (b.y + b.radius >= WORLD.floorY) hit ||= 'water';
      for (const p of projectedPipes) {
        const x = p.x - WORLD.pipeSpeed * t;
        if (circleRect(b, x, 0, p.width, p.gapTop)) hit ||= 'upper pipe';
        if (circleRect(b, x, p.gapBottom, p.width, WORLD.floorY - p.gapBottom)) hit ||= 'lower pipe';
      }
      if (hit && firstHitMs === null) firstHitMs = Math.round(t * 1000);
      advanceBird(b, WORLD.tick);
    }
    previews[action] = {
      clearUntilNextDecision: hit === null,
      collision: hit,
      firstCollisionMs: firstHitMs,
      endPosition: describePosition(b, target, Math.max(0, timeUntil - horizon)).relativeToGapCenter,
      endVerticalMotion: b.vy < -40 ? 'rising' : b.vy > 40 ? 'falling' : 'almost level',
    };
  }
  return {
    ...current,
    coordinateSystem: 'Pixels. Positive y and vy point DOWN. Negative vy is rising. A flap SETS vy to -285, it does not add an impulse.',
    decisionTiming: { expectedResponseDelayMs: Math.round(delay * 1000), expectedNextDecisionMs: Math.round(nextDecisionMs) },
    atExpectedArrival: {
      bird: projectedBird, nextPipe: target,
      observations: describePosition(projectedBird, target, timeUntil),
    },
    trajectoryPreviews: {
      source: 'Game-engine calculations, assuming no further flap for this short horizon. These predict physics; Jev selects the action.',
      horizonMs: Math.round(horizon * 1000), actions: previews,
    },
  };
}

export function decisionPlan(game, estimatedDelayMs = 450) {
  const state = decisionState(game, estimatedDelayMs);
  state.decisionTiming.strategy = 'arrival-cases-v1';
  state.arrivalCases = [200, 350, 500, 650, 800].map(delayMs => {
    const projected = decisionState(game, delayMs, estimatedDelayMs);
    return { id: `at_${delayMs}`, delayMs, atExpectedArrival: projected.atExpectedArrival,
      trajectoryPreviews: projected.trajectoryPreviews };
  });
  return state;
}
