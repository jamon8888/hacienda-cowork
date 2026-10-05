import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';

import {
  findTokens,
  findTokensInOoxml,
  rehydrateOoxml,
  rehydrateText,
  rehydrateXmlPart,
  resolveTokens,
} from './rehydrate';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function docx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`);
  zip.file('docProps/core.xml', '<?xml version="1.0"?><cp:coreProperties><dc:title>Bail [ORGANIZATION_0]</dc:title></cp:coreProperties>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function documentXml(buffer: Buffer): Promise<string> {
  return (await JSZip.loadAsync(buffer)).file('word/document.xml')!.async('string');
}

describe('resolveTokens', () => {
  test('prefers the workspace registry, falls back to the thread, flags disagreement', () => {
    const resolution = resolveTokens(
      ['[PERSON_0]', '[PERSON_1]', '[PERSON_2]', '[EMAIL_0]', '[PERSON_0]'],
      {
        workspace: { '[PERSON_0]': 'Jean Dupont', '[PERSON_2]': 'Marie Curie' },
        thread: { '[PERSON_1]': 'Paul Martin', '[PERSON_2]': 'Someone Else' },
      },
    );
    expect(resolution.values).toEqual({ '[PERSON_0]': 'Jean Dupont', '[PERSON_1]': 'Paul Martin' });
    expect(resolution.conflicting).toEqual(['[PERSON_2]']);
    expect(resolution.unresolved).toEqual(['[EMAIL_0]']);
  });
});

describe('plain text', () => {
  test('replaces resolved tokens and keeps unresolved ones visible', () => {
    expect(findTokens('[PERSON_0] signs for [ORGANIZATION_1].')).toEqual(['[PERSON_0]', '[ORGANIZATION_1]']);
    expect(rehydrateText('[PERSON_0] signs for [ORGANIZATION_1].', { '[PERSON_0]': 'Jean Dupont' }))
      .toBe('Jean Dupont signs for [ORGANIZATION_1].');
  });
});

describe('OOXML', () => {
  test('a token split across Word runs is found and replaced in the run where it starts', async () => {
    const input = await docx(
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Seller: [PERS</w:t></w:r>'
      + '<w:r><w:t>ON_0]</w:t></w:r><w:r><w:t xml:space="preserve"> and [PERSON_1].</w:t></w:r></w:p>',
    );
    expect((await findTokensInOoxml(input)).sort()).toEqual(['[ORGANIZATION_0]', '[PERSON_0]', '[PERSON_1]']);

    const output = await rehydrateOoxml(input, {
      '[PERSON_0]': 'Jean & Fils <SARL>',
      '[PERSON_1]': 'Marie Curie',
      '[ORGANIZATION_0]': 'Acme SAS',
    });
    const xml = await documentXml(output);
    // Value in the first (bold) run, XML-escaped; the tail of the token is gone.
    expect(xml).toContain('<w:t xml:space="preserve">Seller: Jean &amp; Fils &lt;SARL&gt;</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve"></w:t>');
    expect(xml).toContain('<w:t xml:space="preserve"> and Marie Curie.</w:t>');
    expect(xml).not.toContain('PERSON');
    const core = await (await JSZip.loadAsync(output)).file('docProps/core.xml')!.async('string');
    expect(core).toContain('Bail Acme SAS');
  });

  test('a token spread over three runs and an unresolved token', () => {
    const xml = `<w:p><w:r><w:t>[</w:t></w:r><w:r><w:t>EMAIL</w:t></w:r><w:r><w:t>_2] ok [PERSON_9]</w:t></w:r></w:p>`;
    const out = rehydrateXmlPart('word/document.xml', xml, { '[EMAIL_2]': 'a@b.fr' });
    expect(out).toBe('<w:p><w:r><w:t xml:space="preserve">a@b.fr</w:t></w:r><w:r><w:t xml:space="preserve"></w:t></w:r><w:r><w:t xml:space="preserve"> ok [PERSON_9]</w:t></w:r></w:p>');
  });

  test('PowerPoint and Excel text runs', () => {
    expect(rehydrateXmlPart('ppt/slides/slide1.xml', '<a:p><a:r><a:t>Client [PERS</a:t></a:r><a:r><a:t>ON_0]</a:t></a:r></a:p>', { '[PERSON_0]': 'Jean' }))
      .toBe('<a:p><a:r><a:t>Client Jean</a:t></a:r><a:r><a:t></a:t></a:r></a:p>');
    expect(rehydrateXmlPart('xl/sharedStrings.xml', '<sst><si><t>[ORGANIZATION_0]</t></si><si><r><t>[AMOUNT_</t></r><r><t>0]</t></r></si></sst>', { '[ORGANIZATION_0]': 'Acme', '[AMOUNT_0]': '125 000 €' }))
      .toBe('<sst><si><t>Acme</t></si><si><r><t>125 000 €</t></r><r><t></t></r></si></sst>');
  });

  test('does not touch markup that only looks like a text element', () => {
    const xml = '<w:p><w:tbl/><w:tab/><w:r><w:t>[PERSON_0]</w:t></w:r></w:p>';
    expect(rehydrateXmlPart('word/document.xml', xml, { '[PERSON_0]': 'Jean' }))
      .toBe('<w:p><w:tbl/><w:tab/><w:r><w:t xml:space="preserve">Jean</w:t></w:r></w:p>');
  });
});
