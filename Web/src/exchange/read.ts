// Picks the translation-file reader by extension (an .xml file must actually be XLIFF) and decodes the bytes.
import { decodeUtf8 } from '../glossary/csv';
import { readExchangeCsv } from './csv';
import type { ParsedImport } from './model';
import { readXliff } from './xliff';

// The browser file picker's filter; the editor's native dialog gets ExchangeActions' Windows filter instead.
export const TRANSLATION_FILE_ACCEPT = '.csv,.xlf,.xliff,.xml';

// CAT tools write XLIFF as UTF-8 almost always, some as UTF-16 with a byte order mark.
function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return decodeUtf8(bytes);
  } catch {
    throw new Error('The file is neither UTF-8 nor UTF-16 text.');
  }
}

export function parseTranslationFile(name: string, bytes: Uint8Array, culture: string): ParsedImport {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  if (extension === 'csv') return readExchangeCsv(decodeUtf8(bytes));
  if (extension === 'xlf' || extension === 'xliff' || extension === 'xml') {
    const text = decodeXml(bytes);
    if (extension === 'xml' && !text.includes('<xliff')) throw new Error('This XML file is not XLIFF.');
    return readXliff(text, culture);
  }
  throw new Error('Choose a .csv, .xlf, .xliff or .xml file.');
}
