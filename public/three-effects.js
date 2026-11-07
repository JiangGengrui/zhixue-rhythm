/**
 * three-effects.js — ReactBits 风格 3D 物理组件（原生移植版）
 *  - Ballpit：3D 刚体球堆，鼠标可推挤（自实现球-球/球-墙碰撞）
 *  - Lanyard：绳索约束的吊牌，可拖拽甩动（单摆 + 惯性）
 * 依赖 three.js（CDN ES Module），加载失败时静默降级，不影响页面其他功能。
 */

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const start = () => {
  // 用动态 import 加载 three：jsDelivr 带 CORS 头，file:// 直接打开也能工作
  import(THREE_URL).then((THREE) => {
    const ballHost = document.getElementById('ballpit-layer');
    const lanyardHost = document.getElementById('lanyard-stage');
    if (ballHost) initBallpit(THREE, ballHost);
    if (lanyardHost) initLanyard(THREE, lanyardHost);
  }).catch((err) => {
    console.warn('[three-effects] three.js 加载失败，3D 效果已跳过', err);
  });

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

    const PALETTE = ['#dff0e6', '#cbe6d7', '#bcdcc8', '#f5ebd9', '#e2efe6', '#cfe8da'];
    const sphere = new T.SphereGeometry(1, 24, 16);
    const balls = [];
    const COUNT = 18;

    for (let i = 0; i < COUNT; i++) {
      const r = 0.24 + Math.random() * 0.26;
      const mesh = new T.Mesh(
        sphere,
        new T.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], roughness: 0.5, metalness: 0.02 })
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

    window.addEventListener('pointermove', (event) => {
      const rect = host.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      mouse3.set(nx, ny, 0.5).unproject(camera);
      const dir = mouse3.sub(camera.position).normalize();
      const t = -camera.position.z / dir.z;
      mouse.copy(camera.position).add(dir.multiplyScalar(t));
    }, { passive: true });

    function step(dt) {
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

        // 鼠标推挤
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

        // 轻微滚动感
        b.mesh.rotation.x += b.v.z * dt * 1.4;
        b.mesh.rotation.y += b.v.x * dt * 0.9;
      }

      // 球-球碰撞
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
      step(dt);
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
      renderer.render(scene, camera); // 静态一帧
      return;
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopLoop(); else if (visible) startLoop();
    });

    const io = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible && !document.hidden) startLoop(); else stopLoop();
    }, { threshold: 0 });
    io.observe(host);

    startLoop();
  }

  /* ══════════════════ Lanyard：绳索吊牌 ══════════════════ */
  function initLanyard(T, host) {
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(0, 0.55, 7.6);

    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = T.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    scene.add(new T.AmbientLight(0xffffff, 1.05));
    const key = new T.DirectionalLight(0xffffff, 1.25);
    key.position.set(4, 7, 9);
    scene.add(key);
    const fill = new T.DirectionalLight(0xd8e9df, 0.55);
    fill.position.set(-7, 2, 5);
    scene.add(fill);

    // 卡面纹理
    const tex = makeCardTexture(T);
    const card = new T.Mesh(
      new T.PlaneGeometry(2.92, 1.85),
      new T.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, metalness: 0.02, side: T.DoubleSide })
    );
    scene.add(card);

    // 绳带
    const ropeMat = new T.LineBasicMaterial({ color: 0x4f9b7e, transparent: true, opacity: 0.85 });
    const ropes = [0, 1].map(() => {
      const line = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), ropeMat);
      scene.add(line);
      return line;
    });

    const pivot = { x: 0, y: 3.85 };
    const L = 3.5;
    let theta = 0.04;
    let omega = 0.08;
    let dragging = false;
    let lastAngle = theta;
    let prev = performance.now();
    let raf = 0;

    function resize() {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    function cardPoint() {
      return {
        x: pivot.x + Math.sin(theta) * L,
        y: pivot.y - Math.cos(theta) * L
      };
    }

    function updateVisual() {
      const c = cardPoint();
      card.position.set(c.x, c.y, 0);
      card.rotation.z = -theta * 0.85;
      const cos = Math.cos(-theta * 0.85), sin = Math.sin(-theta * 0.85);
      const hh = 0.9;
      const anchors = [-1.02, 1.02];
      ropes.forEach((line, i) => {
        const ax = anchors[i];
        const dx = ax * cos - hh * sin;
        const dy = ax * sin + hh * cos;
        const from = new T.Vector3(pivot.x + ax, pivot.y + 0.55, -0.02);
        const to = new T.Vector3(c.x + dx, c.y + dy, 0);
        const mid = from.clone().add(to).multiplyScalar(0.5);
        mid.y -= 0.16;
        const curve = new T.QuadraticBezierCurve3(from, mid, to);
        line.geometry.setFromPoints(curve.getPoints(16));
      });
    }

    function loop(now) {
      const dt = Math.min(0.033, (now - prev) / 1000) || 0.016;
      prev = now;
      if (!dragging) {
        const g = 9.2;
        const breeze = Math.sin(now * 0.0006) * 0.03;
        omega += (-(g / L) * Math.sin(theta) - omega * 2.0 + breeze) * dt;
        theta += omega * dt;
      }
      updateVisual();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    }

    // 拖拽交互
    function toWorld(event) {
      const rect = host.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      const v = new T.Vector3(nx, ny, 0.5).unproject(camera);
      const dir = v.sub(camera.position).normalize();
      const t = -camera.position.z / dir.z;
      return camera.position.clone().add(dir.multiplyScalar(t));
    }

    host.addEventListener('pointerdown', (event) => {
      const w = toWorld(event);
      const c = cardPoint();
      if (Math.abs(w.x - c.x) < 1.55 && Math.abs(w.y - c.y) < 1.05) {
        dragging = true;
        host.setPointerCapture(event.pointerId);
        lastAngle = theta;
      }
    });
    host.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const w = toWorld(event);
      const next = Math.atan2(w.x - pivot.x, pivot.y - w.y);
      theta = Math.max(-0.78, Math.min(0.78, next));
      omega = (theta - lastAngle) * 26;
      lastAngle = theta;
    });
    const endDrag = () => { dragging = false; };
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);

    resize();
    new ResizeObserver(resize).observe(host);
    updateVisual();
    renderer.render(scene, camera);

    if (reduceMotion) return; // 静态呈现

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) { prev = performance.now(); raf = requestAnimationFrame(loop); }
    });
    raf = requestAnimationFrame(loop);
  }

  /* ── 卡面纹理（Canvas 绘制） ── */
  function makeCardTexture(T) {
    const W = 1024, H = 648;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');

    const r = 44;
    const rr = (x, y, w, h, rad) => {
      g.beginPath();
      g.moveTo(x + rad, y);
      g.arcTo(x + w, y, x + w, y + h, rad);
      g.arcTo(x + w, y + h, x, y + h, rad);
      g.arcTo(x, y + h, x, y, rad);
      g.arcTo(x, y, x + w, y, rad);
      g.closePath();
    };

    // 卡体
    rr(14, 14, W - 28, H - 28, r);
    g.fillStyle = '#ffffff';
    g.fill();

    // 顶部绿色带
    g.save();
    rr(14, 14, W - 28, H - 28, r);
    g.clip();
    g.fillStyle = '#eaf4ee';
    g.fillRect(14, 14, W - 28, 132);
    g.fillStyle = '#277a63';
    g.fillRect(14, 142, W - 28, 4);

    // 品牌标记
    g.fillStyle = '#43886b';
    g.fillRect(64, 58, 8, 34);
    g.fillRect(80, 46, 8, 58);
    g.fillRect(96, 54, 8, 42);
    g.fillStyle = '#202b28';
    g.font = '600 34px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('智学节律', 126, 90);
    g.fillStyle = '#7b8882';
    g.font = '400 20px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('让计划跟得上现实', 126, 118);
    g.restore();

    // 正文
    g.fillStyle = '#a4ada7';
    g.font = '400 20px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('学习空间 · 成员卡', 64, 214);

    g.fillStyle = '#202b28';
    g.font = '600 62px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('林同学', 62, 300);

    g.fillStyle = '#4a5751';
    g.font = '400 26px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('考研 · 计算机科学', 64, 344);

    // 三个小指标
    const items = [['目标', '380 分'], ['阶段', '强化 · 第 6 周'], ['初试', '42 天']];
    items.forEach((it, i) => {
      const x = 64 + i * 210;
      g.fillStyle = '#a4ada7';
      g.font = '400 18px "PingFang SC","Microsoft YaHei",sans-serif';
      g.fillText(it[0], x, 424);
      g.fillStyle = '#277a63';
      g.font = '600 26px "PingFang SC","Microsoft YaHei",sans-serif';
      g.fillText(it[1], x, 460);
    });

    // 分隔线 + 条码
    g.strokeStyle = '#e9eeea';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(64, 500); g.lineTo(W - 64, 500); g.stroke();

    let bx = 64;
    while (bx < 360) {
      const w = 2 + Math.random() * 5;
      g.fillStyle = '#202b28';
      g.fillRect(bx, 528, w, 52);
      bx += w + 4;
    }
    g.fillStyle = '#7b8882';
    g.font = '400 18px "SF Mono",Consolas,monospace';
    g.fillText('ZX-2027-1107 · VALID 07/2026 — 12/2026', 64, 612);

    // 右上角挂孔
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(W / 2, 44, 17, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = '#dbe5de';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(W / 2, 44, 19, 0, Math.PI * 2);
    g.stroke();

    const texture = new T.CanvasTexture(cv);
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  }
};

start();
