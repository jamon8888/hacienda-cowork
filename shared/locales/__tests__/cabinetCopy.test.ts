import { describe, expect, test } from 'bun:test';

import { resources } from '../index';

// What cabinet mode tells the user must match what it does: the refusal must
// not send them to a control that does not exist, and the description must
// not claim that everything is withheld (images pass).
const COPY: Record<string, { staleAction: string; image: string }> = {
  en: { staleAction: 'Start the Safe engine', image: 'image' },
  fr: { staleAction: 'Démarrez le moteur Safe', image: 'image' },
  es: { staleAction: 'Inicie el motor Safe', image: 'imágenes' },
  it: { staleAction: 'Avvia il motore Safe', image: 'immagini' },
  ja: { staleAction: 'Safe エンジンを起動', image: '画像' },
  ko: { staleAction: 'Safe 엔진을 시작', image: '이미지' },
  ru: { staleAction: 'Запустите движок Safe', image: 'изображени' },
  'zh-CN': { staleAction: '请启动 Safe 引擎', image: '图片' },
};

describe('cabinet mode copy', () => {
  for (const [locale, copy] of Object.entries(COPY)) {
    const strings = resources[locale as keyof typeof resources].translation as Record<string, string>;

    test(`${locale}: the refusal points to something the user can do`, () => {
      const blocked = strings['basemind.cabinet.blockedSend'];
      expect(blocked).not.toContain(copy.staleAction);
      expect(blocked).toContain('Interpreter');
    });

    test(`${locale}: the description says images are not withheld`, () => {
      expect(strings['basemind.cabinet.description'].toLowerCase()).toContain(copy.image);
    });
  }
});
