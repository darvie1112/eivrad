/* 正面のループだけを操作する。JSがない時はposterを表示する。 */
(() => {
  const video = document.querySelector('#dc-hero-video');
  const button = document.querySelector('.dc-motion-toggle');
  if (!video || !button || !('IntersectionObserver' in window)) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let inView = false;
  let userPaused = false;
  let attempt = 0;

  const canPlay = () => inView && !document.hidden && !reduced.matches && !userPaused;
  const showState = () => {
    button.setAttribute('aria-pressed', String(!video.paused));
    button.disabled = reduced.matches || !!video.error;
    button.textContent = video.error ? '映像を再生できません'
      : reduced.matches ? '動きを減らす設定のため停止中'
      : video.paused ? '絵の動きを再生する' : '絵の動きを止める';
  };
  const sync = () => {
    const current = ++attempt;
    if (!canPlay()) {
      video.pause();
      showState();
      return;
    }
    video.play().catch(() => {
      if (current !== attempt) return;
      userPaused = true;
      video.pause();
      showState();
    });
  };

  button.addEventListener('click', () => {
    userPaused = !video.paused;
    sync();
  });
  video.addEventListener('play', () => {
    if (!canPlay()) video.pause();
    showState();
  });
  video.addEventListener('pause', showState);
  video.addEventListener('error', () => {
    userPaused = true;
    video.pause();
    showState();
  });
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting && entry.intersectionRatio >= 0.1;
    sync();
  }, { threshold: 0.1 }).observe(video);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  window.addEventListener('pagehide', () => {
    attempt += 1;
    video.pause();
  });
  window.addEventListener('pageshow', sync);
  showState();
  button.hidden = false;
})();
