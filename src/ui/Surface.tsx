import { useEffect, useRef } from 'react';

const FINE = '(hover: hover) and (pointer: fine)';
const REDUCE = '(prefers-reduced-motion: reduce)';

/* ── 表层动效 ──
   背景已经有四层持续合成（dither / 光晕 / 网格 / 颗粒），再叠一层全屏混合
   会把中低端手机的预算吃光。所以表层只做「跟着指针走」的小东西：
   1. 光斑：一个 transform-only 的定宽径向光，不读 backdrop，不参与合成树重绘
   2. 卡片倾斜：<=6deg，用 CSS 变量喂给 transform，不改布局
   3. 区块揭示：一次性 IntersectionObserver，进视口后立刻 unobserve
   4. 导航吸附态：只改描边和投影，不动高度（改了会挤动下面所有内容）

   触摸设备与 prefers-reduced-motion 全部跳过：光斑和倾斜在触屏上没有意义，
   揭示则直接置为可见，不隐藏内容。 */

export function Surface() {
  const spotRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.land');
    if (!root) return;

    const reduce = window.matchMedia(REDUCE);
    const fine = window.matchMedia(FINE);
    const offs: Array<() => void> = [];

    /* 1. 区块揭示：没有 JS 或降级时 .reveal-ready 不加上，内容就是可见的 */
    const items = root.querySelectorAll<HTMLElement>('[data-reveal]');
    const showAll = () => items.forEach((el) => el.classList.add('is-in'));

    if (reduce.matches) {
      showAll();
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        },
        { rootMargin: '0px 0px -10% 0px', threshold: 0.02 },
      );
      /* 先造观察器再加这个类：没有 IntersectionObserver 的环境下会抛错，
         类已经加上的话内容就永久隐藏了 */
      root.classList.add('reveal-ready');
      items.forEach((el) => io.observe(el));
      offs.push(() => {
        io.disconnect();
        root.classList.remove('reveal-ready');
      });
    }

    /* 2. 光照与 3. 倾斜：只有细指针设备才装监听。
       整块只对外暴露一个撤除函数：用户中途打开「减少动效」时，
       必须连监听一起拆掉，否则 lit 卡在 true、handler 还挂着，
       下一次 pointermove 又会把光斑拉回来——降级被绕过。 */
    let teardownPointer = () => {};

    if (!reduce.matches && fine.matches) {
      const spot = spotRef.current;
      let raf = 0;
      let tx = 0;
      let ty = 0;
      let cx = 0;
      let cy = 0;
      let lit = false;
      let card: HTMLElement | null = null;
      let box: DOMRect | null = null;

      /* 缓动跟随：直接赋值会有拖影，硬跟又显得死板，0.16 的插值刚好 */
      const tick = () => {
        raf = 0;
        cx += (tx - cx) * 0.16;
        cy += (ty - cy) * 0.16;
        if (spot) spot.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;
        if (Math.abs(tx - cx) > 0.4 || Math.abs(ty - cy) > 0.4) raf = requestAnimationFrame(tick);
      };

      const onMove = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return;
        tx = e.clientX;
        ty = e.clientY;
        if (!lit) {
          lit = true;
          cx = tx;
          cy = ty;
          spot?.classList.add('is-on');
        }
        if (!raf) raf = requestAnimationFrame(tick);
      };

      const onLeave = () => {
        lit = false;
        spot?.classList.remove('is-on');
      };

      const clear = () => {
        if (card) {
          card.style.removeProperty('--tx');
          card.style.removeProperty('--ty');
        }
        card = null;
        box = null;
      };

      /* 只在卡片上做倾斜：demo 面板里有 canvas，一旋转就要重采样，
         点阵字会糊成一片，不值得 */
      const onTilt = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return;
        const next = (e.target as HTMLElement | null)?.closest<HTMLElement>('.land-card') ?? null;
        if (next !== card) {
          clear();
          card = next;
          /* 进卡片的瞬间量一次就够：之后每次 pointermove 再量都属于强制重算样式 */
          box = next ? next.getBoundingClientRect() : null;
        }
        if (!card || !box) return;
        const px = (e.clientX - box.left) / box.width - 0.5;
        const py = (e.clientY - box.top) / box.height - 0.5;
        card.style.setProperty('--tx', `${(-py * 5).toFixed(2)}deg`);
        card.style.setProperty('--ty', `${(px * 6).toFixed(2)}deg`);
      };

      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('blur', onLeave);
      document.addEventListener('pointerleave', onLeave);
      window.addEventListener('pointermove', onTilt, { passive: true });
      window.addEventListener('blur', clear);
      /* 滚动时页面在动而指针没动，事件不会再来，卡片会卡在最后一个角度上 */
      window.addEventListener('scroll', clear, { passive: true });

      teardownPointer = () => {
        cancelAnimationFrame(raf);
        raf = 0;
        lit = false;
        spot?.classList.remove('is-on');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('blur', onLeave);
        document.removeEventListener('pointerleave', onLeave);
        window.removeEventListener('pointermove', onTilt);
        window.removeEventListener('blur', clear);
        window.removeEventListener('scroll', clear);
        clear();
      };
      offs.push(() => teardownPointer());
    }

    /* 4. 导航吸附态 */
    const nav = root.querySelector<HTMLElement>('.land-nav');
    if (nav) {
      const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 12);
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
      offs.push(() => window.removeEventListener('scroll', onScroll));
    }

    /* 用户中途打开「减少动态效果」：立刻收掉光斑，揭示全部放出 */
    const onReduce = () => {
      if (!reduce.matches) return;
      teardownPointer();
      showAll();
    };
    reduce.addEventListener('change', onReduce);
    offs.push(() => reduce.removeEventListener('change', onReduce));

    return () => offs.forEach((off) => off());
  }, []);

  return <span className="land-spot" ref={spotRef} aria-hidden="true" />;
}
