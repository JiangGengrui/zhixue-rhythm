/**
 * three-effects.js — 页面物理交互组件（原生移植版）
 *  - 玻璃卡（Lanyard 区）：2D Canvas 绘制的半透明卡片，可拖拽，惯性滑行 + 边界回弹
 *  - Ballpit：3D 刚体球堆（仅当页面存在 #ballpit-layer 时才加载 three.js）
 * 依赖：玻璃卡零依赖；Ballpit 需要 three.js（CDN ES Module），加载失败静默降级。
 */

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const start = () => {
  const frogHost = document.getElementById('lanyard-stage');
  if (frogHost) initCard(frogHost);

  // 只有在真的用到 3D 球堆时才去拉 three.js，避免主页多余的网络依赖
  const ballHost = document.getElementById('ballpit-layer');
  if (ballHost) {
    import(THREE_URL)
      .then((THREE) => initBallpit(THREE, ballHost))
      .catch((err) => {
        console.warn('[three-effects] three.js 加载失败，3D 效果已跳过', err);
      });
  }

  /* ══════════════════ 玻璃卡：可拖拽的半透明卡片（2D Canvas） ══════════════════ */
  function initCard(host) {
    const cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    cv.style.touchAction = 'none';
    host.appendChild(cv);
    const ctx = cv.getContext('2d');

    let W = 1;
    let H = 1;
    let DPR = 1;
    let cw = 190;
    let ch = 118;
    const pos = { x: 0, y: 0 };
    const vel = { x: 0, y: 0 };
    let rot = 0;
    let squash = 0;
    let lift = 0;
    let placed = false;
    let interacted = false;
    const pointer = { x: 0, y: 0 };
    let dragging = false;
    let grab = { x: 0, y: 0 };
    let prev = performance.now();
    let raf = 0;
    let visible = true;

    const MAX_ROT = 0.1;
    const RADIUS = 18;

    function clamp(v, a, b) {
      return v < a ? a : v > b ? b : v;
    }

    /* ── 尺寸与边界 ── */
    function bounds() {
      const hw = cw / 2 + (ch / 2) * Math.sin(MAX_ROT) + 4;
      const hh = ch / 2 + (cw / 2) * Math.sin(MAX_ROT) + 4;
      return { minX: hw, maxX: W - hw, minY: hh, maxY: H - hh };
    }

    function layout() {
      W = Math.max(1, host.clientWidth);
      H = Math.max(1, host.clientHeight);
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(W * DPR);
      cv.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      cw = Math.max(150, Math.min(196, W * 0.58));
      ch = cw * 0.62;

      if (!placed || !interacted) {
        // 容器尺寸稳定前不认第一次布局
        pos.x = W * 0.5;
        pos.y = H * 0.5;
        placed = true;
      }
      const b = bounds();
      pos.x = clamp(pos.x, b.minX, b.maxX);
      pos.y = clamp(pos.y, b.minY, b.maxY);
    }

    /* ── 物理：无吊线，松手后带惯性滑行并在四边回弹 ── */
    function bump(speed) {
      squash = Math.min(0.8, Math.abs(speed) / 1600 + 0.16);
    }

    function step(dt) {
      const b = bounds();

      if (dragging) {
        const tx = clamp(pointer.x + grab.x, b.minX, b.maxX);
        const ty = clamp(pointer.y + grab.y, b.minY, b.maxY);
        const k = 1 - Math.exp(-dt * 22);
        const nx = pos.x + (tx - pos.x) * k;
        const ny = pos.y + (ty - pos.y) * k;
        vel.x = (nx - pos.x) / Math.max(dt, 1e-3);
        vel.y = (ny - pos.y) / Math.max(dt, 1e-3);
        pos.x = nx;
        pos.y = ny;
      } else {
        // 阻尼滑行
        const damp = Math.exp(-dt * 2.1);
        vel.x *= damp;
        vel.y *= damp;
        pos.x += vel.x * dt;
        pos.y += vel.y * dt;

        if (pos.x < b.minX) {
          pos.x = b.minX;
          if (vel.x < 0) { bump(vel.x); vel.x = -vel.x * 0.56; vel.y *= 0.94; }
        } else if (pos.x > b.maxX) {
          pos.x = b.maxX;
          if (vel.x > 0) { bump(vel.x); vel.x = -vel.x * 0.56; vel.y *= 0.94; }
        }
        if (pos.y < b.minY) {
          pos.y = b.minY;
          if (vel.y < 0) { bump(vel.y); vel.y = -vel.y * 0.54; vel.x *= 0.94; }
        } else if (pos.y > b.maxY) {
          pos.y = b.maxY;
          if (vel.y > 0) { bump(vel.y); vel.y = -vel.y * 0.54; vel.x *= 0.94; }
        }
      }

      // 没有吊绳了，姿态只跟着横向速度轻轻侧倾
      const target = clamp(vel.x * 0.00016, -MAX_ROT, MAX_ROT);
      rot += (target - rot) * Math.min(1, dt * 8);
      squash = Math.max(0, squash - dt * 3.6);
      lift += ((dragging ? 1 : 0) - lift) * Math.min(1, dt * 10);
    }

    /* ── 绘制 ── */
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawCard() {
      const w = cw;
      const h = ch;
      const sx = 1 + squash * 0.14;
      const sy = 1 - squash * 0.14;
      const glow = 0.16 + lift * 0.12;

      // 柔和落影
      ctx.save();
      ctx.translate(pos.x, pos.y + h * 0.55 + 12 + lift * 12);
      ctx.rotate(rot * 0.6);
      ctx.scale(1, 0.4);
      const shadow = ctx.createRadialGradient(0, 0, w * 0.05, 0, 0, w * 0.72);
      shadow.addColorStop(0, `rgba(0,0,0,${0.4 - lift * 0.14})`);
      shadow.addColorStop(0.55, `rgba(0,0,0,${0.19 - lift * 0.08})`);
      shadow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shadow;
      ctx.beginPath();
      ctx.arc(0, 0, w * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(rot);
      ctx.scale(sx, sy);

      // 玻璃体
      const glass = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      glass.addColorStop(0, `rgba(255,255,255,${0.2 + lift * 0.05})`);
      glass.addColorStop(0.38, 'rgba(255,255,255,0.095)');
      glass.addColorStop(0.72, 'rgba(255,255,255,0.055)');
      glass.addColorStop(1, 'rgba(255,255,255,0.04)');
      roundRect(-w / 2, -h / 2, w, h, RADIUS);
      ctx.fillStyle = glass;
      ctx.fill();

      ctx.save();
      roundRect(-w / 2, -h / 2, w, h, RADIUS);
      ctx.clip();

      // 底部薄荷/蓝色折射
      const mint = ctx.createRadialGradient(-w * 0.26, h * 0.5, 2, -w * 0.26, h * 0.5, w * 0.95);
      mint.addColorStop(0, 'rgba(43,230,174,0.20)');
      mint.addColorStop(0.5, 'rgba(72,200,255,0.07)');
      mint.addColorStop(1, 'rgba(72,200,255,0)');
      ctx.fillStyle = mint;
      ctx.fillRect(-w / 2, -h / 2, w, h);

      // 斜向反光
      const sheen = ctx.createLinearGradient(-w / 2, -h / 2, w * 0.55, h * 0.55);
      sheen.addColorStop(0, `rgba(255,255,255,${glow + 0.02})`);
      sheen.addColorStop(0.32, 'rgba(255,255,255,0.03)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(-w / 2, -h / 2, w, h);

      // 左上角镜面高光
      const spec = ctx.createRadialGradient(-w * 0.34, -h * 0.36, 2, -w * 0.34, -h * 0.36, w * 0.46);
      spec.addColorStop(0, `rgba(255,255,255,${0.16 + lift * 0.06})`);
      spec.addColorStop(0.45, 'rgba(255,255,255,0.03)');
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = spec;
      ctx.fillRect(-w / 2, -h / 2, w, h);

      ctx.restore();

      // 外描边（薄荷辉光）+ 内描边
      ctx.save();
      ctx.shadowColor = `rgba(43,230,174,${0.26 + lift * 0.16})`;
      ctx.shadowBlur = 14;
      roundRect(-w / 2, -h / 2, w, h, RADIUS);
      ctx.strokeStyle = `rgba(226,255,246,${0.34 + lift * 0.1})`;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.restore();

      roundRect(-w / 2 + 1.2, -h / 2 + 1.2, w - 2.4, h - 2.4, RADIUS - 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.stroke();

      // 卡面内容：只有「智学节律」
      ctx.fillStyle = 'rgba(233,242,240,0.95)';
      ctx.font = '600 15px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0.12em';
      ctx.fillText('智学节律', 2, 1);
      ctx.textAlign = 'left';
      ctx.restore();
    }

    function render() {
      ctx.clearRect(0, 0, W, H);
      drawCard();
    }

    /* ── 循环 ── */
    function loop(now) {
      const dt = Math.min(0.032, (now - prev) / 1000) || 0.016;
      prev = now;
      step(dt);
      render();
      raf = requestAnimationFrame(loop);
    }

    function startLoop() {
      if (raf || reduceMotion) return;
      prev = performance.now();
      raf = requestAnimationFrame(loop);
    }

    function stopLoop() {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    /* ── 交互 ── */
    function localPoint(event) {
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function overCard(p) {
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      const cos = Math.cos(-rot);
      const sin = Math.sin(-rot);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      return Math.abs(lx) <= cw / 2 + 6 && Math.abs(ly) <= ch / 2 + 6;
    }

    host.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const p = localPoint(event);
      if (!overCard(p)) return;
      event.preventDefault();
      interacted = true;
      dragging = true;
      pointer.x = p.x;
      pointer.y = p.y;
      grab = { x: pos.x - p.x, y: pos.y - p.y };
      host.setPointerCapture(event.pointerId);
      host.style.cursor = 'grabbing';
      if (reduceMotion) {
        step(0.016);
        render();
      }
    });

    host.addEventListener('pointermove', (event) => {
      const p = localPoint(event);
      pointer.x = p.x;
      pointer.y = p.y;
      if (dragging) {
        if (reduceMotion) {
          const b = bounds();
          pos.x = clamp(p.x + grab.x, b.minX, b.maxX);
          pos.y = clamp(p.y + grab.y, b.minY, b.maxY);
          render();
        }
        return;
      }
      host.style.cursor = overCard(p) ? 'grab' : 'default';
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      host.style.cursor = 'grab';
      const max = 1800;
      const sp = Math.hypot(vel.x, vel.y);
      if (sp > max) {
        vel.x = (vel.x / sp) * max;
        vel.y = (vel.y / sp) * max;
      }
    }

    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
    host.addEventListener('pointerleave', () => {
      if (!dragging) host.style.cursor = 'default';
    });

    layout();
    new ResizeObserver(() => {
      layout();
      render();
    }).observe(host);

    render();

    if (reduceMotion) return;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopLoop();
      else if (visible) startLoop();
    });

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        if (visible && !document.hidden) startLoop();
        else stopLoop();
      },
      { threshold: 0 },
    );
    io.observe(host);

    startLoop();
  }

  /* ══════════════════ Ballpit：3D 物理球堆 ══════════════════ */
  function initBallpit(T, host) {
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 16);

    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = T.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    scene.add(new T.HemisphereLight(0xffffff, 0xdbe7df, 1.25));
    const key = new T.DirectionalLight(0xffffff, 1.15);
    key.position.set(5, 9, 10);
    scene.add(key);
    const rim = new T.DirectionalLight(0xbfdccc, 0.55);
    rim.position.set(-8, -5, 6);
    scene.add(rim);

    const PALETTE = ['#9ff0d3', '#bfe8dd', '#a8d8e6', '#d8e9f2', '#c6eee0', '#b9dfeb'];
    const sphere = new T.SphereGeometry(1, 24, 16);
    const balls = [];
    const COUNT = 18;

    for (let i = 0; i < COUNT; i++) {
      const r = 0.24 + Math.random() * 0.26;
      const mesh = new T.Mesh(
        sphere,
        new T.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], roughness: 0.5, metalness: 0.02 }),
      );
      mesh.scale.setScalar(r);
      mesh.position.set((Math.random() - 0.5) * 13, -4 + Math.random() * 10, -2.2 + Math.random() * 4.2);
      scene.add(mesh);
      balls.push({ mesh, r, v: new T.Vector3((Math.random() - 0.5) * 0.5, 0, 0) });
    }

    const B = { x: 7.4, top: 6.6, bottom: -4.6, back: -2.6, front: 2.4 };
    const G = -13;
    const mouse = new T.Vector3(1e3, 1e3, 0);
    const mouse3 = new T.Vector3();
    let visible = true;
    let raf = 0;
    let last = performance.now();

    function resize() {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    window.addEventListener(
      'pointermove',
      (event) => {
        const rect = host.getBoundingClientRect();
        const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
        mouse3.set(nx, ny, 0.5).unproject(camera);
        const dir = mouse3.sub(camera.position).normalize();
        const t = -camera.position.z / dir.z;
        mouse.copy(camera.position).add(dir.multiplyScalar(t));
      },
      { passive: true },
    );

    function stepPhysics(dt) {
      for (const b of balls) {
        const p = b.mesh.position;
        b.v.y += G * dt;
        b.v.multiplyScalar(0.996);
        p.addScaledVector(b.v, dt);

        if (p.x > B.x - b.r) { p.x = B.x - b.r; b.v.x *= -0.55; }
        if (p.x < -B.x + b.r) { p.x = -B.x + b.r; b.v.x *= -0.55; }
        if (p.y < B.bottom + b.r) { p.y = B.bottom + b.r; b.v.y *= -0.6; b.v.x *= 0.985; }
        if (p.y > B.top - b.r) { p.y = B.top - b.r; b.v.y *= -0.4; }
        if (p.z > B.front - b.r) { p.z = B.front - b.r; b.v.z *= -0.5; }
        if (p.z < B.back + b.r) { p.z = B.back + b.r; b.v.z *= -0.5; }

        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const dz = p.z - mouse.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const R = 2.7;
        if (d2 < R * R) {
          const d = Math.sqrt(d2) || 0.001;
          const f = (1 - d / R) * 34 * dt;
          b.v.x += (dx / d) * f;
          b.v.y += (dy / d) * f;
          b.v.z += (dz / d) * f * 0.5;
        }

        b.mesh.rotation.x += b.v.z * dt * 1.4;
        b.mesh.rotation.y += b.v.x * dt * 0.9;
      }

      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const a = balls[i], b = balls[j];
          const pa = a.mesh.position, pb = b.mesh.position;
          const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
          const min = a.r + b.r;
          if (dist >= min) continue;
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          const overlap = (min - dist) * 0.5;
          pa.x -= nx * overlap; pa.y -= ny * overlap; pa.z -= nz * overlap;
          pb.x += nx * overlap; pb.y += ny * overlap; pb.z += nz * overlap;
          const rel = (b.v.x - a.v.x) * nx + (b.v.y - a.v.y) * ny + (b.v.z - a.v.z) * nz;
          if (rel < 0) {
            const imp = -(1 + 0.45) * rel * 0.5;
            a.v.x -= nx * imp; a.v.y -= ny * imp; a.v.z -= nz * imp;
            b.v.x += nx * imp; b.v.y += ny * imp; b.v.z += nz * imp;
          }
        }
      }
    }

    function loop(now) {
      const dt = Math.min(0.033, (now - last) / 1000) || 0.016;
      last = now;
      stepPhysics(dt);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    }

    function startLoop() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
    function stopLoop() {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    resize();
    new ResizeObserver(resize).observe(host);

    if (reduceMotion) {
      renderer.render(scene, camera);
      return;
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopLoop();
      else if (visible) startLoop();
    });

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        if (visible && !document.hidden) startLoop();
        else stopLoop();
      },
      { threshold: 0 },
    );
    io.observe(host);

    startLoop();
  }
};

start();
