`src/pagination.js` computes the wrong offset for every page and, when the total
divides exactly by the page size, offers a final page that is always empty.

**`paginate({ total, page, perPage })`** must return:

| field | |
|---|---|
| `pageCount` | `ceil(total / perPage)`, and never less than 1 — an empty collection still has one (empty) page |
| `page` | the requested page, clamped to `[1, pageCount]` |
| `offset` | `(page - 1) * perPage` — page 1 starts at 0 |
| `limit` | how many rows this page actually holds: `perPage`, or the remainder on the last page, or 0 when there is nothing at all |
| `perPage`, `total` | as given |
| `hasPrevious` | whether there is a page before this one |
| `hasNext` | whether there is a page after this one |

The argument validation is already right: `total` must be a non-negative
integer, `page` and `perPage` positive integers, and anything else is a
`RangeError`.

**`pageNumbers(page, pageCount, window = 5)`** returns the page numbers to draw
in the pager: `min(window, pageCount)` consecutive numbers, always including
`page`, as close to centred on `page` as they can be while staying within
`[1, pageCount]`. When `window` is even the extra number goes on the right of
`page`. Today the last pages get a short strip — `pageNumbers(10, 10)` returns
three numbers instead of five.

Do not change the shape of the exports or the module's public names.
