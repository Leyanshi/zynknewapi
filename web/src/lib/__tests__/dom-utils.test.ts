/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { afterEach, expect, test } from 'vitest'

import { applyDocumentTitle, resolveDocumentTitle } from '../dom-utils'

afterEach(() => {
  document.title = ''
  document.head.innerHTML = ''
})

test.each([
  ['/', 'New API', 'Acme AI Gateway', 'Acme AI Gateway'],
  ['/index.html', 'New API', 'Acme AI Gateway', 'Acme AI Gateway'],
  ['/', 'New API', '   ', 'New API'],
  ['/', 'New API', '', 'New API'],
  ['/pricing', 'New API', 'Acme AI Gateway', 'New API'],
  ['/security', 'New API', 'Acme AI Gateway', 'New API'],
])(
  'resolves the document title for %s with system "%s" and home title "%s"',
  (pathname, systemName, homePageTitle, expected) => {
    expect(resolveDocumentTitle(pathname, systemName, homePageTitle)).toBe(
      expected
    )
  }
)

test('applies the title to the document and its meta title tag', () => {
  const meta = document.createElement('meta')
  meta.name = 'title'
  meta.content = 'New API'
  document.head.appendChild(meta)

  applyDocumentTitle('Acme AI Gateway')

  expect(document.title).toBe('Acme AI Gateway')
  expect(meta.content).toBe('Acme AI Gateway')
})
