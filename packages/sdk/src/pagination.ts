export interface PagedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type PageFetcher<T> = (cursor?: string) => Promise<PagedResponse<T>>;

export class CursorPager<T> implements AsyncIterable<T> {
  private readonly fetcher: PageFetcher<T>;
  private currentCursor: string | null = null;
  private hasMorePages = true;
  private buffer: T[] = [];

  constructor(fetcher: PageFetcher<T>, initialCursor?: string) {
    this.fetcher = fetcher;
    this.currentCursor = initialCursor ?? null;
  }

  async nextPage(): Promise<PagedResponse<T>> {
    if (!this.hasMorePages) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const page = await this.fetcher(this.currentCursor ?? undefined);
    this.currentCursor = page.nextCursor;
    this.hasMorePages = page.hasMore && Boolean(page.nextCursor);
    return page;
  }

  async all(maxItems = 10000): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this) {
      results.push(item);
      if (results.length >= maxItems) break;
    }
    return results;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (this.hasMorePages || this.buffer.length > 0) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }

      if (!this.hasMorePages) {
        break;
      }

      const page = await this.nextPage();
      this.buffer = [...page.items];

      if (this.buffer.length === 0 && !this.hasMorePages) {
        break;
      }
    }
  }
}
