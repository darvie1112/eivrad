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

// Gentle, one-time entrance. Reduced-motion and no-JS visitors see all content immediately.
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let entranceObserver;
let motionFrame = 0;
const revealSections = [...document.querySelectorAll('.ev-how-grid, .ev-demo, .ev-feature-list article, .ev-detail-grid, .ev-pack, .ev-import-flow, .ev-translate-sample, .ev-plans, .ev-brand-note')];
const heroMedia = document.querySelector('[data-ev-parallax]');
const readingProgress = document.querySelector('.ev-reading-progress');
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
function configureMotion() {
  entranceObserver?.disconnect();
  document.documentElement.classList.toggle('ev-motion', !motionPreference.matches);
  revealSections.forEach(element => element.classList.remove('ev-await'));
  if (!motionPreference.matches && 'IntersectionObserver' in window) {
    entranceObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.remove('ev-await');
          entranceObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0, rootMargin: '0px 0px -32px 0px' });
    revealSections.forEach(element => {
      element.setAttribute('data-ev-reveal', '');
      if (element.getBoundingClientRect().top > window.innerHeight) {
        element.classList.add('ev-await');
        entranceObserver.observe(element);
      }
    });
  }
  scheduleMotion();
}
window.addEventListener('scroll', scheduleMotion, { passive: true });
window.addEventListener('resize', scheduleMotion, { passive: true });
motionPreference.addEventListener('change', configureMotion);
configureMotion();
