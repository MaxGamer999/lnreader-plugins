import { Plugin } from '@/types/plugin';
import { fetchApi } from '@libs/fetch';
import { CheerioAPI, load as parseHTML } from 'cheerio';
import { NovelStatus } from '@libs/novelStatus';
import { cbc } from '@noble/ciphers/aes.js';

class TomatoMTL implements Plugin.PluginBase {
  id = 'tomatomtl';
  name = 'TomatoMTL';
  site = 'https://tomatomtl.com';
  version = '1.0.1';
  icon = 'src/en/tomatomtl/icon.png';
  // TomatoMTL uses browser storage for its catalogue cache. Keeping this flag
  // enabled also makes the source compatible with LNReader's web-backed flow.
  webStorageUtilized = true;

  private absolute(path: string): string {
    return new URL(path, this.site).toString();
  }

  private async request(
    url: string,
    init?: Parameters<typeof fetchApi>[1],
    retries = 5,
    credentials: RequestCredentials = 'include',
  ): Promise<Response> {
    let lastStatus = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchApi(url, {
          credentials,
          ...init,
        });
        if (response.ok) return response;

        lastStatus = response.status;
        // TomatoMTL was observed returning 503 once and succeeding on retry.
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
          return response;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt + 1 < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(750 * 2 ** attempt, 6000)),
        );
      }
    }

    if (lastError) throw lastError;
    throw new Error(`TomatoMTL request failed after ${retries} attempts (HTTP ${lastStatus})`);
  }

  private clean(value: string | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
  }

  private jsonString(html: string, variable: string): string | undefined {
    const match = html.match(
      new RegExp(`(?:const|let|var)\\s+${variable}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`),
    );
    if (!match) return undefined;
    try {
      return JSON.parse(match[1]);
    } catch {
      // Single-quoted fallback. TomatoMTL currently emits double-quoted JS
      // strings, but this keeps the parser tolerant of a small site change.
      return match[1].slice(1, -1).replace(/\\(['\\"])/g, '$1');
    }
  }

  private bookId(path: string): string {
    const match = path.match(/\/book\/(\d+)/);
    if (!match) throw new Error(`Invalid TomatoMTL book path: ${path}`);
    return match[1];
  }

  async popularNovels(): Promise<Plugin.NovelItem[]> {
    return [];
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    const pageIndex = Math.max(0, pageNo - 1);
    const response = await this.request(this.absolute('/api/search-proxy.php'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: searchTerm,
        page_index: pageIndex,
        page_count: 10,
        query_type: 0,
      }),
    });

    if (!response.ok) {
      throw new Error(`TomatoMTL search failed (HTTP ${response.status})`);
    }

    const data = await response.json();
    const tabs = Array.isArray(data?.search_tabs) ? data.search_tabs : [];
    const tab = tabs.find((item: any) => Array.isArray(item?.data)) ?? tabs[0];
    const rows = Array.isArray(tab?.data) ? tab.data : [];

    return rows
      .map((row: any) => row?.book_data?.[0])
      .filter((book: any) => book?.book_id && book?.book_name)
      .map((book: any) => ({
        name: String(book.book_name),
        path: this.absolute(`/book/${book.book_id}`),
        ...(book.thumb_url
          ? { cover: this.absolute(String(book.thumb_url)) }
          : {}),
      }));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.absolute(novelPath);
    const response = await this.request(url);
    const html = await response.text();
    const $ = parseHTML(html);
    const id = this.bookId(novelPath);

    const title =
      this.jsonString(html, 'book_name') ??
      (this.clean($('#book_name').text()) || 'Untitled');
    const author = this.jsonString(html, 'authors_zh');
    const summary = this.jsonString(html, 'description');
    const cover =
      this.jsonString(html, 'book_cover') ??
      $('meta[property="og:image"]').attr('content') ??
      $('#book_cover').attr('data-src') ??
      $('#book_cover').attr('src');
    const status = this.jsonString(html, 'last_chapter_title');

    const chapters = await this.fetchChapters(id);

    return {
      name: title,
      path: this.absolute(`/book/${id}`),
      ...(author ? { author } : {}),
      ...(summary ? { summary } : {}),
      ...(cover ? { cover: this.absolute(cover) } : {}),
      ...(status ? { status: NovelStatus.Ongoing } : {}),
      chapters,
    };
  }

  private async fetchChapters(bookId: string): Promise<Plugin.ChapterItem[]> {
    const response = await this.request(this.absolute(`/catalog/${bookId}`));
    if (!response.ok) {
      throw new Error(`TomatoMTL catalogue failed (HTTP ${response.status})`);
    }

    const catalog = await response.json();
    if (!Array.isArray(catalog)) {
      throw new Error('TomatoMTL returned an unexpected catalogue format.');
    }

    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < catalog.length; i++) {
      const item = catalog[i];
      if (!item?.id || !item?.title) continue;
      const chapterId = String(item.id);
      if (seen.has(chapterId)) continue;
      seen.add(chapterId);

      chapters.push({
        name: this.clean(String(item.title)),
        path: this.absolute(`/book/${bookId}/${chapterId}`),
        chapterNumber: i + 1,
      });
    }

    if (chapters.length === 0) {
      throw new Error('TomatoMTL returned an empty chapter catalogue.');
    }

    return chapters;
  }

  private base64Bytes(value: string): Uint8Array {
    // React Native/browser runtimes do not guarantee Node's Buffer global.
    // atob is available in LNReader's runtime and matches TomatoMTL's own
    // browser-side Base64 handling.
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private decryptChapter(html: string): string {
    const keyMatch = html.match(
      /(?:const|let|var)\s+unlock_code\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/,
    );
    const dataMatch = html.match(
      /(?:const|let|var)\s+encryptedData\s*=\s*(\{[\s\S]*?\});\s*(?:const|let|var)\s+txt_content/,
    );

    if (!keyMatch || !dataMatch) {
      throw new Error(
        'TomatoMTL did not provide encrypted chapter data. You may need to log in to TomatoMTL.',
      );
    }

    let unlockCode: string;
    try {
      unlockCode = JSON.parse(keyMatch[1]);
    } catch {
      unlockCode = keyMatch[1].slice(1, -1).replace(/\\(['\\"])/g, '$1');
    }

    const encryptedData = JSON.parse(dataMatch[1]);
    const key = this.base64Bytes(unlockCode).slice(0, 16);
    const iv = this.base64Bytes(encryptedData.iv);
    const ciphertext = this.base64Bytes(encryptedData.enc);

    let plaintext: Uint8Array;
    try {
      plaintext = cbc(key, iv).decrypt(ciphertext);
    } catch {
      throw new Error('TomatoMTL chapter decryption failed.');
    }

    // CryptoJS uses PKCS#7 padding.
    const padding = plaintext[plaintext.length - 1];
    if (!padding || padding > 16 || padding > plaintext.length) {
      throw new Error('TomatoMTL returned invalid decrypted chapter data.');
    }
    for (let i = plaintext.length - padding; i < plaintext.length; i++) {
      if (plaintext[i] !== padding) {
        throw new Error('TomatoMTL returned invalid decrypted chapter padding.');
      }
    }

    return new TextDecoder().decode(plaintext.slice(0, plaintext.length - padding));
  }

  private async translateToEnglish(text: string): Promise<string> {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) return '';

    // TomatoMTL itself performs client-side machine translation after decrypting
    // the raw chapter. We reproduce that final reader step here so LNReader gets
    // English text instead of the encrypted/raw Chinese payload.
    const chunks: string[] = [];
    let current: string[] = [];
    let length = 0;

    for (const line of lines) {
      if (current.length && length + line.length + 2 > 1200) {
        chunks.push(current.join('\n'));
        current = [];
        length = 0;
      }
      current.push(line);
      length += line.length + 1;
    }
    if (current.length) chunks.push(current.join('\n'));

    const translated: string[] = [];
    for (const chunk of chunks) {
      const url =
        'https://translate.googleapis.com/translate_a/single' +
        `?client=gtx&sl=zh-CN&tl=en&dt=t&q=${encodeURIComponent(chunk)}`;
      const response = await this.request(url, undefined, 3, 'omit');
      if (!response.ok) {
        throw new Error(`Translation service failed (HTTP ${response.status})`);
      }
      const data = await response.json();
      const result = Array.isArray(data?.[0])
        ? data[0]
            .map((part: any) => (Array.isArray(part) ? String(part[0] ?? '') : ''))
            .join('')
        : '';
      if (!result.trim()) throw new Error('Translation service returned empty text.');
      translated.push(result);
    }

    return translated.join('\n');
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.absolute(chapterPath);
    const response = await this.request(url);
    const html = await response.text();

    if (/You need to log in to read chapter content/i.test(html) ||
        /const\s+isLoggedIn\s*=\s*false/i.test(html)) {
      throw new Error(
        'TomatoMTL requires a logged-in account to read chapters. Open TomatoMTL in LNReader\'s WebView, log in, then try the chapter again.',
      );
    }

    const rawText = this.decryptChapter(html);
    if (!rawText.trim()) throw new Error('TomatoMTL returned an empty chapter.');

    const english = await this.translateToEnglish(rawText);
    if (!english.trim()) throw new Error('TomatoMTL chapter translation was empty.');

    // Preserve paragraph boundaries for LNReader's reader.
    return english
      .split(/\n+/)
      .map((line) => `<p>${this.escapeHTML(line)}</p>`)
      .join('');
  }

  private escapeHTML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  resolveUrl = (path: string) => this.absolute(path);
}

export default new TomatoMTL();
