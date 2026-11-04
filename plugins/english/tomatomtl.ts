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
  version = '1.0.10';
  icon = 'src/en/tomatomtl/icon.png';
  // TomatoMTL uses browser storage for its catalogue cache. Keeping this flag
  // enabled also makes the source compatible with LNReader's web-backed flow.
  webStorageUtilized = true;

  // Editable inside LN Reader: Settings icon on the TomatoMTL source page.
  // These mirror TomatoMTL's own "Glossary" (applied before translation) and
  // "Replacement" (applied after translation) features, which live in the
  // website account/browser and so can't be read by the plugin.
  pluginSettings = {
    glossary: {
      value: '',
      label:
        'Glossary, applied BEFORE translation. One per line: 中文=English',
      type: 'Text' as const,
    },
    replacements: {
      value: '',
      label:
        'Replacements, applied AFTER translation. One per line: found=>replacement',
      type: 'Text' as const,
    },
    engine: {
      value: '',
      label:
        'Translation engine. Leave empty or type 2 for TomatoMTL "Google Translate engine 2" (site default). Type 1 for "engine 1".',
      type: 'Text' as const,
    },
    chunkSize: {
      value: '',
      label:
        'Engine 2 chunk size in characters (empty = 4000). Lower it only if translations look cut off.',
      type: 'Text' as const,
    },
  };

  // Built-in rules, same formats as the settings above. Add permanent entries
  // here if you prefer to keep them in the repo, e.g.
  //   builtInGlossary = [['张毅', 'Zhang Yi']];
  //   builtInReplacements = [['Zhang Yi\'s', 'Zhang Yi’s']];
  private readonly builtInGlossary: Array<[string, string]> = [];
  private readonly builtInReplacements: Array<[string, string]> = [];

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

  private readEngine(): 1 | 2 {
    const value = this.readSetting('engine').trim().toLowerCase();
    return value === '1' || value === 'google1' || value === 'engine 1' ? 1 : 2;
  }

  private readChunkSize(): number {
    if (this.readEngine() === 1) return 1000;
    const value = Number(this.readSetting('chunkSize').trim());
    if (Number.isFinite(value) && value >= 500 && value <= 4500) return Math.floor(value);
    return 4000;
  }

  /**
   * TomatoMTL's default engine on the website is "Google Translate engine 2"
   * (the `google` option of its translator menu). It posts the text as a form
   * to Google's translate_a/t endpoint and needs no API key. The answer is
   * ["text"] or [["text","zh-CN"]].
   */
  private async translateEngine2(text: string, maxRetries = 3): Promise<string> {
    const response = await this.request(
      'https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex&sl=zh-CN&tl=en',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: '*/*',
          Referer: 'https://tomatomtl.com/translate',
          Origin: 'https://tomatomtl.com',
        },
        body: `q=${encodeURIComponent(text)}`,
      },
      maxRetries,
      'omit',
    );

    if (!response.ok) {
      throw new Error(`Translation service failed (HTTP ${response.status})`);
    }

    const body = (await response.text()).trim();
    if (!body || body.startsWith('<')) {
      throw new Error('Translation service did not return a translation.');
    }

    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error('Translation service sent an unreadable answer.');
    }

    let result = '';
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') result += item;
        else if (Array.isArray(item) && typeof item[0] === 'string') result += item[0];
      }
    }
    if (!result.trim()) throw new Error('Translation service returned empty text.');
    return result.trim();
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
    cons
