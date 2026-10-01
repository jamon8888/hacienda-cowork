import { describe, expect, test } from 'bun:test';

import { resources } from '../index';

// What cabinet mode tells the user must match what it does: the refusal must
// not send them to a control that does not exist, and the description must
// not claim that everything is withheld (images pass).
const COPY: Record<string, { staleAction: string; image: string; amounts: string; addresses: string }> = {
  en: { staleAction: 'Start the Safe engine', image: 'image', amounts: 'amounts', addresses: 'addresses' },
  fr: { staleAction: 'Démarrez le moteur Safe', image: 'image', amounts: 'montants', addresses: 'adresses' },
  es: { staleAction: 'Inicie el motor Safe', image: 'imágenes', amounts: 'importes', addresses: 'direcciones' },
  it: { staleAction: 'Avvia il motore Safe', image: 'immagini', amounts: 'importi', addresses: 'indirizzi' },
  ja: { staleAction: 'Safe エンジンを起動', image: '画像', amounts: '金額', addresses: '住所' },
  ko: { staleAction: 'Safe 엔진을 시작', image: '이미지', amounts: '금액', addresses: '주소' },
  ru: { staleAction: 'Запустите движок Safe', image: 'изображени', amounts: 'суммы', addresses: 'адреса' },
  'zh-CN': { staleAction: '请启动 Safe 引擎', image: '图片', amounts: '金额', addresses: '地址' },
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

    test(`${locale}: the consent text names what pattern-only redaction really misses`, () => {
      // Pattern-only redaction masks money amounts next to a currency (regex
      // pass), so "amounts" must not be listed among what leaves in clear. What
      // only NER catches is names, companies and addresses.
      const body = strings['basemind.cabinet.disableBody'].toLowerCase();
      expect(body).not.toContain(copy.amounts);
      expect(body).toContain(copy.addresses);
    });
  }
});
