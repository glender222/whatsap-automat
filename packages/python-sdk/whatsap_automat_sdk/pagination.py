"""
Cursor-based pagination helpers for Whatsap-Automat SDK.
Provides synchronous CursorPager and asynchronous AsyncCursorPager.
"""

from __future__ import annotations

from typing import (
    AsyncIterator,
    Awaitable,
    Callable,
    Generic,
    Iterator,
    List,
    Optional,
    TypeVar,
)
from .models import PagedResponse

T = TypeVar("T")

SyncPageFetcher = Callable[[Optional[str]], PagedResponse[T]]
AsyncPageFetcher = Callable[[Optional[str]], Awaitable[PagedResponse[T]]]


class CursorPager(Generic[T]):
    """
    Synchronous cursor-based paginator implementing Iterator[T].
    Enables `for item in pager:` and `.all(max_items=...)`.
    """

    def __init__(self, fetcher: SyncPageFetcher[T], initial_cursor: Optional[str] = None):
        self._fetcher = fetcher
        self._current_cursor = initial_cursor
        self._has_more_pages = True
        self._buffer: List[T] = []

    def next_page(self) -> PagedResponse[T]:
        """Fetch the next page of results."""
        if not self._has_more_pages:
            return PagedResponse(items=[], next_cursor=None, has_more=False)

        page = self._fetcher(self._current_cursor)
        self._current_cursor = page.next_cursor
        self._has_more_pages = page.has_more and bool(page.next_cursor)
        return page

    def all(self, max_items: int = 10000) -> List[T]:
        """Collect all items across pages up to max_items."""
        results: List[T] = []
        for item in self:
            results.append(item)
            if len(results) >= max_items:
                break
        return results

    def __iter__(self) -> Iterator[T]:
        return self

    def __next__(self) -> T:
        while True:
            if self._buffer:
                return self._buffer.pop(0)

            if not self._has_more_pages:
                raise StopIteration

            page = self.next_page()
            self._buffer.extend(page.items)

            if not self._buffer and not self._has_more_pages:
                raise StopIteration


class AsyncCursorPager(Generic[T]):
    """
    Asynchronous cursor-based paginator implementing AsyncIterator[T].
    Enables `async for item in pager:` and `await pager.all(max_items=...)`.
    """

    def __init__(self, fetcher: AsyncPageFetcher[T], initial_cursor: Optional[str] = None):
        self._fetcher = fetcher
        self._current_cursor = initial_cursor
        self._has_more_pages = True
        self._buffer: List[T] = []

    async def next_page(self) -> PagedResponse[T]:
        """Fetch the next page of results asynchronously."""
        if not self._has_more_pages:
            return PagedResponse(items=[], next_cursor=None, has_more=False)

        page = await self._fetcher(self._current_cursor)
        self._current_cursor = page.next_cursor
        self._has_more_pages = page.has_more and bool(page.next_cursor)
        return page

    async def all(self, max_items: int = 10000) -> List[T]:
        """Collect all items across pages up to max_items asynchronously."""
        results: List[T] = []
        async for item in self:
            results.append(item)
            if len(results) >= max_items:
                break
        return results

    def __aiter__(self) -> AsyncIterator[T]:
        return self

    async def __anext__(self) -> T:
        while True:
            if self._buffer:
                return self._buffer.pop(0)

            if not self._has_more_pages:
                raise StopAsyncIteration

            page = await self.next_page()
            self._buffer.extend(page.items)

            if not self._buffer and not self._has_more_pages:
                raise StopAsyncIteration
