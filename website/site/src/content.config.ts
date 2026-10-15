import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'

import { DOCS } from './data/site'

const slugByFile = Object.fromEntries(DOCS.map((doc) => [doc.file, doc.slug]))

/** Markdown read straight from the repository so the site never drifts from the docs. */
const docs = defineCollection({
  loader: glob({
    base: '../..',
    pattern: DOCS.map((doc) => doc.file),
    generateId: ({ entry }) => slugByFile[entry] ?? entry,
  }),
})

const changelog = defineCollection({
  loader: glob({ base: '../..', pattern: 'CHANGELOG.md', generateId: () => 'changelog' }),
})

export const collections = { docs, changelog }
