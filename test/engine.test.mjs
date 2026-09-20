import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD, createGame, startGame, flap, step, collision, snapshot, decisionState, decisionPlan } from '../public/engine.js';

test('a seed produces repeatable courses and snapshots are detached', () => {
  const a = createGame(42), b = createGame(42);
  assert.deepEqual(a.pipes, b.pipes);
  assert.notDeepEqual(a.pipes, createGame(43).pipes);
  snapshot(a).bird.y = -100;
  assert.equal(a.bird.y, 240);
});

test('the ready state does not move; flaps reset velocity instead of stacking it', () => {
  const game = createGame();
  step(game, 0.2);
  assert.equal(game.time, 0);
  assert.equal(flap(game), false);
  startGame(game);
  assert.equal(game.bird.vy, WORLD.flapVelocity);
  step(game, 0.2);
  assert(Math.abs(game.bird.y - (240 - 285 * 0.2 + 300 * 0.2 ** 2)) < 0.001);
  flap(game); flap(game);
  assert.equal(game.bird.vy, WORLD.flapVelocity);
});

test('touching the water, ceiling, or solid part of a pipe ends the flight', () => {
  for (const [y, death] of [[489, 'water'], [1, 'ceiling']]) {
    const game = createGame(); startGame(game); game.bird.y = y;
    step(game);
    assert.equal(game.phase, 'over'); assert.equal(game.death, death);
    const frame = game.frame; step(game); assert.equal(game.frame, frame);
  }
  const game = createGame();
  game.pipes[0].x = game.bird.x;
  game.bird.y = game.pipes[0].gapTop - 10;
  assert.equal(collision(game), 'pipe');
  game.bird.y = game.pipes[0].center;
  assert.equal(collision(game), null);
});

test('a pipe scores exactly once, after the whole bird clears it', () => {
  const game = createGame(); startGame(game);
  game.bird.y = game.pipes[0].center;
  game.bird.vy = 0;
  game.pipes[0].x = game.bird.x - game.bird.radius - WORLD.pipeWidth + 0.5;
  step(game);
  assert.equal(game.score, 1);
  for (let i = 0; i < 10; i++) step(game);
  assert.equal(game.score, 1);
});

test('decision state retains a pipe until the bird has fully cleared it', () => {
  const game = createGame();
  const p = game.pipes[0];
  p.x = game.bird.x - WORLD.pipeWidth - game.bird.radius + 1;
  assert.equal(decisionState(game).pipes[0].id, p.id);
  p.x -= 2;
  assert.notEqual(decisionState(game).pipes[0].id, p.id);
});

test('a continuous 30-second course can be played with ordinary flap actions', () => {
  const game = createGame(); startGame(game);
  for (let i = 0; i < 30 / WORLD.tick && game.phase === 'playing'; i++) {
    const p = game.pipes.find(p => p.x + p.width >= game.bird.x - game.bird.radius);
    if (game.bird.y > p.center && game.bird.vy > 0) flap(game);
    step(game);
  }
  assert.equal(game.phase, 'playing');
  assert(game.score >= 10);
  assert(game.pipes.length <= 6);
});

test('arrival projections respect terminal speed and use the same physics as play', () => {
  const game = createGame();
  game.bird.y = 100; game.bird.vy = WORLD.maxFallSpeed;
  const projected = decisionState(game, 500).atExpectedArrival.bird;
  assert.equal(projected.y, 100 + WORLD.maxFallSpeed * 0.5);
  assert.equal(projected.vy, WORLD.maxFallSpeed);
  assert.equal(decisionState(game, 0).atExpectedArrival.bird.y, 100);
});

test('trajectory previews distinguish a dangerous upper-pipe flap from safe waiting', () => {
  const game = createGame();
  game.pipes[0].x = game.bird.x;
  game.bird.y = game.pipes[0].gapTop + game.bird.radius + 10;
  game.bird.vy = 0;
  const previews = decisionState(game, 0).trajectoryPreviews.actions;
  assert.equal(previews.FLAP.collision, 'upper pipe');
  assert.equal(previews.WAIT.clearUntilNextDecision, true);
});

test('arrival cases preserve distinct timestamps and share the next-decision horizon', () => {
  const game = createGame(); game.bird.vy = WORLD.maxFallSpeed;
  const before = snapshot(game);
  const plan = decisionPlan(game, 450);
  assert.deepEqual(plan.arrivalCases.map(c => c.delayMs), [200, 350, 500, 650, 800]);
  assert.deepEqual(snapshot(game), before);
  for (const c of plan.arrivalCases) {
    assert(Math.abs(c.atExpectedArrival.bird.y - (game.bird.y + WORLD.maxFallSpeed * c.delayMs / 1000)) < 1e-8);
    assert.equal(c.trajectoryPreviews.horizonMs, 608);
  }
});
