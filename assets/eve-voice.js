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
