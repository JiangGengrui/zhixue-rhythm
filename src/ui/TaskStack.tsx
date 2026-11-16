import { useEffect, useRef } from 'react';

/* 落地页「任务堆积」：等距体素 + Matter.js 真物理。
   七块方块代表一周七天，依次落下压成一根柱。
   物理是 2D 刚体引擎（~28KB gzip，动态载入不进首屏），
   渲染用等距投影画成 3D 立方体：真物理 + 伪 3D。
   锁死旋转（inertia: Infinity）——七块一起翻滚会散成一片，
   柱形才是「一天一天压上来」的意思。 */

type MatterApi = typeof import('matter-js');
type Cube = { position: { x: number; y: number }; speed: number };

const STACK_H = 138;
const STEP = 1000 / 60;
const SPAWN_EVERY = 230;

export function TaskStack({ days = 7 }: { days?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      let mod: { default?: MatterApi } & MatterApi;
      try {
        mod = (await import('matter-js')) as unknown as { default?: MatterApi } & MatterApi;
      } catch {
        return; // 拉不到物理库就当没这个组件，不挂空画布
      }
      if (disposed) return;
      const M = (mod.default ?? mod) as MatterApi;

      /* 等两帧再量宽度：动态 import 返回时布局可能还没定，
         量到 0 会先画一个 1px 宽的残次品，再被 ResizeObserver 重建一次 */
      await new Promise<void>((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      });
      if (disposed) return;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      host.appendChild(canvas);

      /* 竖着堆七天，高度预算就那么多，宽度只能自己定：
         方块做成扁卡片（宽 > 高），否则柱子细得像根牙签 */
      const unit = Math.max(9, Math.min(18, Math.floor((STACK_H - 8) / days)));
      let W = Math.max(1, Math.round(host.clientWidth));
      canvas.width = W;
      canvas.height = STACK_H;
      const bw = Math.max(unit * 2, Math.min(56, Math.round(W * 0.16)));
      const tip = bw * 0.09; // 顶面菱形的半高
      const hb = unit / 2;
      /* 三个面的透明度差就是「立体感」的全部来源：
         顶 0.9 / 左 0.52 / 右 0.30，同色不同明度，像素风里最省事也最稳。
         视觉总高 = 2*tip + 侧面厚度，必须等于物理高 unit，否则方块会陷进地面 */
      const faces: Array<[Array<[number, number]>, number]> = [
        [[[0, -hb], [bw / 2, -hb + tip], [0, -hb + tip * 2], [-bw / 2, -hb + tip]], 0.9],
        [[[-bw / 2, -hb + tip], [0, -hb + tip * 2], [0, hb], [-bw / 2, hb - tip]], 0.52],
        [[[bw / 2, -hb + tip], [0, -hb + tip * 2], [0, hb], [bw / 2, hb - tip]], 0.3],
      ];

      let mint = getComputedStyle(host).getPropertyValue('--mint').trim() || '#2be6ae';

      const drawCube = (cx: number, cy: number) => {
        for (const [pts, alpha] of faces) {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = mint;
          ctx.beginPath();
          pts.forEach(([dx, dy], k) => {
            if (k === 0) ctx.moveTo(cx + dx, cy + dy);
            else ctx.lineTo(cx + dx, cy + dy);
          });
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      };

      const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      let engine = M.Engine.create({ enableSleeping: true });
      engine.gravity.y = 1;

      const mount = () => {
        const bodies: Cube[] = [];
        let raf = 0;
        let running = false;
        let settled = false;
        /* 投放进度必须活到 play 外面：滚出视口时 pause，滚回来 resume 会再调一次
           play。如果 queued 在 play 里重新等于 days，就会把七天重新落一遍，
           叠在已经堆好的柱子上——画布顶部溢出，柱子变成两层。 */
        let queued = days;
        let spawnAcc = SPAWN_EVERY;
        let acc = 0;
        let still = 0;

        const paint = () => {
          ctx.clearRect(0, 0, W, STACK_H);
          for (const b of bodies) drawCube(b.position.x, b.position.y);
        };

        const reset = () => {
          cancelAnimationFrame(raf);
          running = false;
          bodies.length = 0;
          queued = days;
          spawnAcc = SPAWN_EVERY;
          acc = 0;
          still = 0;
          engine = M.Engine.create({ enableSleeping: true });
          engine.gravity.y = 1;
          M.Composite.add(
            engine.world,
            M.Bodies.rectangle(W / 2, STACK_H + 30, W * 2, 60, {
              isStatic: true,
              friction: 0.92,
              restitution: 0,
            }),
          );
        };

        const add = (x: number, y: number, isStatic = false) => {
          const body = M.Bodies.rectangle(x, y, bw, unit, {
            inertia: Infinity, // 不旋转，堆成柱
            friction: 0.7,
            frictionStatic: 1,
            frictionAir: 0.004,
            restitution: 0.04,
            slop: 0.02,
            isStatic,
          });
          M.Composite.add(engine.world, body);
          bodies.push(body);
        };

        /* 直接摆好（减少动效时用）：从底往上垒，不做模拟 */
        const placeAll = () => {
          reset();
          for (let i = 0; i < days; i += 1) {
            const jitter = ((i * 37) % 11) - 5;
            add(W / 2 + jitter * 0.9, STACK_H - unit / 2 - i * unit, true);
          }
          paint();
        };

        const play = () => {
          if (running || settled) return;
          running = true;
          let last = 0;
          /* 只清时间轴，投放进度（queued/spawnAcc）保留，续着往下掉 */
          acc = 0;
          still = 0;

          const tick = (now: number) => {
            if (!running) return;
            raf = requestAnimationFrame(tick);
            if (!last) last = now;
            acc += Math.min(now - last, 64);
            last = now;

            /* 固定步长：120Hz 屏上物理不加速，否则方块掉得跟砸下来一样 */
            while (acc >= STEP) {
              acc -= STEP;
              if (queued > 0) {
                spawnAcc += STEP;
                if (spawnAcc >= SPAWN_EVERY) {
                  spawnAcc = 0;
                  queued -= 1;
                  const seed = days - queued;
                  add(W / 2 + (((seed * 37) % 11) - 5) * 0.9, -unit);
                }
              }
              M.Engine.update(engine, STEP);
            }

            paint();

            /* 全落完且都停住，就收工；留着最后一帧，别一直烧帧 */
            if (queued === 0 && bodies.every((b) => b.speed < 0.15)) {
              still += 1;
              if (still > 24) {
                running = false;
                settled = true;
                cancelAnimationFrame(raf);
              }
            } else {
              still = 0;
            }
          };

          raf = requestAnimationFrame(tick);
        };

        const pause = () => {
          running = false;
          cancelAnimationFrame(raf);
        };

        reset();
        if (reduceQuery.matches) placeAll();
        else play();

        return {
          dispose: () => {
            pause();
            bodies.length = 0;
          },
          resume: () => {
            /* 降级模式下不能靠 IO 回调把动画拉起来，
               跟 dither 那里踩的是同一个坑：判断只留一个出口 */
            if (settled || reduceQuery.matches) return;
            play();
          },
          pause,
          settled: () => settled,
          /* 停下时也要能出图：切主题只改颜色，不改位置 */
          repaint: () => {
            if (!running) paint();
          },
        };
      };

      let inner = mount();

      /* 窗口变宽变窄要重建，否则画布被 CSS 拉成非等比 */
      let width = W;
      const ro = new ResizeObserver(() => {
        const next = Math.max(1, Math.round(host.clientWidth));
        if (Math.abs(next - width) < 16) return;
        width = next;
        inner.dispose();
        W = next;
        canvas.width = next;
        inner = mount();
      });
      ro.observe(host);

      /* 切主题要换色并补一帧，否则浅色主题下还是深色方块 */
      const themeObserver = new MutationObserver(() => {
        mint = getComputedStyle(host).getPropertyValue('--mint').trim() || '#2be6ae';
        inner.repaint();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });

      const io = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting && !document.hidden) inner.resume();
          else inner.pause();
        },
        { threshold: 0 },
      );
      io.observe(host);

      const onReduce = () => {
        if (reduceQuery.matches) {
          inner.pause();
          inner.dispose();
          inner = mount();
        }
      };
      reduceQuery.addEventListener('change', onReduce);

      cleanup = () => {
        inner.dispose();
        ro.disconnect();
        io.disconnect();
        themeObserver.disconnect();
        reduceQuery.removeEventListener('change', onReduce);
        canvas.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [days]);

  return <div className="land-stack" ref={hostRef} aria-hidden="true" />;
}
