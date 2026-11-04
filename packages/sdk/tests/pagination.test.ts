import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CursorPager, PagedResponse } from '../src/pagination';

describe('@whatsap-automat/sdk: CursorPager Async Iterable', () => {
  it('iterates through multiple pages using for await', async () => {
    const mockDatabase = [
      { id: '1', name: 'Item 1' },
      { id: '2', name: 'Item 2' },
      { id: '3', name: 'Item 3' },
      { id: '4', name: 'Item 4' },
      { id: '5', name: 'Item 5' },
    ];

    const pageSize = 2;
    const fetcher = async (cursor?: string): Promise<PagedResponse<{ id: string; name: string }>> => {
      const startIndex = cursor ? parseInt(cursor, 10) : 0;
      const items = mockDatabase.slice(startIndex, startIndex + pageSize);
      const nextIndex = startIndex + items.length;
      const hasMore = nextIndex < mockDatabase.length;

      return {
        items,
        nextCursor: hasMore ? String(nextIndex) : null,
        hasMore,
      };
    };

    const pager = new CursorPager(fetcher);
    const collected: { id: string; name: string }[] = [];

    for await (const item of pager) {
      collected.push(item);
    }

    assert.equal(collected.length, 5);
    assert.deepEqual(collected, mockDatabase);
  });

  it('collects all items with all() method up to maxItems', async () => {
    const mockDatabase = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: `Item ${i}` }));

    const fetcher = async (cursor?: string): Promise<PagedResponse<{ id: string; name: string }>> => {
      const startIndex = cursor ? parseInt(cursor, 10) : 0;
      const items = mockDatabase.slice(startIndex, startIndex + 10);
      const nextIndex = startIndex + items.length;
      const hasMore = nextIndex < mockDatabase.length;

      return {
        items,
        nextCursor: hasMore ? String(nextIndex) : null,
        hasMore,
      };
    };

    const pager = new CursorPager(fetcher);
    const items = await pager.all(25);

    assert.equal(items.length, 25);
    assert.equal(items[0]?.id, '0');
    assert.equal(items[24]?.id, '24');
  });

  it('handles empty first page gracefully', async () => {
    const fetcher = async (): Promise<PagedResponse<{ id: string }>> => {
      return { items: [], nextCursor: null, hasMore: false };
    };

    const pager = new CursorPager(fetcher);
    const items = await pager.all();
    assert.equal(items.length, 0);
  });
});
