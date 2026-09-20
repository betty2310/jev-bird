import { WORLD } from './engine.js';

const clamp = (n, low, high) => Math.max(low, Math.min(n, high));

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.viewWidth = Math.min(WORLD.width, WORLD.height * rect.width / Math.max(1, rect.height));
    this.cameraX = Math.max(0, WORLD.birdX - this.viewWidth * 0.255);
  }

  burst(game) {
    const water = game.death === 'water';
    for (let i = 0; i < 22; i++) this.particles.push({
      x: game.bird.x, y: water ? WORLD.floorY : game.bird.y,
      vx: (Math.random() - 0.5) * 170, vy: -40 - Math.random() * 160,
      life: 1, color: water ? '#d7ebe0' : i % 2 ? '#f4ce66' : '#f7efca', radius: 2 + Math.random() * 4,
    });
  }

  draw(game, wallTime, dt) {
    if (!this.width || !this.height) return;
    const c = this.ctx;
    const time = this.reducedMotion ? 0 : wallTime / 1000;
    c.setTransform(this.dpr * this.width / this.viewWidth, 0, 0, this.dpr * this.height / WORLD.height, 0, 0);
    c.clearRect(0, 0, this.viewWidth, WORLD.height);
    this.landscape(time, game.distance);
    c.save();
    c.translate(-this.cameraX, 0);
    for (const pipe of game.pipes) this.pipe(pipe, time);
    const bird = { ...game.bird };
    if (game.phase === 'ready') bird.y += Math.sin(time * 2.8) * 6;
    this.bird(bird, game, time);
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 200 * dt; p.life -= dt * 1.3;
      c.globalAlpha = Math.max(0, p.life);
      c.fillStyle = p.color;
      c.beginPath(); c.ellipse(p.x, p.y, p.radius * 0.7, p.radius, 0.2, 0, Math.PI * 2); c.fill();
    }
    this.particles = this.particles.filter(p => p.life > 0);
    c.globalAlpha = 1;
    c.restore();
    this.water(time, game.distance);
  }

  landscape(time, distance) {
    const c = this.ctx, w = this.viewWidth;
    const sky = c.createLinearGradient(0, 0, 0, WORLD.floorY);
    sky.addColorStop(0, '#edf2dc'); sky.addColorStop(0.65, '#e4edd3'); sky.addColorStop(1, '#d4e5cf');
    c.fillStyle = sky; c.fillRect(0, 0, w, WORLD.height);
    c.fillStyle = '#f6e6b06b'; c.beginPath(); c.arc(w * 0.76, 87, 51, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#f7e9b7'; c.beginPath(); c.arc(w * 0.76, 87, 35, 0, Math.PI * 2); c.fill();
    const clouds = [[85, 78, 1], [420, 139, 0.75], [738, 58, 0.8], [1110, 153, 1.1]];
    for (const [x, y, scale] of clouds) {
      const at = ((x - distance * 0.1 - time * 2) % 1250 + 1250) % 1250 - 130;
      this.cloud(at, y, scale);
    }
    this.hills('#d3dfbf', 329, 48, distance * 0.08, 1.2);
    this.hills('#c1d6b3', 386, 33, distance * 0.15 + 85, 1.8);
    this.hills('#b4cead', 425, 26, distance * 0.22 + 200, 2.3);
    // Distant little canal-side houses and tall trees.
    for (let i = 0; i < 9; i++) {
      const x = ((i * 183 + 46 - distance * 0.25) % 1650 + 1650) % 1650 - 140;
      if (i % 3 === 0) {
        c.fillStyle = '#b7cbb0'; c.fillRect(x, 399, 45, 31);
        c.fillStyle = '#a3bfa1'; c.beginPath(); c.moveTo(x - 5, 400); c.lineTo(x + 21, 378); c.lineTo(x + 50, 400); c.closePath(); c.fill();
        c.fillStyle = '#dce6c7'; c.fillRect(x + 9, 411, 8, 10); c.fillRect(x + 29, 411, 8, 10);
      } else {
        c.fillStyle = '#a5c3a0'; c.fillRect(x, 385, 3, 50);
        c.beginPath(); c.ellipse(x + 2, 378, 13, 40 + i % 3 * 5, 0, 0, Math.PI * 2); c.fill();
      }
    }
    c.fillStyle = '#a3c4a6'; c.fillRect(0, 449, w, 43);
    c.fillStyle = '#b5ceac';
    for (let i = 0; i < w / 20 + 2; i++) {
      const x = i * 20 - (distance * 0.38 % 20);
      c.beginPath(); c.ellipse(x, 450 + Math.sin(i * 2) * 2, 19, 10, 0, 0, Math.PI * 2); c.fill();
    }
    // Tiny faraway birds, well apart from the player silhouette.
    c.strokeStyle = '#9bb493'; c.lineWidth = 1.4;
    for (const [x, y] of [[w * 0.60, 190], [w * 0.64, 180]]) {
      c.beginPath(); c.moveTo(x - 5, y); c.quadraticCurveTo(x - 2, y - 3, x, y); c.quadraticCurveTo(x + 3, y - 3, x + 6, y); c.stroke();
    }
  }

  cloud(x, y, s) {
    const c = this.ctx; c.save(); c.translate(x, y); c.scale(s, s);
    c.fillStyle = '#fffdf17a'; c.beginPath(); c.roundRect(0, 0, 113, 21, 13); c.fill();
    for (const [cx, cy, r] of [[24, 0, 17], [46, -10, 27], [78, 0, 20]]) { c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill(); }
    c.restore();
  }

  hills(color, baseline, height, offset, frequency) {
    const c = this.ctx, w = this.viewWidth;
    c.fillStyle = color; c.beginPath(); c.moveTo(-10, WORLD.floorY);
    for (let x = -10; x < w + 20; x += 10) {
      c.lineTo(x, baseline - Math.sin((x + offset) / (170 / frequency)) * height - Math.cos((x + offset) / 240) * 13);
    }
    c.lineTo(w + 20, WORLD.floorY); c.closePath(); c.fill();
  }

  pipe(p, time) {
    const c = this.ctx;
    if (p.x > this.cameraX + this.viewWidth + 20 || p.x + p.width < this.cameraX - 20) return;
    const body = (y, h, capY, upper) => {
      if (h <= 0) return;
      const fill = c.createLinearGradient(p.x, 0, p.x + p.width, 0);
      fill.addColorStop(0, '#719c82'); fill.addColorStop(0.18, '#9fbea0'); fill.addColorStop(0.72, '#80aa8d'); fill.addColorStop(1, '#5f8e77');
      c.fillStyle = '#47765e18'; c.fillRect(p.x + 9, y + 5, p.width - 7, h);
      c.fillStyle = fill; c.strokeStyle = '#658d72'; c.lineWidth = 1.5;
      c.beginPath(); c.rect(p.x + 5, y, p.width - 10, h); c.fill(); c.stroke();
      c.fillStyle = '#d0dfac66'; c.fillRect(p.x + 12, y, 4, h);
      c.fillStyle = '#507f661f'; c.fillRect(p.x + p.width - 17, y, 6, h);
      const glassHeight = Math.min(69, h - 49), glassY = upper ? capY - glassHeight - 17 : capY + 36;
      if (glassHeight > 20) {
        c.fillStyle = '#c0dcca'; c.strokeStyle = '#5f8c76'; c.lineWidth = 2;
        c.beginPath(); c.roundRect(p.x + p.width / 2 - 10, glassY, 20, glassHeight, 9); c.fill(); c.stroke();
        c.save(); c.clip(); c.fillStyle = '#81b9ac'; c.fillRect(p.x + p.width / 2 - 8, glassY + 13 + Math.sin(time * 2 + p.id) * 3, 16, glassHeight);
        c.fillStyle = '#e0eee088';
        for (let i = 0; i < 3; i++) {
          const yy = glassY + 7 + ((time * 17 + i * 21 + p.id * 5) % Math.max(10, glassHeight - 10));
          c.beginPath(); c.arc(p.x + p.width / 2 + Math.sin(i * 6 + time) * 3, yy, 2, 0, Math.PI * 2); c.fill();
        }
        c.restore();
        c.fillStyle = '#f2f4d954'; c.fillRect(p.x + p.width / 2 - 5, glassY + 8, 2, glassHeight - 16);
      }
      c.fillStyle = '#9fbc96'; c.strokeStyle = '#658d72'; c.lineWidth = 1.5;
      c.beginPath(); c.roundRect(p.x, capY, p.width, 20, 4); c.fill(); c.stroke();
      c.fillStyle = '#d5e0b56e'; c.fillRect(p.x + 4, capY + 3, p.width - 8, 3);
      c.fillStyle = '#537f65';
      for (const xx of [p.x + 10, p.x + p.width - 10]) { c.beginPath(); c.arc(xx, capY + 11, 2.1, 0, Math.PI * 2); c.fill(); }
      // A thin dark seam makes the collision edge legible.
      c.fillStyle = '#567f654d'; c.fillRect(p.x + 4, upper ? capY + 17 : capY + 1, p.width - 8, 2);
    };
    body(-5, p.gapTop + 5, p.gapTop - 20, true);
    body(p.gapBottom, WORLD.floorY - p.gapBottom + 6, p.gapBottom, false);
  }

  bird(b, game, time) {
    const c = this.ctx;
    const angle = game.phase === 'ready' ? -0.05 : clamp(b.vy / 530, -0.4, 1.0);
    const justFlapped = game.time - b.lastFlap < 0.18;
    const wing = game.phase === 'ready' ? Math.sin(time * 6) * 0.3 : justFlapped ? -0.8 : 0.25;
    c.save(); c.translate(b.x, b.y); c.rotate(angle);
    c.fillStyle = '#b49f4430'; c.beginPath(); c.ellipse(0, 22, 19, 4, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#997638'; c.lineWidth = 1.6; c.lineJoin = 'round';
    c.fillStyle = '#e9b744'; c.beginPath(); c.moveTo(-17, 4); c.lineTo(-33, -3); c.lineTo(-28, 10); c.lineTo(-16, 11); c.fill(); c.stroke();
    c.fillStyle = '#4e8b84'; c.beginPath(); c.moveTo(-13, 11); c.quadraticCurveTo(-28, 11 + Math.sin(time * 9) * 3, -31, 19); c.lineTo(-25, 19); c.lineTo(-26, 24); c.lineTo(-9, 16); c.fill();
    c.fillStyle = '#f5ce5a'; c.beginPath(); c.ellipse(0, 0, 24, 20, -0.08, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = '#fae595'; c.beginPath(); c.ellipse(10, 8, 12, 9, -0.2, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ecc04c'; c.beginPath(); c.moveTo(-7, -18); c.quadraticCurveTo(-12, -30, -3, -24); c.lineTo(1, -20); c.quadraticCurveTo(2, -30, 7, -23); c.lineTo(8, -18); c.fill(); c.stroke();
    c.save(); c.translate(-9, 1); c.rotate(wing); c.fillStyle = '#e4ad3f'; c.beginPath(); c.ellipse(-3, 3, 13, 8, -0.3, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#c69637'; c.beginPath(); c.moveTo(-12, 6); c.quadraticCurveTo(-5, 9, 5, 3); c.stroke(); c.restore();
    c.fillStyle = '#faf8e7'; c.beginPath(); c.ellipse(13, -6, 7.8, 10, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#384a35';
    if (game.phase === 'over') { c.strokeStyle = '#384a35'; c.beginPath(); c.moveTo(12, -9); c.lineTo(18, -3); c.moveTo(18, -9); c.lineTo(12, -3); c.stroke(); }
    else { c.beginPath(); c.ellipse(16, -5, 3, 4.7, 0, 0, Math.PI * 2); c.fill(); c.fillStyle = '#fffef2'; c.beginPath(); c.arc(17, -7, 1.2, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = '#e99851'; c.strokeStyle = '#b38142'; c.beginPath(); c.moveTo(22, -1); c.lineTo(33, 4); c.lineTo(22, 9); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#52938b'; c.beginPath(); c.moveTo(-12, 15); c.quadraticCurveTo(3, 22, 19, 13); c.lineTo(19, 18); c.quadraticCurveTo(5, 26, -13, 20); c.closePath(); c.fill();
    c.fillStyle = '#e3a741'; c.globalAlpha = 0.5; c.beginPath(); c.ellipse(16, 9, 4, 2.5, 0, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  water(time, distance) {
    const c = this.ctx, w = this.viewWidth;
    const fill = c.createLinearGradient(0, WORLD.floorY, 0, WORLD.height);
    fill.addColorStop(0, '#b6d6c7'); fill.addColorStop(1, '#96bfb3');
    c.fillStyle = fill; c.fillRect(0, WORLD.floorY, w, 50);
    c.strokeStyle = '#e4edce'; c.lineWidth = 2;
    c.beginPath();
    for (let x = 0; x <= w + 8; x += 8) c.lineTo(x, WORLD.floorY + Math.sin(x / 22 + time * 1.7) * 1.8);
    c.stroke();
    for (let i = 0; i < 26; i++) {
      const x = ((i * 83 - distance * 0.4 + time * 5) % (w + 100) + w + 100) % (w + 100) - 50;
      const y = 501 + (i * 13 % 34);
      c.strokeStyle = i % 3 ? '#d4e5cb70' : '#7facaa5c'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 10 + i % 5 * 5, y); c.stroke();
    }
    c.fillStyle = '#678d7957';
    for (let i = 0; i < 4; i++) {
      const x = ((i * 293 - distance * 0.6) % (w + 300) + w + 300) % (w + 300) - 80;
      c.beginPath(); c.ellipse(x, 513 + i % 2 * 9, 10, 3.5, -0.2, 0, Math.PI * 2); c.fill();
    }
  }
}
