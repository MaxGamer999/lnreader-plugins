import { Plugin } from '@/types/plugin';
import { fetchApi } from '@libs/fetch';
import { load as parseHTML } from 'cheerio';
import { NovelStatus } from '@libs/novelStatus';

class FanqieRaw implements Plugin.PluginBase {
  id = 'fanqieraw';
  name = 'Fanqie Raw';
  site = 'https://fanqienovel.com';
  version = '1.0.1';
  icon = 'src/zh/fanqieraw/icon.png';

  private readonly targetBookId = '7180279419959774247';
  private readonly englishTitle = 'In the Ice Age Apocalypse, I Hoarded Billions of Supplies';
  private readonly englishSummary =
    'Apocalypse + Rebirth + Hoarding Supplies + Survival + Infinite Space + Dark Revenge, Not a Saint.\n\n' +
    'The global Ice Age has arrived, the ice apocalypse is here, and 95% of the world\'s population has perished!\n\n' +
    'In his previous life, Zhang Yi, because of his kind heart, was killed by people he had helped. Reborn one month before the Ice Age apocalypse, Zhang Yi awakens spatial abilities and begins hoarding supplies like crazy.\n\n' +
    'Lacking supplies? He directly empties a super-mall warehouse worth tens of billions! Uncomfortable living conditions? He builds a super-secure safe house comparable to a doomsday fortress. When the apocalypse arrives, while others freeze and would give up everything for a bite to eat, Zhang Yi lives even more comfortably than before the apocalypse.\n\n' +
    'Those who betrayed him in his previous life now beg him for help, but Zhang Yi has no intention of saving them.';

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
    const match = path.match(/\/book\/(\d+)/);
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

  private async fetchDirectory(bookId: string): Promise<any> {
    const url = this.absolute('/api/reader/directory/detail') + `?bookId=${encodeURIComponent(bookId)}`;
    const response = await this.request(url);
    if (!response.ok) throw new Error(`Fanqie directory failed (HTTP ${response.status})`);
    return response.json();
  }

  private extractDirectoryItems(data: any): any[] {
    const grouped = data?.data?.chapterListWithVolume;
    if (Array.isArray(grouped)) {
      return grouped.flatMap((volume: any) => Array.isArray(volume) ? volume : []);
    }
    const flat = data?.data?.item_data_list;
    return Array.isArray(flat) ? flat : [];
  }

  private async fetchChapterContent(itemId: string): Promise<string> {
    const apiUrl =
      this.absolute('/api/reader/chapter/content') +
      `?book_id=${encodeURIComponent(this.targetBookId)}&item_id=${encodeURIComponent(itemId)}`;

    const response = await this.request(apiUrl);
    if (response.ok) {
      const data = await response.json();
      const candidates = [
        data?.data?.chapterData?.content,
        data?.data?.content,
        data?.chapterData?.content,
        data?.content,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate;
      }
    }

    const reader = await this.request(this.absolute(`/reader/${itemId}`));
    if (!reader.ok) throw new Error(`Fanqie chapter failed (HTTP ${reader.status})`);

    const html = await reader.text();
    const $ = parseHTML(html);
    const paragraphs: string[] = [];
    $('.muye-reader-content p').each((_index, element) => {
      const text = $(element).text().trim();
      if (text) paragraphs.push(text);
    });
    if (paragraphs.length) return paragraphs.join('\n');

    throw new Error('Fanqie did not return readable chapter text. The source may require a session or its reader format may have changed.');
  }

  async popularNovels(): Promise<Plugin.NovelItem[]> {
    return [];
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    const page = Math.max(1, pageNo);
    const response = await this.request(
      this.absolute('/search') + `?keyword=${encodeURIComponent(searchTerm)}&page_num=${page}`,
    );
    if (!response.ok) throw new Error(`Fanqie search failed (HTTP ${response.status})`);

    const $ = parseHTML(await response.text());
    const novels: Plugin.NovelItem[] = [];
    $('a[href*="/page/"]').each((_index, element) => {
      const href = $(element).attr('href') ?? '';
      const match = href.match(/\/page\/(\d+)/);
      const name = $(element).text().replace(/\s+/g, ' ').trim();
      if (!match || !name) return;
      const path = this.absolute(`/page/${match[1]}`);
      if (!novels.some((item) => item.path === path)) {
        novels.push({
          name: match[1] === this.targetBookId ? this.englishTitle : name,
          path,
        });
      }
    });
    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const id = this.bookId(novelPath);
    const directory = await this.fetchDirectory(id);
    const items = this.extractDirectoryItems(directory);
    if (!items.length) throw new Error('Fanqie returned an empty chapter directory.');

    const bookInfo = directory?.data?.book_info ?? directory?.data?.bookInfo;
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
    const author = String(bookInfo?.author ?? bookInfo?.author_name ?? '').trim();
    const summary = String(bookInfo?.abstract ?? bookInfo?.book_abstract_v2 ?? bookInfo?.description ?? '').trim();
    const cover = String(bookInfo?.thumb_url ?? bookInfo?.book_cover ?? '').trim();

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

    const text = this.cleanChapterText(await this.fetchChapterContent(match[1]));
    if (!text) throw new Error('Fanqie returned an empty chapter.');

    // Preserve normal paragraph separation. LNReader's reader controls
    // line height and paragraph spacing, so we use <p> for each source
    // paragraph instead of forcing everything into one continuous block.
    const paragraphs = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${this.escapeHtml(line)}</p>`);
    return `<div>${paragraphs.join('')}</div>`;
  }

  resolveUrl = (path: string) => path;
}

export default new FanqieRaw();
