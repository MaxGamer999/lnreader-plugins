import { Plugin } from '@/types/plugin';
import { fetchApi } from '@libs/fetch';
import { CheerioAPI, load as parseHTML } from 'cheerio';
import { NovelStatus } from '@libs/novelStatus';
import { cbc } from '@noble/ciphers/aes.js';
import { storage } from '@libs/storage';

class TomatoMTL implements Plugin.PluginBase {
  id = 'tomatomtl';
  name = 'TomatoMTL';
  site = 'https://tomatomtl.com';
  version = '1.0.8';
  icon = 'src/en/tomatomtl/icon.png';
  // TomatoMTL uses browser storage for its catalogue cache. Keeping this flag
  // enabled also makes the source compatible with LNReader's web-backed flow.
  webStorageUtilized = true;

  private chapterQueue: Promise<void> = Promise.resolve();
  private lastChapterFinishedAt = 0;
  private tomatoGoogleHtmlKey: string | null = null;
  private tomatoGoogleContentKey: string | null = null;
  private tomatoGoogleKeyPromise: Promise<void> | null = null;

  private readonly targetBookId = '7180279419959774247';
  private readonly englishTitle = 'In the Ice Age Apocalypse, I Hoarded Billions of Supplies';
  private readonly englishSummary =
    'Apocalypse + Rebirth + Hoarding Supplies + Survival + Infinite Space + Dark Revenge, Not a Saint.\n\n' +
    'The global Ice Age has arrived, the ice apocalypse is here, and 95% of the world\'s population has perished!\n\n' +
    'In his previous life, Zhang Yi, because of his kind heart, was killed by people he had helped. Reborn one month before the Ice Age apocalypse, Zhang Yi awakens spatial abilities and begins hoarding supplies like crazy.\n\n' +
    'Lacking supplies? He directly empties a super-mall warehouse worth tens of billions! Uncomfortable living conditions? He builds a super-secure safe house comparable to a doomsday fortress. When the apocalypse arrives, while others freeze and would give up everything for a bite to eat, Zhang Yi lives even more comfortably than before the apocalypse.\n\n' +
    'Those who betrayed him in his previous life now beg him for help, but Zhang Yi has no intention of saving them.';

  private readonly chapterTitleCacheKey = `tomatomtl.en.chapterTitles.${this.targetBookId}`;
  private readonly metadataCacheKey = `tomatomtl.en.metadata.${this.targetBookId}`;
  private readonly fanqieReleaseTimesCacheKey = `tomatomtl.fanqie.releaseTimes.${this.targetBookId}`;

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
    let lastRetryAfter: string | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchApi(url, {
          credentials,
          ...init,
        });
        if (response.ok) return response;

        lastStatus = response.status;
        lastRetryAfter = response.headers?.get?.('Retry-After') ?? null;
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
          return response;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt + 1 < retries) {
        let delayMs = Math.min(750 * 2 ** attempt, 6000);
        if (lastStatus === 429) {
          const retryAfter = lastRetryAfter;
          if (retryAfter) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds)) {
              delayMs = Math.min(Math.max(seconds * 1000, 1500), 60000);
            } else {
              const dateMs = Date.parse(retryAfter) - Date.now();
              if (Number.isFinite(dateMs) && dateMs > 0) {
                delayMs = Math.min(Math.max(dateMs, 1500), 60000);
              }
            }
          } else {
            delayMs = Math.min(5000 * 2 ** attempt, 60000);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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
        name:
          String(book.book_id) === this.targetBookId
            ? this.englishTitle
            : String(book.book_name),
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

    const rawTitle =
      this.jsonString(html, 'book_name') ??
      (this.clean($('#book_name').text()) || 'Untitled');
    const author = this.jsonString(html, 'authors_zh');
    const rawSummary = this.jsonString(html, 'description');
    const title = id === this.targetBookId ? this.englishTitle : rawTitle;
    const summary = id === this.targetBookId ? this.englishSummary : rawSummary;
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

  /**
   * Fanqie exposes the original chapter publication timestamp as
   * `firstPassTime` (Unix seconds) in its directory response. TomatoMTL's
   * catalogue does not expose that field, so we retrieve the metadata from
   * Fanqie and attach it to the corresponding LNReader ChapterItem.
   *
   * This is deliberately best-effort: if Fanqie is unavailable, TomatoMTL
   * chapters still load normally without release dates.
   */
  private async fetchFanqieReleaseTimes(
    bookId: string,
  ): Promise<Record<string, string>> {
    if (bookId !== this.targetBookId) return {};

    const cached = this.readJsonStorage<{
      fetchedAt: number;
      releaseTimes: Record<string, string>;
    } | null>(this.fanqieReleaseTimesCacheKey, null);
    if (
      cached &&
      cached.fetchedAt > 0 &&
      Date.now() - cached.fetchedAt < 30 * 60 * 1000 &&
      Object.keys(cached.releaseTimes).length > 0
    ) {
      return cached.releaseTimes;
    }

    try {
      const url = `https://fanqienovel.com/api/reader/directory/detail?bookId=${encodeURIComponent(bookId)}`;
      const response = await this.request(url, undefined, 3, 'omit');
      if (!response.ok) {
        console.warn(`Fanqie directory metadata failed (HTTP ${response.status})`);
        return {};
      }

      const data = await response.json();
      const volumes = data?.data?.chapterListWithVolume;
      if (!Array.isArray(volumes)) return {};

      const releaseTimes: Record<string, string> = {};

      for (const volume of volumes) {
        if (!Array.isArray(volume)) continue;
        for (const item of volume) {
          const firstPassTime = Number(item?.firstPassTime);
          if (!item?.itemId || !Number.isFinite(firstPassTime) || firstPassTime <= 0) {
            continue;
          }

          const iso = new Date(firstPassTime * 1000).toISOString();
          const itemId = String(item.itemId);
          releaseTimes[`id:${itemId}`] = iso;

          const title = this.clean(String(item.title ?? ''));
          if (title) releaseTimes[`title:${title}`] = iso;

          const order = String(item.realChapterOrder ?? '');
          if (order) releaseTimes[`order:${order}`] = iso;

          const chapterMatch = title.match(/第\s*(\d+)\s*章/);
          if (chapterMatch) {
            releaseTimes[`chapter:${chapterMatch[1]}`] = iso;
          }
        }
      }

      if (Object.keys(releaseTimes).length > 0) {
        this.writeJsonStorage(this.fanqieReleaseTimesCacheKey, {
          fetchedAt: Date.now(),
          releaseTimes,
        });
      }

      return releaseTimes;
    } catch (error) {
      console.warn('Unable to retrieve Fanqie chapter release times:', error);
      return {};
    }
  }

  private getChapterReleaseTime(
    item: any,
    releaseTimes: Record<string, string>,
    chapterNumber: number,
  ): string | undefined {
    const id = item?.id ? releaseTimes[`id:${String(item.id)}`] : undefined;
    if (id) return id;

    const title = this.clean(String(item?.title ?? ''));
    const byTitle = title ? releaseTimes[`title:${title}`] : undefined;
    if (byTitle) return byTitle;

    const chapterMatch = title.match(/第\s*(\d+)\s*章/);
    if (chapterMatch) {
      const byChapter = releaseTimes[`chapter:${chapterMatch[1]}`];
      if (byChapter) return byChapter;
    }

    return releaseTimes[`order:${chapterNumber}`];
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

    // Fetch the Fanqie timestamps before constructing the final chapter list.
    // The timestamp is mapped by Fanqie itemId first, then by exact title, and
    // finally by chapter number as a compatibility fallback.
    const releaseTimes = await this.fetchFanqieReleaseTimes(bookId);

    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < catalog.length; i++) {
      const item = catalog[i];
      if (!item?.id || !item?.title) continue;
      const chapterId = String(item.id);
      if (seen.has(chapterId)) continue;
      seen.add(chapterId);

      const chapterNumber = i + 1;
      const releaseTime = this.getChapterReleaseTime(
        item,
        releaseTimes,
        chapterNumber,
      );

      chapters.push({
        name: this.clean(String(item.title)),
        path: this.absolute(`/book/${bookId}/${chapterId}`),
        chapterNumber,
        ...(releaseTime ? { releaseTime } : {}),
      });
    }

    if (chapters.length === 0) {
      throw new Error('TomatoMTL returned an empty chapter catalogue.');
    }

    if (bookId === this.targetBookId) {
      const titles = chapters.map((chapter) => chapter.name);
      const translated = await this.translateChapterTitles(titles);
      for (let i = 0; i < chapters.length; i++) {
        chapters[i].name = translated[i] || chapters[i].name;
      }
    }

    return chapters;
  }

  private readJsonStorage<T>(key: string, fallback: T): T {
    try {
      const value = storage.get(key);
      if (!value) return fallback;
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private writeJsonStorage<T>(key: string, value: T): void {
    try {
      storage.set(key, JSON.stringify(value));
    } catch {
      // Metadata caching is an optimization; failure must not break the source.
    }
  }

  /**
   * TomatoMTL does not use the public translate_a/single endpoint for chapter
   * text. It uses Google's translate-pa /v1/translate endpoint. The API key
   * is already part of TomatoMTL's public client-side JavaScript, so we fetch
   * that script at runtime instead of copying the key into this plugin.
   *
   * This keeps the plugin aligned with TomatoMTL's own translator while
   * avoiding a hard-coded API key in the open-source plugin source.
   */
  private async loadTomatoGoogleKeys(forceRefresh = false): Promise<void> {
    if (!forceRefresh && this.tomatoGoogleHtmlKey && this.tomatoGoogleContentKey) {
      return;
    }
    if (!forceRefresh && this.tomatoGoogleKeyPromise) {
      return this.tomatoGoogleKeyPromise;
    }

    this.tomatoGoogleKeyPromise = (async () => {
      const response = await this.request(
        this.absolute('/assets/js/tomato.js'),
        undefined,
        4,
        'omit',
      );
      if (!response.ok) {
        throw new Error(`TomatoMTL translator configuration failed (HTTP ${response.status})`);
      }

      const script = await response.text();

      // Key used by TomatoMTL's translateHtml calls for titles/metadata.
      const htmlMatch = script.match(
        /['"]x-goog-api-key['"]\s*:\s*['"]([^'"]+)['"]/,
      );

      // Key used by TomatoMTL's chapter-content translate-pa /v1/translate
      // helper (fetchTranslateGoogle1).
      const contentMatch = script.match(
        /fetchTranslateGoogle1[\s\S]{0,1200}?apiKey\s*=\s*['"]([^'"]+)['"]/
      );

      if (!htmlMatch?.[1] || !contentMatch?.[1]) {
        throw new Error('TomatoMTL Google translation configuration could not be detected.');
      }

      this.tomatoGoogleHtmlKey = htmlMatch[1];
      this.tomatoGoogleContentKey = contentMatch[1];
    })();

    try {
      await this.tomatoGoogleKeyPromise;
    } finally {
      this.tomatoGoogleKeyPromise = null;
    }
  }

  private async translateText(text: string, maxRetries = 3): Promise<string> {
    await this.loadTomatoGoogleKeys();

    const buildUrl = (key: string) =>
      'https://translate-pa.googleapis.com/v1/translate' +
      '?params.client=gtx' +
      '&query.source_language=zh-CN' +
      '&query.target_language=en' +
      '&query.display_language=en-US' +
      '&data_types=TRANSLATION' +
      `&key=${encodeURIComponent(key)}` +
      `&query.text=${encodeURIComponent(text)}` +
      '&data_types=1';

    let response = await this.request(
      buildUrl(this.tomatoGoogleContentKey!),
      undefined,
      maxRetries,
      'omit',
    );

    // If TomatoMTL rotated its public client key, refresh the script once and
    // retry. This avoids permanently caching an expired key in a long session.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await this.loadTomatoGoogleKeys(true);
      response = await this.request(
        buildUrl(this.tomatoGoogleContentKey!),
        undefined,
        maxRetries,
        'omit',
      );
    }

    if (!response.ok) {
      throw new Error(`Translation service failed (HTTP ${response.status})`);
    }

    const data = await response.json();
    const result = typeof data?.translation === 'string' ? data.translation : '';
    if (!result.trim()) throw new Error('Translation service returned empty text.');
    return result.trim();
  }

  private async translateHtmlTexts(texts: string[], maxRetries = 3): Promise<string[]> {
    if (texts.length === 0) return [];
    await this.loadTomatoGoogleKeys();

    const body = JSON.stringify([[[...texts], 'zh-CN', 'en'], 'te']);
    const headers = {
      'Content-Type': 'application/json+protobuf',
      'x-goog-api-key': this.tomatoGoogleHtmlKey!,
    };

    let response = await this.request(
      'https://translate-pa.googleapis.com/v1/translateHtml',
      { method: 'POST', headers, body },
      maxRetries,
      'omit',
    );

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await this.loadTomatoGoogleKeys(true);
      response = await this.request(
        'https://translate-pa.googleapis.com/v1/translateHtml',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json+protobuf',
            'x-goog-api-key': this.tomatoGoogleHtmlKey!,
          },
          body,
        },
        maxRetries,
        'omit',
      );
    }

    if (!response.ok) {
      throw new Error(`Translation service failed (HTTP ${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data?.[0])) {
      throw new Error('Translation service returned an unexpected response.');
    }

    return data[0].map((value: unknown) => String(value ?? '').trim());
  }

  private async translateChapterTitles(titles: string[]): Promise<string[]> {
    const cached = this.readJsonStorage<Record<string, string>>(this.chapterTitleCacheKey, {});
    const result = titles.map((title) => cached[title] || '');
    const missingIndexes = titles
      .map((title, index) => (!cached[title] ? index : -1))
      .filter((index) => index >= 0);

    // TomatoMTL translates chapter titles through translateHtml. We batch a
    // modest number of titles per request to avoid thousands of requests while
    // keeping the same translation engine.
    const batchSize = 20;
    for (let start = 0; start < missingIndexes.length; start += batchSize) {
      const indexes = missingIndexes.slice(start, start + batchSize);
      try {
        const translated = await this.translateHtmlTexts(indexes.map((index) => titles[index]), 4);
        if (translated.length === indexes.length) {
          for (let i = 0; i < indexes.length; i++) {
            const value = translated[i];
            if (value) {
              cached[titles[indexes[i]]] = value;
              result[indexes[i]] = value;
            }
          }
        }
      } catch {
        // Keep the original Chinese title for a failed batch. The chapter
        // itself remains fully downloadable and translatable.
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    this.writeJsonStorage(this.chapterTitleCacheKey, cached);
    return result.map((value, index) => value || titles[index]);
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

  // TomatoMTL uses AES-128-CBC with PKCS#7 padding. LNReader's Android
  // runtime can occasionally have trouble executing the bundled AES primitive,
  // so this plugin keeps a small pure-TypeScript AES-128 fallback. We first use
  // the normal @noble/ciphers implementation and fall back only if its output
  // is invalid. This avoids relying on a native/WebCrypto implementation.
  private aesSBox = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
  ]);

  private aesInvSBox = (() => {
    const inv = new Uint8Array(256);
    for (let i = 0; i < 256; i++) inv[this.aesSBox[i]] = i;
    return inv;
  })();

  private aesRcon = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54];

  private aesExpandKey(key: Uint8Array): Uint8Array {
    const expanded = new Uint8Array(176);
    expanded.set(key);
    let generated = 16;
    let round = 1;
    while (generated < 176) {
      let temp = [
        expanded[generated - 4],
        expanded[generated - 3],
        expanded[generated - 2],
        expanded[generated - 1],
      ];
      if (generated % 16 === 0) {
        temp = [temp[1], temp[2], temp[3], temp[0]];
        temp = temp.map((value) => this.aesSBox[value]);
        temp[0] ^= this.aesRcon[round++];
      }
      for (let i = 0; i < 4; i++) {
        expanded[generated] = expanded[generated - 16] ^ temp[i];
        generated++;
      }
    }
    return expanded;
  }

  private aesMul(a: number, b: number): number {
    let result = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) result ^= a;
      const high = a & 0x80;
      a = (a << 1) & 0xff;
      if (high) a ^= 0x1b;
      b >>>= 1;
    }
    return result;
  }

  private aesDecryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
    const expanded = this.aesExpandKey(key);
    const state = Uint8Array.from(block);

    const addRoundKey = (round: number) => {
      const offset = round * 16;
      for (let i = 0; i < 16; i++) state[i] ^= expanded[offset + i];
    };

    const invShiftRows = () => {
      const copy = state.slice();
      for (let row = 1; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          state[4 * col + row] = copy[4 * ((col - row + 4) % 4) + row];
        }
      }
    };

    const invSubBytes = () => {
      for (let i = 0; i < 16; i++) state[i] = this.aesInvSBox[state[i]];
    };

    const invMixColumns = () => {
      for (let col = 0; col < 4; col++) {
        const i = col * 4;
        const a0 = state[i];
        const a1 = state[i + 1];
        const a2 = state[i + 2];
        const a3 = state[i + 3];
        state[i] = this.aesMul(a0, 14) ^ this.aesMul(a1, 11) ^ this.aesMul(a2, 13) ^ this.aesMul(a3, 9);
        state[i + 1] = this.aesMul(a0, 9) ^ this.aesMul(a1, 14) ^ this.aesMul(a2, 11) ^ this.aesMul(a3, 13);
        state[i + 2] = this.aesMul(a0, 13) ^ this.aesMul(a1, 9) ^ this.aesMul(a2, 14) ^ this.aesMul(a3, 11);
        state[i + 3] = this.aesMul(a0, 11) ^ this.aesMul(a1, 13) ^ this.aesMul(a2, 9) ^ this.aesMul(a3, 14);
      }
    };

    addRoundKey(10);
    for (let round = 9; round >= 1; round--) {
      invShiftRows();
      invSubBytes();
      addRoundKey(round);
      invMixColumns();
    }
    invShiftRows();
    invSubBytes();
    addRoundKey(0);
    return state;
  }

  private aesCbcDecrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
    if (key.length !== 16 || iv.length !== 16 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
      throw new Error('Invalid AES-128-CBC data.');
    }
    const plaintext = new Uint8Array(ciphertext.length);
    let previous = iv;
    for (let offset = 0; offset < ciphertext.length; offset += 16) {
      const block = ciphertext.slice(offset, offset + 16);
      const decrypted = this.aesDecryptBlock(block, key);
      for (let i = 0; i < 16; i++) plaintext[offset + i] = decrypted[i] ^ previous[i];
      previous = block;
    }
    return plaintext;
  }

  private validPkcs7(bytes: Uint8Array): boolean {
    if (bytes.length === 0) return false;
    const padding = bytes[bytes.length - 1];
    if (padding < 1 || padding > 16 || padding > bytes.length) return false;
    for (let i = bytes.length - padding; i < bytes.length; i++) {
      if (bytes[i] !== padding) return false;
    }
    return true;
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

    let plaintext: Uint8Array | undefined;

    // Prefer noble-ciphers, then use the pure-JS implementation if the Android
    // runtime rejects the cipher operation or produces invalid PKCS#7 padding.
    try {
      const candidate = cbc(key, iv).decrypt(ciphertext);
      if (this.validPkcs7(candidate)) plaintext = candidate;
    } catch {
      // Fall through to the runtime-independent AES implementation below.
    }

    if (!plaintext) {
      try {
        const candidate = this.aesCbcDecrypt(ciphertext, key, iv);
        if (this.validPkcs7(candidate)) plaintext = candidate;
      } catch {
        // handled below
      }
    }

    if (!plaintext) throw new Error('TomatoMTL chapter decryption failed.');

    const padding = plaintext[plaintext.length - 1];
    const content = plaintext.slice(0, plaintext.length - padding);
    try {
      return new TextDecoder().decode(content);
    } catch {
      throw new Error('TomatoMTL decrypted the chapter but could not decode its text.');
    }
  }

  /**
   * Reproduce TomatoMTL's current Google chapter-translation pipeline as
   * closely as possible.
   *
   * TomatoMTL does NOT simply translate the decrypted string as-is. Its
   * client first removes blank lines, rejoins paragraphs with double newlines,
   * splits with the same line-aware 1000-character helper, then sends each
   * chunk to /v1/translate. It also retries translation when Google leaves a
   * run of source lines unchanged.
   */
  private splitTomatoText(text: string, maxLength: number): string[] {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
      const separator = current ? '\n' : '';
      if (current.length + separator.length + line.length < maxLength) {
        current += separator + line;
      } else {
        if (current) chunks.push(current);
        current = line;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  private async translateTomatoGoogle1(text: string, maxRetries = 3): Promise<string> {
    // TomatoMTL's translateGoogle1() converts each paragraph separator to a
    // double newline before calling fetchTranslateGoogle1().
    const input = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .join('\n\n');

    if (!input.trim()) return '';
    return this.translateText(input, maxRetries);
  }

  private normalizeTranslationLines(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  private findUntranslatedRuns(sourceLines: string[], translatedLines: string[]) {
    const runs: Array<{ start: number; end: number }> = [];
    const total = Math.min(sourceLines.length, translatedLines.length);
    let start = -1;

    for (let i = 0; i < total; i++) {
      const unchanged = sourceLines[i] !== '' && sourceLines[i] === translatedLines[i];
      if (unchanged) {
        if (start === -1) start = i;
        continue;
      }

      if (start !== -1) {
        if (i - start >= 3) runs.push({ start, end: i });
        start = -1;
      }
    }

    if (start !== -1 && total - start >= 3) {
      runs.push({ start, end: total });
    }

    return runs;
  }

  private async retranslateUntranslatedRun(
    sourceLines: string[],
  ): Promise<string[]> {
    if (sourceLines.length === 0) return [];

    const translated = await this.translateTomatoGoogle1(sourceLines.join('\n'), 3);
    const lines = this.normalizeTranslationLines(translated);

    if (lines.length === sourceLines.length) return lines;

    if (sourceLines.length === 1) {
      return lines.length ? [lines.join(' ')] : [''];
    }

    const mid = Math.floor(sourceLines.length / 2);
    const [left, right] = await Promise.all([
      this.retranslateUntranslatedRun(sourceLines.slice(0, mid)),
      this.retranslateUntranslatedRun(sourceLines.slice(mid)),
    ]);
    return [...left, ...right];
  }

  private async repairTomatoUntranslatedRuns(
    sourceText: string,
    translatedText: string,
  ): Promise<string> {
    const sourceLines = this.normalizeTranslationLines(sourceText);
    const translatedLines = this.normalizeTranslationLines(translatedText);

    if (sourceLines.length === 0 || translatedLines.length !== sourceLines.length) {
      return translatedText;
    }

    const repaired = [...translatedLines];
    const runs = this.findUntranslatedRuns(sourceLines, translatedLines);

    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      const original = sourceLines.slice(run.start, run.end);
      const retried = await this.retranslateUntranslatedRun(original);
      if (retried.length === original.length) {
        repaired.splice(run.start, original.length, ...retried);
      }
    }

    return repaired.join('\n');
  }

  private async translateToEnglish(text: string): Promise<string> {
    const filteredInput = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .join('\n\n');

    if (!filteredInput.trim()) return '';

    const chunks = this.splitTomatoText(filteredInput, 1000);
    const translatedChunks = await Promise.all(
      chunks.map((chunk) => this.translateTomatoGoogle1(chunk, 3)),
    );

    const translated = translatedChunks.join('\n');
    if (!translated.trim()) {
      throw new Error('Translation service returned empty text.');
    }

    return this.repairTomatoUntranslatedRuns(filteredInput, translated);
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const run = async () => {
      const now = Date.now();
      const spacing = 1500 - (now - this.lastChapterFinishedAt);
      if (spacing > 0) await new Promise((resolve) => setTimeout(resolve, spacing));

      try {
        return await this.parseChapterNow(chapterPath);
      } finally {
        this.lastChapterFinishedAt = Date.now();
      }
    };

    const previous = this.chapterQueue;
    let release!: () => void;
    this.chapterQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  private async parseChapterNow(chapterPath: string): Promise<string> {
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
