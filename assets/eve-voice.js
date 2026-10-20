// A fixed, local illustration of the translation workflow, not a translation service.
const translationSampleButton = document.getElementById('translation-sample-button');
const translationSampleOutput = document.getElementById('translation-sample-output');

if (translationSampleButton && translationSampleOutput) {
  translationSampleButton.hidden = false;
  translationSampleButton.addEventListener('click', () => {
    const showTranslation = translationSampleButton.getAttribute('aria-expanded') !== 'true';
    const paragraph = document.createElement('p');
    paragraph.textContent = showTranslation
      ? 'テキストを選択し、翻訳のショートカットキーを押してください。'
      : '下のボタンを押すと、訳文を表示します。';
    if (!showTranslation) paragraph.className = 'ev-sample-placeholder';
    paragraph.classList.add('ev-swap-in');
    translationSampleOutput.replaceChildren(paragraph);
    translationSampleButton.setAttribute('aria-expanded', String(showTranslation));
    translationSampleButton.querySelector('[data-sample-label]').textContent = showTranslation
      ? '例文に戻す'
      : '例文を日本語に';
  });
}

// Collapsing the optional recording also stops it; no background playback.
const translationRecording = document.querySelector('.ev-translation-video');
if (translationRecording) {
  translationRecording.addEventListener('toggle', () => {
    if (!translationRecording.open) translationRecording.querySelector('video')?.pause();
  });
}

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

// Gentle, one-time entrance. Reduced-motion and no-JS visitors see all content immediately.
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let entranceObserver;
let kineticObserver;
let motionFrame = 0;
const revealSections = [...document.querySelectorAll('.ev-intro-copy, .ev-numbers, .ev-workflow li, .ev-demo, .ev-feature, .ev-finish, .ev-detail-grid, .ev-pack-grid, .ev-import-flow, .ev-translate-sample, .ev-plans, .ev-brand-note')];
const heroMedia = document.querySelector('[data-ev-parallax]');
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
  if (heroMedia) {
    const top = heroMedia.getBoundingClientRect().top;
    const shift = motionPreference.matches || window.innerWidth <= 760 ? 0 : Math.max(-10, Math.min(10, (window.innerHeight / 2 - top) * .025));
    heroMedia.style.transform = `translateY(${shift}px)`;
  }
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
  entranceObserver?.disconnect();
  kineticObserver?.disconnect();
  finishCount();
  const animate = !motionPreference.matches && 'IntersectionObserver' in window;
  document.documentElement.classList.toggle('ev-motion', !motionPreference.matches);
  revealSections.forEach(element => element.classList.remove('ev-await'));
  kinetic?.classList.remove('ev-k-armed', 'ev-k-played');
  if (animate) {
    entranceObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.remove('ev-await');
          if (entry.target === numbers && counters.length) runCount();
          entranceObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0, rootMargin: '0px 0px -32px 0px' });
    revealSections.forEach(element => {
      element.setAttribute('data-ev-reveal', '');
      if (element.getBoundingClientRect().top > window.innerHeight) {
        element.classList.add('ev-await');
        if (element === numbers && counters.length) prepareCount();
        entranceObserver.observe(element);
      }
    });
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
  entranceObserver?.disconnect();
  kineticObserver?.disconnect();
  finishCount();
  revealSections.forEach(element => element.classList.remove('ev-await'));
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
