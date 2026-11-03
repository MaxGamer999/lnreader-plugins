import { Plugin } from '@/types/plugin';
import { fetchApi } from '@libs/fetch';
import { load as parseHTML } from 'cheerio';
import { NovelStatus } from '@libs/novelStatus';

class FanqieRaw implements Plugin.PluginBase {
  id = 'fanqieraw';
  name = 'Fanqie Raw';
  site = 'https://fanqienovel.com';
  version = '1.0.4';
  icon = 'src/zh/fanqieraw/icon.png';

  private readonly targetBookId = '7180279419959774247';
  private readonly englishTitle = 'In the Ice Age Apocalypse, I Hoarded Billions of Supplies';
  private readonly englishSummary =
    'Apocalypse + Rebirth + Hoarding Supplies + Survival + Infinite Space + Dark Revenge, Not a Saint.\n\n' +
    'The global Ice Age has arrived, the ice apocalypse is here, and 95% of the world\'s population has perished!\n\n' +
    'In his previous life, Zhang Yi, because of his kind heart, was killed by people he had helped. Reborn one month before the Ice Age apocalypse, Zhang Yi awakens spatial abilities and begins hoarding supplies like crazy.\n\n' +
    'Lacking supplies? He directly empties a super-mall warehouse worth tens of billions! Uncomfortable living conditions? He builds a super-secure safe house comparable to a doomsday fortress. When the apocalypse arrives, while others freeze and would give up everything for a bite to eat, Zhang Yi lives even more comfortably than before the apocalypse.\n\n' +
    'Those who betrayed him in his previous life now beg him for help, but Zhang Yi has no intention of saving them.';

  // Headers that make requests look like the normal Fanqie website.
  private readonly browserHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://fanqienovel.com/',
  };

  // Optional: paste a direct image URL here to force the cover of the main novel.
  private readonly coverOverride = '';

  private absolute(path: string): string {
    return new URL(path, this.site).toString();
  }

  private async request(url: string, init?: Parameters<typeof fetchApi>[1], retries = 4): Promise<Response> {
    let lastStatus = 0;
    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchApi(url, { credentials: 'omit', ...init });
        if (response.ok) return response;
        lastStatus = response.status;
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) return response;
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < retries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
      }
    }
    if (lastError) throw lastError;
    throw new Error(`Fanqie request failed after ${retries} attempts (HTTP ${lastStatus})`);
  }

  private bookId(path: string): string {
    const match = path.match(/\/(?:book|page)\/(\d+)/);
    if (!match) throw new Error(`Invalid Fanqie book path: ${path}`);
    return match[1];
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private cleanChapterText(value: string): string {
    return value
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n')
      .trim();
  }

  private async parseInitialState(html: string): Promise<any | undefined> {
    const $ = parseHTML(html);
    const scripts: string[] = [];
    $('script').each((_i, el) => {
      const content = $(el).html() || '';
      if (content.includes('__INITIAL_STATE__')) scripts.push(content);
    });
    for (const script of scripts) {
      const match = script.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:window\.|<\/script|$)/);
      if (match) {
        try { return JSON.parse(match[1]); } catch { /* try next known shape */ }
      }
      const jsonMatch = script.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*\})\s*;?$/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[1]); } catch { /* ignore malformed state */ }
      }
    }
    return undefined;
  }

  private findObjects(root: any, predicate: (value: any) => boolean): any[] {
    const found: any[] = [];
    const seen = new Set<any>();
    const visit = (value: any, depth: number) => {
      if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
      seen.add(value);
      if (predicate(value)) found.push(value);
      if (Array.isArray(value)) value.forEach((child) => visit(child, depth + 1));
      else Object.keys(value).forEach((key) => visit(value[key], depth + 1));
    };
    visit(root, 0);
    return found;
  }

  private normalizeCover(value: unknown): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return `https:${raw}`;
    return `https://p6-novel.byteimg.com/origin/${raw.replace(/^\/+/, '')}`;
  }

  private pickCover(info: any): string {
    if (!info) return '';
    const direct = [
      info.thumb_url, info.thumbUrl, info.cover, info.cover_url, info.coverUrl,
      info.book_cover, info.bookCover, info.ogImage,
    ];
    for (const candidate of direct) {
      const value = typeof candidate === 'string' ? candidate.trim() : '';
      if (/^(https?:)?\/\//i.test(value)) return this.normalizeCover(value);
    }
    return this.normalizeCover(info.thumbUri ?? info.thumb_uri ?? '');
  }

  private dropEmpty(info: any): any {
    const out: any = {};
    if (!info || typeof info !== 'object') return out;
    Object.keys(info).forEach((key) => {
      const value = info[key];
      if (value !== '' && value !== null && value !== undefined) out[key] = value;
    });
    return out;
  }

  private async fetchBookMetadata(bookId: string): Promise<any> {
    try {
      const response = await this.request(this.absolute(`/page/${bookId}`), { headers: this.browserHeaders });
      if (!response.ok) return {};
      const html = await response.text();
      const $ = parseHTML(html);
      const state = await this.parseInitialState(html);
      const candidates = this.findObjects(state, (item) =>
        String(item?.bookId ?? item?.book_id ?? '') === bookId &&
        Boolean(item.bookName || item.book_name || item.author || item.thumbUri || item.thumb_url || item.thumbUrl)
      );
      const best = candidates.sort((a, b) =>
        Number(Boolean(b.author || b.author_name)) - Number(Boolean(a.author || a.author_name)) +
        Number(Boolean(b.thumbUri || b.thumb_url || b.thumbUrl)) - Number(Boolean(a.thumbUri || a.thumb_url || a.thumbUrl))
      )[0] || {};
      const ogImage =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="og:image"]').attr('content') || '';
      const imgSrc = $('img').toArray()
        .map((el) => $(el).attr('src') || $(el).attr('data-src') || '')
        .find((src) => /novel-pic|byteimg|fqnovelpic/i.test(src)) || '';
      const found = ogImage || imgSrc;
      return { ...best, ...(found ? { ogImage: found } : {}) };
    } catch {
      return {};
    }
  }

  private async fetchDirectory(bookId: string): Promise<any> {
    const url = this.absolute('/api/reader/directory/detail') + `?bookId=${encodeURIComponent(bookId)}`;
    const response = await this.request(url);
    if (!response.ok) throw new Error(`Fanqie directory failed (HTTP ${response.status})`);
    return response.json();
  }

  private extractDirectoryItems(data: any): any[] {
    const grouped = data?.data?.chapterListWithVolume;
    if (Array.isArray(grouped)) {
      const flatten = (value: any): any[] => {
        if (Array.isArray(value)) return value.flatMap(flatten);
        if (value && typeof value === 'object' && (value.itemId || value.item_id)) return [value];
        if (value && typeof value === 'object') {
          for (const key of ['itemList', 'item_list', 'chapterList', 'chapter_list', 'items', 'chapters']) {
            if (Array.isArray(value[key])) return value[key].flatMap(flatten);
          }
        }
        return [];
      };
      return grouped.flatMap(flatten);
    }
    const flat = data?.data?.item_data_list;
    return Array.isArray(flat) ? flat : [];
  }

  // Counts Chinese characters and private-use characters (the site's font cipher).
  private readableCheck(content: string, minCjk: number): { ok: boolean; reason: string } {
    const text = content.replace(/<[^>]*>/g, '');
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const pua = (text.match(/[\ue000-\uf8ff]/g) || []).length;
    if (cjk + pua < 20) return { ok: false, reason: 'almost no text' };
    if (pua > 0 && pua / (cjk + pua) > 0.05) {
      return { ok: false, reason: 'obfuscated private-use characters (site font cipher)' };
    }
    if (cjk < minCjk) return { ok: false, reason: `only ${cjk} Chinese characters, looks like a preview` };
    return { ok: true, reason: '' };
  }

  private async fetchChapterContent(itemId: string, bookId = this.targetBookId): Promise<string> {
    const notes: string[] = [];

    const accept = (label: string, content: unknown, minCjk = 0): string | undefined => {
      if (typeof content !== 'string' || !content.trim()) {
        notes.push(`${label}: no text`);
        return undefined;
      }
      const check = this.readableCheck(content, minCjk);
      if (!check.ok) {
        notes.push(`${label}: ${check.reason}`);
        return undefined;
      }
      return content;
    };

    const getJson = async (label: string, url: string): Promise<any | undefined> => {
      try {
        const response = await this.request(url, { headers: this.browserHeaders });
        const body = await response.text();
        if (!response.ok) {
          notes.push(`${label}: HTTP ${response.status}`);
          return undefined;
        }
        if (!body.trim()) {
          notes.push(`${label}: empty reply (site wants a signed browser request)`);
          return undefined;
        }
        try {
          return JSON.parse(body);
        } catch {
          notes.push(`${label}: reply was not JSON`);
          return undefined;
        }
      } catch (error) {
        notes.push(`${label}: ${error instanceof Error ? error.message : 'request failed'}`);
        return undefined;
      }
    };

    // 1. Website reader API (needs ByteDance signatures; often returns an empty body here).
    const full = await getJson('reader/full', this.absolute('/api/reader/full') + `?itemId=${encodeURIComponent(itemId)}`);
    const fromFull = accept('reader/full', full?.data?.chapterData?.content);
    if (fromFull) return fromFull;

    // 2. Older public reader endpoint.
    const legacy = await getJson(
      'snssdk reader',
      `https://novel.snssdk.com/api/novel/reader/full/v1/?item_id=${encodeURIComponent(itemId)}`
    );
    const fromLegacy = accept(
      'snssdk reader',
      [legacy?.data?.content, legacy?.data?.chapterData?.content, legacy?.content]
        .find((value) => typeof value === 'string' && value.trim()),
      200
    );
    if (fromLegacy) return fromLegacy;

    // 3. Compatibility endpoint.
    const compat = await getJson(
      'chapter/content',
      this.absolute('/api/reader/chapter/content') +
        `?book_id=${encodeURIComponent(bookId)}&item_id=${encodeURIComponent(itemId)}`
    );
    const fromCompat = accept(
      'chapter/content',
      [compat?.data?.chapterData?.content, compat?.data?.content, compat?.chapterData?.content, compat?.content]
        .find((value) => typeof value === 'string' && value.trim())
    );
    if (fromCompat) return fromCompat;

    // 4. The reader web page itself (embedded state, then visible paragraphs).
    try {
      const reader = await this.request(this.absolute(`/reader/${itemId}`), { headers: this.browserHeaders });
      if (!reader.ok) {
        notes.push(`reader page: HTTP ${reader.status}`);
      } else {
        const html = await reader.text();
        const $ = parseHTML(html);
        const state = await this.parseInitialState(html);
        const stateContent = this.findObjects(state, (item) =>
          typeof item?.content === 'string' && item.content.trim().length > 0 &&
          (item.itemId === itemId || item.item_id === itemId || item.chapterData === item)
        )[0]?.content;
        const fromState = accept('reader page state', stateContent);
        if (fromState) return fromState;

        const paragraphs: string[] = [];
        $('.muye-reader-content p, .reader-content p, .chapter-content p, [class*="reader"] p').each((_index, element) => {
          const text = $(element).text().trim();
          if (text) paragraphs.push(text);
        });
        const fromParagraphs = accept(
          'reader page text',
          paragraphs.map((p) => `<p>${this.escapeHtml(p)}</p>`).join('')
        );
        if (fromParagraphs) return fromParagraphs;
        notes.push(`reader page title "${$('title').text().trim().slice(0, 60)}", ${html.length} bytes`);
      }
    } catch (error) {
      notes.push(`reader page: ${error instanceof Error ? error.message : 'request failed'}`);
    }

    throw new Error(`Fanqie did not return readable chapter text. ${notes.join(' | ')}`);
  }

  private contentToParagraphs(content: string): string[] {
    const $ = parseHTML(`<div id="fanqie-content">${content}</div>`);
    const root = $('#fanqie-content');
    const paragraphNodes = root.find('p');
    if (paragraphNodes.length) {
      const paragraphs: string[] = [];
      paragraphNodes.each((_i, el) => {
        const text = this.cleanChapterText($(el).text());
        if (text) paragraphs.push(text);
      });
      if (paragraphs.length) return paragraphs;
    }
    const plain = this.cleanChapterText(root.text() || content.replace(/<[^>]*>/g, '\n'));
    return plain.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async popularNovels(): Promise<Plugin.NovelItem[]> {
    let cover = this.coverOverride;
    if (!cover) {
      try {
        cover = this.pickCover(await this.fetchBookMetadata(this.targetBookId));
      } catch {
        cover = '';
      }
    }
    return [{
      name: this.englishTitle,
      path: this.absolute(`/page/${this.targetBookId}`),
      ...(cover ? { cover } : {}),
    }];
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    const query = searchTerm.trim();
    if (!query) return this.popularNovels();

    const offset = Math.max(0, pageNo - 1) * 10;
    const url =
      'https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1/' +
      `?device_platform=android&parent_enterfrom=novel_channel_search.tab.&offset=${offset}&aid=1967&q=${encodeURIComponent(query)}`;

    const response = await this.request(url);
    if (!response.ok) throw new Error(`Fanqie mobile search failed (HTTP ${response.status})`);

    const body = await response.text();
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error('Fanqie mobile search returned non-JSON data.');
    }

    const rows = data?.data?.ret_data ?? data?.ret_data ?? [];
    if (!Array.isArray(rows)) return [];

    return rows.flatMap((item: any) => {
      const id = String(item?.book_id ?? item?.bookId ?? '');
      const name = String(item?.title ?? item?.book_name ?? '').replace(/<[^>]*>/g, '').trim();
      if (!id || !name) return [];
      return [{
        name: id === this.targetBookId ? this.englishTitle : name,
        path: this.absolute(`/page/${id}`),
        ...(item?.thumb_url ? { cover: String(item.thumb_url) } : {}),
      }];
    });
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const id = this.bookId(novelPath);
    const directory = await this.fetchDirectory(id);
    const items = this.extractDirectoryItems(directory);
    if (!items.length) throw new Error('Fanqie returned an empty chapter directory.');

    let bookInfo: any = this.dropEmpty(directory?.data?.book_info ?? directory?.data?.bookInfo);
    const hasAuthor = Boolean(bookInfo.author || bookInfo.author_name || bookInfo.authorName);
    if (!this.pickCover(bookInfo) || !hasAuthor) {
      bookInfo = { ...(await this.fetchBookMetadata(id)), ...bookInfo };
    }
    const chapters: Plugin.ChapterItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemId = String(item?.itemId ?? item?.item_id ?? '');
      const title = String(item?.title ?? '').trim();
      if (!itemId || !title) continue;

      const firstPassTime = Number(item?.firstPassTime ?? item?.first_pass_time ?? 0);
      const releaseTime =
        Number.isFinite(firstPassTime) && firstPassTime > 0
          ? new Date(firstPassTime * 1000).toISOString()
          : undefined;

      const chapterNumber = Number(
        item?.realChapterOrder ?? item?.chapter_index ?? item?.sort_order ?? (i + 1),
      );

      chapters.push({
        name: title,
        path: this.absolute(`/reader/${itemId}`),
        chapterNumber: Number.isFinite(chapterNumber) ? chapterNumber : i + 1,
        ...(releaseTime ? { releaseTime } : {}),
      });
    }

    const rawTitle = String(bookInfo?.book_name ?? bookInfo?.bookName ?? '').trim();
    const author = String(bookInfo?.author ?? bookInfo?.author_name ?? bookInfo?.authorName ?? '').trim();
    const summary = String(bookInfo?.abstract ?? bookInfo?.book_abstract_v2 ?? bookInfo?.description ?? bookInfo?.bookAbstract ?? '').trim();
    const cover = (id === this.targetBookId && this.coverOverride) || this.pickCover(bookInfo);

    return {
      path: this.absolute(`/page/${id}`),
      name: id === this.targetBookId ? this.englishTitle : (rawTitle || 'Fanqie Novel'),
      ...(author ? { author } : {}),
      summary: id === this.targetBookId ? this.englishSummary : summary,
      ...(cover ? { cover } : {}),
      status: NovelStatus.Ongoing,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const match = chapterPath.match(/\/reader\/(\d+)/);
    if (!match) throw new Error(`Invalid Fanqie chapter path: ${chapterPath}`);
    const bookMatch = chapterPath.match(/[?&]bookId=(\d+)/);
    const content = await this.fetchChapterContent(match[1], bookMatch?.[1] || this.targetBookId);
    const paragraphs = this.contentToParagraphs(content);
    if (!paragraphs.length) throw new Error('Fanqie returned an empty chapter.');
    return `<div>${paragraphs.map((paragraph) => `<p>${this.escapeHtml(paragraph)}</p>`).join('')}</div>`;
  }

  resolveUrl = (path: string) => path;
}

export default new FanqieRaw();
