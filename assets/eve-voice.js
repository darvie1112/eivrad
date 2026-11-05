// Videos start only from their controls. Leaving the viewport or tab pauses playback.
const demoVideos = [...document.querySelectorAll('.ev-page:not(.evt-page) video')];
if ('IntersectionObserver' in window) {
  const videoObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) entry.target.pause();
    });
  });
  demoVideos.forEach(video => videoObserver.observe(video));
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) demoVideos.forEach(video => video.pause());
});

// A link to a question (e.g. "登録のしかた" → #faq-activate) lands on it already open.
function openLinkedDetails(hash) {
  if (!hash || hash.length < 2) return;
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
  const target = document.getElementById(id);
  if (target && target.tagName === 'DETAILS') target.open = true;
}
openLinkedDetails(location.hash);
window.addEventListener('hashchange', () => openLinkedDetails(location.hash));
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (link) openLinkedDetails(link.getAttribute('href'));
});

// Keep the chosen count-up and correction marks; scrolling never hides or moves text.
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let countObserver;
let kineticObserver;
let motionFrame = 0;
const readingProgress = document.querySelector('.ev-reading-progress');
const numbers = document.querySelector('.ev-numbers');
const counters = [...document.querySelectorAll('.ev-count[data-ev-count]')];
const kinetic = document.querySelector('.ev-kinetic');
let countFrame = 0;

function updateMotion() {
  motionFrame = 0;
  const range = document.documentElement.scrollHeight - window.innerHeight;
  const progress = range > 0 ? Math.min(1, Math.max(0, window.scrollY / range)) : 0;
  if (readingProgress) readingProgress.style.transform = `scaleX(${progress})`;
}
function scheduleMotion() {
  if (!motionFrame) motionFrame = window.requestAnimationFrame(updateMotion);
}

// Infographic count-up: only when the numbers start below the fold, so a visible figure never resets.
function finishCount() {
  if (countFrame) window.cancelAnimationFrame(countFrame);
  countFrame = 0;
  counters.forEach(counter => {
    counter.textContent = counter.dataset.evCount;
    counter.style.minWidth = '';
  });
}
function prepareCount() {
  counters.forEach(counter => {
    // Width in digits follows the font size, so a rotation before the count does not shift the unit.
    counter.style.minWidth = `${counter.dataset.evCount.length}ch`;
    counter.textContent = '0';
  });
}
function runCount() {
  const duration = 1100;
  let started;
  const step = now => {
    started ??= now;
    const t = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    counters.forEach(counter => { counter.textContent = String(Math.round(Number(counter.dataset.evCount) * eased)); });
    if (t < 1) countFrame = window.requestAnimationFrame(step);
    else finishCount();
  };
  countFrame = window.requestAnimationFrame(step);
}

function configureMotion() {
  countObserver?.disconnect();
  kineticObserver?.disconnect();
  finishCount();
  const animate = !motionPreference.matches && 'IntersectionObserver' in window;
  document.documentElement.classList.toggle('ev-motion', !motionPreference.matches);
  kinetic?.classList.remove('ev-k-armed', 'ev-k-played');
  if (animate) {
    if (numbers && counters.length && numbers.getBoundingClientRect().top > window.innerHeight) {
      prepareCount();
      countObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          runCount();
          countObserver.disconnect();
        }
      }, { threshold: 0, rootMargin: '0px 0px -32px 0px' });
      countObserver.observe(numbers);
    }
    if (kinetic) {
      kinetic.classList.add('ev-k-armed');
      kineticObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          kinetic.classList.add('ev-k-played');
          kineticObserver.disconnect();
        }
      }, { threshold: .6 });
      kineticObserver.observe(kinetic);
    }
  }
  scheduleMotion();
}
window.addEventListener('scroll', scheduleMotion, { passive: true });
window.addEventListener('resize', scheduleMotion, { passive: true });
motionPreference.addEventListener('change', () => {
  // The cover's entrance plays once per visit, not again when the setting changes.
  document.documentElement.classList.add('ev-settled');
  configureMotion();
});
configureMotion();

// Printing or saving as PDF shows every section and the final figures.
window.addEventListener('beforeprint', () => {
  countObserver?.disconnect();
  kineticObserver?.disconnect();
  finishCount();
  kinetic?.classList.add('ev-k-played');
});

// Phone carousel for the dictionary packs: an index moves within the strip and focuses the card.
const packGrid = document.querySelector('.ev-pack-grid');
const packIndex = document.querySelector('.ev-pack-index');
const phoneWidth = window.matchMedia('(max-width: 760px)');
let packObserver;
if (packGrid && packIndex) {
  const links = [...packIndex.querySelectorAll('a[href^="#ev-pack-"]')];
  const cards = links.map(link => document.getElementById(link.getAttribute('href').slice(1)));
  const setCurrent = index => links.forEach((link, i) => {
    if (i === index) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  const configurePacks = () => {
    packObserver?.disconnect();
    if (phoneWidth.matches) {
      packGrid.setAttribute('role', 'region');
      packGrid.setAttribute('tabindex', '0');
      packGrid.setAttribute('aria-label', '6種類の辞書パックと登録語の例（横にスクロール）');
      setCurrent(0);
      if ('IntersectionObserver' in window) {
        packObserver = new IntersectionObserver(entries => {
          const atEnd = packGrid.scrollLeft + packGrid.clientWidth >= packGrid.scrollWidth - 2;
          if (atEnd) { setCurrent(cards.length - 1); return; }
          const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.left - b.boundingClientRect.left)[0];
          if (visible) setCurrent(cards.indexOf(visible.target));
        }, { root: packGrid, threshold: .6 });
        cards.forEach(card => card && packObserver.observe(card));
      }
    } else {
      packGrid.removeAttribute('role');
      packGrid.removeAttribute('tabindex');
      packGrid.setAttribute('aria-label', '6種類の辞書パックと登録語の例');
      links.forEach(link => link.removeAttribute('aria-current'));
    }
  };
  links.forEach((link, i) => link.addEventListener('click', event => {
    const card = cards[i];
    if (!card || !phoneWidth.matches) return;
    event.preventDefault();
    packGrid.scrollTo({ left: card.offsetLeft - packGrid.offsetLeft, behavior: motionPreference.matches ? 'auto' : 'smooth' });
    card.focus({ preventScroll: true });
    setCurrent(i);
  }));
  // Tabbing into a card that is only peeking at the edge brings it into view.
  packGrid.addEventListener('focusin', event => {
    if (!phoneWidth.matches) return;
    const i = cards.indexOf(event.target.closest('.ev-pack'));
    if (i < 0) return;
    packGrid.scrollTo({ left: cards[i].offsetLeft - packGrid.offsetLeft, behavior: motionPreference.matches ? 'auto' : 'smooth' });
    setCurrent(i);
  });
  phoneWidth.addEventListener('change', configurePacks);
  configurePacks();
}
