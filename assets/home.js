(() => {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  /* 「動きを減らす」が途中で変わったら、読み直して最初から合わせる */
  document.documentElement.classList.toggle('kinetic', !still.matches);
  still.addEventListener('change', () => window.location.reload());
  const stage = document.querySelector('[data-stage]');
  let lookAt = null;

  /* 見出しを1文字ずつ着地させ、「驚」が跳ねた時にモルとトノルがそちらを見る */
  const title = document.querySelector('.hero h1');
  if (title && document.documentElement.classList.contains('kinetic') && !still.matches) {
    title.setAttribute('aria-label', title.textContent);
    let i = 0;
    let jump = null;
    [...title.childNodes].forEach((node) => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      const box = document.createDocumentFragment();
      [...node.textContent].forEach((letter) => {
        const span = document.createElement('span');
        span.className = 'ch';
        span.setAttribute('aria-hidden', 'true');
        span.style.setProperty('--i', i);
        span.textContent = letter;
        if (letter === '驚') jump = span;
        box.append(span);
        i += 1;
      });
      node.replaceWith(box);
    });
    title.classList.add('is-split');
    if (jump) {
      window.setTimeout(() => {
        jump.classList.add('is-jump');
        if (lookAt) lookAt(jump);
      }, 1320);
    }
  }

  /* モルとトノルの目がカーソルを追う */
  if (stage && !still.matches) {
    const inner = stage.querySelector('.stage');
    const eyes = [
      { el: stage.querySelector('.eye--l .eye-pupil'), x: 294.6, y: 277.8, rx: 6, up: 3, down: 4 },
      { el: stage.querySelector('.eye--r .eye-pupil'), x: 403.7, y: 309.6, rx: 6, up: 3, down: 4 },
      { el: stage.querySelector('.owl-eye--l .eye-pupil'), x: 654.9, y: 389.7, rx: 3, up: 2, down: 2.5 },
      { el: stage.querySelector('.owl-eye--r .eye-pupil'), x: 704.2, y: 371.6, rx: 3, up: 2, down: 2.5 },
    ];
    eyes.forEach((eye) => { eye.cx = 0; eye.cy = 0; });
    const box = { s: 1, x: 0, y: 0 };
    const fit = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!w || !h) return;
      /* モルの顔からトノルの翼までが必ず入る大きさで、ふたりを真ん中に置く */
      const cover = Math.max(w / 1280, h / 720);
      const s = Math.max(cover, Math.min(cover * 1.35, w / 620));
      box.s = s;
      box.x = clamp(w * 0.5 - 510 * s, w - 1280 * s, 0);
      box.y = clamp(h * 0.5 - 395 * s, h - 720 * s, 0);
      inner.style.transform = `translate(${box.x}px,${box.y}px) scale(${s})`;
    };
    const art = inner.querySelector('img');
    /* 瞳を消した下絵まで読んでから目を出す。先に動くと元の瞳と二重に見える */
    const patch = new Image();
    patch.src = '/assets/home/morunel-eyes.webp';
    new Image().src = '/assets/home/morunel-shut.webp';
    const ready = () => {
      if (art.complete && art.naturalWidth && patch.complete && patch.naturalWidth) stage.classList.add('stage-ready');
    };
    stage.classList.add('stage-on');
    fit();
    art.addEventListener('load', ready, { once: true });
    patch.addEventListener('load', ready, { once: true });
    ready();
    new ResizeObserver(fit).observe(stage);

    let seen = true;
    let aim = null;
    let frame = 0;
    /* まばたきと視線は、操作のあとの5秒だけ。操作がなければ絵は静かに止まる */
    let lively = performance.now() + 5000;
    const stir = () => { lively = performance.now() + 5000; };
    const awake = () => seen && performance.now() < lively;
    const toStage = (cx, cy) => {
      const r = stage.getBoundingClientRect();
      return { x: (cx - r.left - box.x) / box.s, y: (cy - r.top - box.y) / box.s };
    };
    const step = () => {
      frame = 0;
      let moving = false;
      eyes.forEach((eye) => {
        let tx = 0;
        let ty = 0;
        if (aim) {
          const dx = aim.x - eye.x;
          const dy = aim.y - eye.y;
          const d = Math.hypot(dx, dy) || 1;
          const k = Math.min(1, d / 280);
          tx = (dx / d) * k * eye.rx;
          ty = (dy / d) * k * (dy < 0 ? eye.up : eye.down);
        }
        eye.cx += (tx - eye.cx) * 0.16;
        eye.cy += (ty - eye.cy) * 0.16;
        if (Math.abs(tx - eye.cx) + Math.abs(ty - eye.cy) > 0.04) moving = true;
        eye.el.style.transform = `translate(${eye.cx.toFixed(2)}px,${eye.cy.toFixed(2)}px)`;
      });
      if (moving && awake()) frame = requestAnimationFrame(step);
    };
    const nudge = () => { if (!frame && seen) frame = requestAnimationFrame(step); };

    lookAt = (target) => {
      const r = target.getBoundingClientRect();
      aim = toStage(r.left + r.width / 2, r.top + r.height / 2);
      nudge();
    };

    window.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      stir();
      aim = toStage(event.clientX, event.clientY);
      nudge();
    }, { passive: true });
    window.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      stir();
      aim = toStage(event.clientX, event.clientY);
      nudge();
    }, { passive: true });
    window.addEventListener('scroll', stir, { passive: true });

    const blink = () => {
      if (seen && performance.now() + 130 < lively) {
        stage.classList.add('is-blink');
        window.setTimeout(() => stage.classList.remove('is-blink'), 130);
      }
      window.setTimeout(blink, 2600 + Math.random() * 3800);
    };
    window.setTimeout(blink, 2400);

    if (!hover.matches) {
      /* 触って使う機器では、視線がゆっくり動く */
      const wander = () => {
        if (awake()) {
          aim = { x: 330 + Math.random() * 560, y: 120 + Math.random() * 420 };
          nudge();
        }
        window.setTimeout(wander, 2800 + Math.random() * 2400);
      };
      window.setTimeout(wander, 3000);
    }
    new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; }).observe(stage);
  }

  /* 動く言葉：スクロールの位置で3拍を進める */
  const verse = document.querySelector('[data-verse]');
  if (verse) {
    const wave = verse.querySelector('[data-wave]');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1200 400');
    svg.setAttribute('preserveAspectRatio', 'none');
    const lines = [0, 1, 2].map(() => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg.append(path);
      return path;
    });
    wave.append(svg);
    const draw = (t, amp) => {
      lines.forEach((path, n) => {
        let d = '';
        for (let x = 0; x <= 1200; x += 12) {
          const u = x / 1200;
          const swell = Math.sin(u * Math.PI);
          const y = 200 + swell * amp * (Math.sin(u * 19 + t * 6 + n * 1.4) * 62 + Math.sin(u * 47 - t * 9 + n) * 26 + Math.sin(u * 7 + t * 3) * 44);
          d += `${x ? 'L' : 'M'}${x} ${y.toFixed(1)}`;
        }
        path.setAttribute('d', d);
      });
    };
    draw(0.3, 0.9);
    if (document.documentElement.classList.contains('kinetic')) {
      const stick = verse.querySelector('.verse-stick');
      const film = verse.querySelector('.verse-block--film');
      const tool = verse.querySelector('.verse-block--tool');
      const part = (block) => [...block.querySelectorAll('.v')];
      const soundWords = part(verse.querySelector('.verse-block--sound'));
      const filmWords = part(film);
      const fills = [...film.querySelectorAll('.v--fill')];
      const toolWords = part(tool);
      const icons = [...tool.querySelectorAll('.v-icon')];
      const span = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
      const out = (t) => 1 - (1 - t) ** 3;
      const sweep = (t) => {
        const a = 120 - t * 170;
        return `polygon(${a + 16}% 0,120% 0,120% 100%,${a}% 100%)`;
      };
      const land = (el, t, lift) => {
        const e = out(t);
        el.style.opacity = t <= 0 ? 0 : Math.min(1, t * 2.4);
        el.style.transform = `translateY(${((1 - e) * lift).toFixed(1)}px)`;
      };
      let pending = 0;
      const render = () => {
        pending = 0;
        const r = verse.getBoundingClientRect();
        const view = window.innerHeight;
        if (r.bottom < -40 || r.top > view + 40) return;
        const strip = fills[0].offsetHeight * (1628 / 520);
        /* 固定が解ける位置で1になる。iPhone のバーが出ていても最後の拍まで出し切る */
        const p = clamp(-r.top / (r.height - stick.offsetHeight), 0, 1);
        const enter = clamp(1 - r.top / view, 0, 1);
        soundWords.forEach((el, n) => land(el, span(enter, 0.3 + n * 0.1, 0.72 + n * 0.1), 70));
        if (p < 0.34) draw(enter * 0.8 + p * 3.4, 0.25 + out(span(enter, 0.2, 1)) * 0.75);
        film.style.clipPath = sweep(out(span(p, 0.16, 0.32)));
        filmWords.forEach((el, n) => land(el, span(p, 0.24 + n * 0.035, 0.34 + n * 0.035), 90));
        const shift = -strip * (0.08 + span(p, 0.2, 0.62) * 0.56);
        fills.forEach((el) => el.style.setProperty('--x', `${shift.toFixed(1)}px`));
        tool.style.clipPath = sweep(out(span(p, 0.56, 0.72)));
        toolWords.forEach((el, n) => land(el, span(p, 0.64 + n * 0.018, 0.72 + n * 0.018), 60));
        icons.forEach((el, n) => {
          const t = span(p, 0.8 + n * 0.035, 0.86 + n * 0.035);
          el.style.opacity = Math.min(1, t * 2);
          el.style.transform = `translateY(${((1 - out(t)) * 26).toFixed(1)}px) scale(${(0.86 + out(t) * 0.14).toFixed(3)})`;
        });
      };
      const queue = () => { if (!pending) pending = requestAnimationFrame(render); };
      window.addEventListener('scroll', queue, { passive: true });
      window.addEventListener('resize', queue, { passive: true });
      render();
    }
  }
  /* ここまで動けば、動く言葉を続けてよいという印。無ければ head の処理が静かな表示へ戻す */
  document.documentElement.setAttribute('data-home', '');

  /* 数字：見えた時に0から数え、目盛りも同じだけ伸びる */
  const facts = [...document.querySelectorAll('[data-fact]')];
  if (facts.length && !still.matches && 'IntersectionObserver' in window) {
    const run = (fact) => {
      const number = fact.querySelector('[data-count]');
      const ticks = fact.querySelector('.fact-ticks');
      const goal = Number(number.dataset.count);
      const start = performance.now() + 450;
      const time = 500 + goal * 50;
      const tick = (now) => {
        const t = clamp((now - start) / time, 0, 1);
        const e = 1 - (1 - t) ** 3;
        number.textContent = String(Math.round(goal * e));
        ticks.style.setProperty('--p', e);
        if (t < 1) requestAnimationFrame(tick);
      };
      /* 桁が減っても横の文が動かないよう、最後の値の幅で止めておく */
      number.style.minWidth = `${number.getBoundingClientRect().width}px`;
      number.textContent = '0';
      ticks.style.setProperty('--p', 0);
      requestAnimationFrame(tick);
    };
    /* 画面に入るまでは本文の数字のまま。数え始めたら必ず最後の値で止まる */
    const watcher = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        watcher.unobserve(entry.target);
        run(entry.target);
      });
    }, { threshold: 0.05 });
    facts.forEach((fact) => watcher.observe(fact));
  }

  /* 動く絵は見えている間だけ再生し、止めるボタンを出す */
  const loops = [...document.querySelectorAll('video[data-loop]')];
  loops.forEach((video) => {
    const cell = video.closest('.home-product-cell');
    const button = cell && cell.querySelector('[data-loop-toggle]');
    const label = button && button.querySelector('.sr-only');
    let stopped = still.matches;
    let inView = false;
    const paint = () => {
      if (!button) return;
      button.classList.toggle('is-stopped', stopped);
      if (label) label.textContent = stopped ? '絵を動かす' : '絵の動きを止める';
    };
    const sync = () => {
      if (stopped || !inView) {
        video.pause();
        return;
      }
      video.play().catch((error) => {
        if (error.name === 'AbortError') return;
        stopped = true;
        paint();
      });
    };
    if (button) {
      button.hidden = false;
      button.addEventListener('click', () => {
        stopped = !stopped;
        paint();
        sync();
      });
    }
    still.addEventListener('change', (event) => {
      if (event.matches) stopped = true;
      paint();
      sync();
    });
    paint();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        sync();
      }, { threshold: 0.25 }).observe(video);
    }
  });
})();
