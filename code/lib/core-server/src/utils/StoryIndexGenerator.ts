import path from 'path';
import chalk from 'chalk';
import fs from 'fs-extra';
import slash from 'slash';
import invariant from 'tiny-invariant';

import type {
  IndexEntry,
  StoryIndexEntry,
  DocsIndexEntry,
  NormalizedStoriesSpecifier,
  DocsOptions,
  Path,
  Tag,
  StoryIndex,
  Indexer,
  StorybookConfigRaw,
} from '@storybook/core/dist/types';
import { userOrAutoTitleFromSpecifier, sortStoriesV7 } from '@storybook/core/dist/preview-api';
import { commonGlobOptions, normalizeStoryPath } from '@storybook/core/dist/common';
import { logger, once } from '@storybook/core/dist/node-logger';
import { getStorySortParameter, loadConfig } from '@storybook/core/dist/csf-tools';
import { storyNameFromExport, toId, combineTags } from '@storybook/csf';
import { analyze } from '@storybook/docs-mdx';
import dedent from 'ts-dedent';
import { autoName } from './autoName';
import { IndexingError, MultipleIndexingError } from './IndexingError';

// Extended type to keep track of the csf meta id so we know the component id when referencing docs in `extractDocs`
type StoryIndexEntryWithMetaId = StoryIndexEntry & { metaId?: string };
/** A .mdx file will produce a docs entry */
type DocsCacheEntry = DocsIndexEntry;
/** A *.stories.* file will produce a list of stories and possibly a docs entry */
type StoriesCacheEntry = {
  entries: (StoryIndexEntryWithMetaId | DocsIndexEntry)[];
  dependents: Path[];
  type: 'stories';
};
type ErrorEntry = {
  type: 'error';
  err: IndexingError;
};
type CacheEntry = false | StoriesCacheEntry | DocsCacheEntry | ErrorEntry;
type SpecifierStoriesCache = Record<Path, CacheEntry>;

export type StoryIndexGeneratorOptions = {
  workingDir: Path;
  configDir: Path;
  indexers: Indexer[];
  docs: DocsOptions;
  build?: StorybookConfigRaw['build'];
};

export const AUTODOCS_TAG = 'autodocs';
export const STORIES_MDX_TAG = 'stories-mdx';
export const UNATTACHED_MDX_TAG = 'unattached-mdx';
export const ATTACHED_MDX_TAG = 'attached-mdx';
export const PLAY_FN_TAG = 'play-fn';

/** Was this docs entry generated by a .mdx file? (see discussion below) */
export function isMdxEntry({ tags }: DocsIndexEntry) {
  return tags?.includes(UNATTACHED_MDX_TAG) || tags?.includes(ATTACHED_MDX_TAG);
}

const makeAbsolute = (otherImport: Path, normalizedPath: Path, workingDir: Path) =>
  otherImport.startsWith('.')
    ? slash(
        path.resolve(
          workingDir,
          normalizeStoryPath(path.join(path.dirname(normalizedPath), otherImport))
        )
      )
    : otherImport;

/**
 * The StoryIndexGenerator extracts stories and docs entries for each file matching
 * (one or more) stories "specifiers", as defined in main.js.
 *
 * The output is a set of entries (see above for the types).
 *
 * Each file is treated as a stories or a (modern) docs file.
 *
 * A stories file is indexed by an indexer (passed in), which produces a list of stories.
 *   - If the stories have the `parameters.docsOnly` setting, they are disregarded.
 *   - If the stories have the 'stories-mdx' tag (i.e. were generated by a .stories.mdx file),
 *        OR autodocs is enabled, a docs entry is added pointing to the story file.
 *
 * A (modern) docs (.mdx) file is indexed, a docs entry is added.
 *
 * In the preview, a docs entry with either the `autodocs` or `stories-mdx` tags will be rendered
 * as a CSF file that exports an MDX template on the `docs.page` parameter, whereas
 * other docs entries are rendered as MDX files directly.
 *
 * The entries are "uniq"-ed and sorted. Stories entries are preferred to docs entries and
 * MDX docs entries are preferred to CSF templates (with warnings).
 */
export class StoryIndexGenerator {
  // An internal cache mapping specifiers to a set of path=><set of stories>
  // Later, we'll combine each of these subsets together to form the full index
  private specifierToCache: Map<NormalizedStoriesSpecifier, SpecifierStoriesCache>;

  // Cache the last value of `getStoryIndex`. We invalidate (by unsetting) when:
  //  - any file changes, including deletions
  //  - the preview changes [not yet implemented]
  private lastIndex?: StoryIndex | null;

  // Same as the above but for the error case
  private lastError?: Error | null;

  constructor(
    public readonly specifiers: NormalizedStoriesSpecifier[],
    public readonly options: StoryIndexGeneratorOptions
  ) {
    this.specifierToCache = new Map();
  }

  async initialize() {
    // Find all matching paths for each specifier
    const specifiersAndCaches = await Promise.all(
      this.specifiers.map(async (specifier) => {
        const pathToSubIndex = {} as SpecifierStoriesCache;

        const fullGlob = slash(
          path.join(this.options.workingDir, specifier.directory, specifier.files)
        );

        // Dynamically import globby because it is a pure ESM module
        const { globby } = await import('globby');

        const files = await globby(fullGlob, commonGlobOptions(fullGlob));

        if (files.length === 0) {
          once.warn(
            `No story files found for the specified pattern: ${chalk.blue(
              path.join(specifier.directory, specifier.files)
            )}`
          );
        }

        files.sort().forEach((absolutePath: Path) => {
          const ext = path.extname(absolutePath);
          if (ext === '.storyshot') {
            const relativePath = path.relative(this.options.workingDir, absolutePath);
            logger.info(`Skipping ${ext} file ${relativePath}`);
            return;
          }

          pathToSubIndex[absolutePath] = false;
        });

        return [specifier, pathToSubIndex] as const;
      })
    );

    // We do this in a second step to avoid timing issues with the Promise.all above -- to ensure
    // the keys in the `specifierToCache` object are consistent with the order of specifiers.
    specifiersAndCaches.forEach(([specifier, cache]) =>
      this.specifierToCache.set(specifier, cache)
    );

    const previewCode = await this.getPreviewCode();
    const projectTags = this.getProjectTags(previewCode);

    // Extract stories for each file
    await this.ensureExtracted({ projectTags });
  }

  /**
   * Run the updater function over all the empty cache entries
   */
  async updateExtracted(
    updater: (
      specifier: NormalizedStoriesSpecifier,
      absolutePath: Path,
      existingEntry: CacheEntry
    ) => Promise<CacheEntry>,
    overwrite = false
  ) {
    await Promise.all(
      this.specifiers.map(async (specifier) => {
        const entry = this.specifierToCache.get(specifier);
        invariant(
          entry,
          `specifier does not have a matching cache entry in specifierToCache: ${JSON.stringify(
            specifier
          )}`
        );
        return Promise.all(
          Object.keys(entry).map(async (absolutePath) => {
            if (entry[absolutePath] && !overwrite) return;

            try {
              entry[absolutePath] = await updater(specifier, absolutePath, entry[absolutePath]);
            } catch (err) {
              const relativePath = `.${path.sep}${path.relative(
                this.options.workingDir,
                absolutePath
              )}`;

              entry[absolutePath] = {
                type: 'error',
                err: new IndexingError(
                  err instanceof Error ? err.message : String(err),
                  [relativePath],
                  err instanceof Error ? err.stack : undefined
                ),
              };
            }
          })
        );
      })
    );
  }

  isDocsMdx(absolutePath: Path) {
    return /(?<!\.stories)\.mdx$/i.test(absolutePath);
  }

  async ensureExtracted({
    projectTags,
  }: {
    projectTags?: Tag[];
  }): Promise<(IndexEntry | ErrorEntry)[]> {
    // First process all the story files. Then, in a second pass,
    // process the docs files. The reason for this is that the docs
    // files may use the `<Meta of={XStories} />` syntax, which requires
    // that the story file that contains the meta be processed first.
    await this.updateExtracted(async (specifier, absolutePath) =>
      this.isDocsMdx(absolutePath)
        ? false
        : this.extractStories(specifier, absolutePath, projectTags)
    );

    await this.updateExtracted(async (specifier, absolutePath) =>
      this.extractDocs(specifier, absolutePath, projectTags)
    );

    return this.specifiers.flatMap((specifier) => {
      const cache = this.specifierToCache.get(specifier);
      invariant(
        cache,
        `specifier does not have a matching cache entry in specifierToCache: ${JSON.stringify(
          specifier
        )}`
      );
      return Object.values(cache).flatMap((entry): (IndexEntry | ErrorEntry)[] => {
        if (!entry) return [];
        if (entry.type === 'docs') return [entry];
        if (entry.type === 'error') return [entry];

        return entry.entries.map((item) => {
          if (item.type === 'docs') return item;
          // Drop the meta id as it isn't part of the index, we just used it for record keeping in `extractDocs`
          const { metaId, ...existing } = item;
          return existing;
        });
      });
    });
  }

  findDependencies(absoluteImports: Path[]) {
    return [...this.specifierToCache.values()].flatMap((cache: SpecifierStoriesCache) =>
      Object.entries(cache)
        .filter(([fileName, cacheEntry]) => {
          // We are only interested in stories cache entries (and assume they've been processed already)
          // If we found a match in the cache that's still null or not a stories file,
          // it is a docs file and it isn't a dependency / storiesImport.
          // See https://github.com/storybookjs/storybook/issues/20958
          if (!cacheEntry || cacheEntry.type !== 'stories') return false;

          return !!absoluteImports.find((storyImport) =>
            fileName.match(
              new RegExp(`^${storyImport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[^.]+)?$`)
            )
          );
        })
        .map(([_, cacheEntry]) => cacheEntry as StoriesCacheEntry)
    );
  }

  async extractStories(
    specifier: NormalizedStoriesSpecifier,
    absolutePath: Path,
    projectTags: Tag[] = []
  ): Promise<StoriesCacheEntry | DocsCacheEntry> {
    const relativePath = path.relative(this.options.workingDir, absolutePath);
    const importPath = slash(normalizeStoryPath(relativePath));
    const defaultMakeTitle = (userTitle?: string) => {
      const title = userOrAutoTitleFromSpecifier(importPath, specifier, userTitle);
      invariant(
        title,
        "makeTitle created an undefined title. This happens when the fileName doesn't match any specifier from main.js"
      );
      return title;
    };

    const indexer = this.options.indexers.find((ind) => ind.test.exec(absolutePath));

    invariant(indexer, `No matching indexer found for ${absolutePath}`);

    const indexInputs = await indexer.createIndex(absolutePath, { makeTitle: defaultMakeTitle });

    const entries: ((StoryIndexEntryWithMetaId | DocsCacheEntry) & { tags: Tag[] })[] =
      indexInputs.map((input) => {
        const name = input.name ?? storyNameFromExport(input.exportName);
        const title = input.title ?? defaultMakeTitle();
        // eslint-disable-next-line no-underscore-dangle
        const id = input.__id ?? toId(input.metaId ?? title, storyNameFromExport(input.exportName));
        const tags = combineTags(...projectTags, ...(input.tags ?? []));

        return {
          type: 'story',
          id,
          metaId: input.metaId,
          name,
          title,
          importPath,
          tags,
        };
      });

    // We need a docs entry attached to the CSF file if either:
    //  a) we have autodocs enabled for this file
    //  b) it is a stories.mdx transpiled to CSF
    const hasAutodocsTag = entries.some((entry) => entry.tags.includes(AUTODOCS_TAG));
    const isStoriesMdx = entries.some((entry) => entry.tags.includes(STORIES_MDX_TAG));
    const createDocEntry = (hasAutodocsTag && this.options.docs.autodocs !== false) || isStoriesMdx;

    if (createDocEntry && this.options.build?.test?.disableAutoDocs !== true) {
      const name = this.options.docs.defaultName ?? 'Docs';
      const { metaId } = indexInputs[0];
      const { title } = entries[0];
      const id = toId(metaId ?? title, name);
      const tags = combineTags(...projectTags, ...(indexInputs[0].tags ?? []));

      entries.unshift({
        id,
        title,
        name,
        importPath,
        type: 'docs',
        tags,
        storiesImports: [],
      });
    }

    const entriesWithoutDocsOnlyStories = entries.filter(
      (entry) => !(entry.type === 'story' && entry.tags.includes('stories-mdx-docsOnly'))
    );

    return {
      entries: entriesWithoutDocsOnlyStories,
      dependents: [],
      type: 'stories',
    };
  }

  async extractDocs(
    specifier: NormalizedStoriesSpecifier,
    absolutePath: Path,
    projectTags: Tag[] = []
  ) {
    const relativePath = path.relative(this.options.workingDir, absolutePath);
    try {
      const normalizedPath = normalizeStoryPath(relativePath);
      const importPath = slash(normalizedPath);

      const content = await fs.readFile(absolutePath, 'utf8');

      const result = analyze(content);

      // Templates are not indexed
      if (result.isTemplate) return false;

      const absoluteImports = (result.imports as string[]).map((p) =>
        makeAbsolute(p, normalizedPath, this.options.workingDir)
      );

      // Go through the cache and collect all of the cache entries that this docs file depends on.
      // We'll use this to make sure this docs cache entry is invalidated when any of its dependents
      // are invalidated.f
      const dependencies = this.findDependencies(absoluteImports);

      // To ensure the `<Meta of={}/>` import is always first in the list, we'll bring the dependency
      // that contains it to the front of the list.
      let sortedDependencies = dependencies;

      // Also, if `result.of` is set, it means that we're using the `<Meta of={XStories} />` syntax,
      // so find the `title` defined the file that `meta` points to.
      let csfEntry: StoryIndexEntryWithMetaId | undefined;
      if (result.of) {
        const absoluteOf = makeAbsolute(result.of, normalizedPath, this.options.workingDir);
        dependencies.forEach((dep) => {
          if (dep.entries.length > 0) {
            const first = dep.entries.find((e) => e.type !== 'docs') as StoryIndexEntryWithMetaId;

            if (
              path
                .normalize(path.resolve(this.options.workingDir, first.importPath))
                .startsWith(path.normalize(absoluteOf))
            ) {
              csfEntry = first;
            }
          }

          sortedDependencies = [dep, ...dependencies.filter((d) => d !== dep)];
        });

        invariant(
          csfEntry,
          dedent`Could not find or load CSF file at path "${result.of}" referenced by \`of={}\` in docs file "${relativePath}".
            
        - Does that file exist?
        - If so, is it a CSF file (\`.stories.*\`)?
        - If so, is it matched by the \`stories\` glob in \`main.js\`?
        - If so, has the file successfully loaded in Storybook and are its stories visible?`
        );
      }

      // Track that we depend on this for easy invalidation later.
      dependencies.forEach((dep) => {
        dep.dependents.push(absolutePath);
      });

      const title =
        csfEntry?.title || userOrAutoTitleFromSpecifier(importPath, specifier, result.title);
      invariant(
        title,
        "makeTitle created an undefined title. This happens when a specifier's doesn't have any matches in its fileName"
      );
      const defaultName = this.options.docs.defaultName ?? 'Docs';

      const name =
        result.name ||
        (csfEntry ? autoName(importPath, csfEntry.importPath, defaultName) : defaultName);

      const id = toId(csfEntry?.metaId || title, name);

      const tags = combineTags(
        ...projectTags,
        ...(csfEntry?.tags ?? []),
        ...(result.metaTags ?? []),
        csfEntry ? 'attached-mdx' : 'unattached-mdx'
      );

      const docsEntry: DocsCacheEntry = {
        id,
        title,
        name,
        importPath,
        storiesImports: sortedDependencies.map((dep) => dep.entries[0].importPath),
        type: 'docs',
        tags,
      };
      return docsEntry;
    } catch (err) {
      if (err && (err as { source: any }).source?.match(/mdast-util-mdx-jsx/g)) {
        logger.warn(
          `💡 This seems to be an MDX2 syntax error. Please refer to the MDX section in the following resource for assistance on how to fix this: ${chalk.yellow(
            'https://storybook.js.org/migration-guides/7.0'
          )}`
        );
      }
      throw err;
    }
  }

  chooseDuplicate(firstEntry: IndexEntry, secondEntry: IndexEntry): IndexEntry {
    // NOTE: it is possible for the same entry to show up twice (if it matches >1 glob). That's OK.
    if (firstEntry.importPath === secondEntry.importPath) {
      return firstEntry;
    }

    let firstIsBetter = true;
    if (secondEntry.type === 'story') {
      firstIsBetter = false;
    } else if (isMdxEntry(secondEntry) && firstEntry.type === 'docs' && !isMdxEntry(firstEntry)) {
      firstIsBetter = false;
    }
    const betterEntry = firstIsBetter ? firstEntry : secondEntry;
    const worseEntry = firstIsBetter ? secondEntry : firstEntry;

    const changeDocsName = 'Use `<Meta of={} name="Other Name">` to distinguish them.';

    // This shouldn't be possible, but double check and use for typing
    if (worseEntry.type === 'story')
      throw new IndexingError(`Duplicate stories with id: ${firstEntry.id}`, [
        firstEntry.importPath,
        secondEntry.importPath,
      ]);

    if (betterEntry.type === 'story') {
      const worseDescriptor = isMdxEntry(worseEntry)
        ? `component docs page`
        : `automatically generated docs page`;
      if (betterEntry.name === this.options.docs.defaultName) {
        throw new IndexingError(
          `You have a story for ${betterEntry.title} with the same name as your default docs entry name (${betterEntry.name}), so the docs page is being dropped. Consider changing the story name.`,
          [firstEntry.importPath, secondEntry.importPath]
        );
      } else {
        throw new IndexingError(
          `You have a story for ${betterEntry.title} with the same name as your ${worseDescriptor} (${worseEntry.name}), so the docs page is being dropped. ${changeDocsName}`,
          [firstEntry.importPath, secondEntry.importPath]
        );
      }
    } else if (isMdxEntry(betterEntry)) {
      // Both entries are MDX but pointing at the same place
      if (isMdxEntry(worseEntry)) {
        throw new IndexingError(
          `You have two component docs pages with the same name ${betterEntry.title}:${betterEntry.name}. ${changeDocsName}`,
          [firstEntry.importPath, secondEntry.importPath]
        );
      }

      // If you link a file to a tagged CSF file, you have probably made a mistake
      if (worseEntry.tags?.includes(AUTODOCS_TAG) && this.options.docs.autodocs !== true)
        throw new IndexingError(
          `You created a component docs page for '${worseEntry.title}', but also tagged the CSF file with '${AUTODOCS_TAG}'. This is probably a mistake.`,
          [betterEntry.importPath, worseEntry.importPath]
        );

      // Otherwise the existing entry is created by `autodocs=true` which allowed to be overridden.
    } else {
      // If both entries are templates (e.g. you have two CSF files with the same title), then
      //   we need to merge the entries. We'll use the first one's name and importPath,
      //   but ensure we include both as storiesImports so they are both loaded before rendering
      //   the story (for the <Stories> block & friends)
      return {
        ...betterEntry,
        storiesImports: [
          ...betterEntry.storiesImports,
          worseEntry.importPath,
          ...worseEntry.storiesImports,
        ],
      };
    }

    return betterEntry;
  }

  async sortStories(entries: StoryIndex['entries'], storySortParameter: any) {
    const sortableStories = Object.values(entries);
    const fileNameOrder = this.storyFileNames();
    sortStoriesV7(sortableStories, storySortParameter, fileNameOrder);

    return sortableStories.reduce(
      (acc, item) => {
        acc[item.id] = item;
        return acc;
      },
      {} as StoryIndex['entries']
    );
  }

  async getIndex() {
    if (this.lastIndex) return this.lastIndex;
    if (this.lastError) throw this.lastError;

    const previewCode = await this.getPreviewCode();
    const projectTags = this.getProjectTags(previewCode);

    // Extract any entries that are currently missing
    // Pull out each file's stories into a list of stories, to be composed and sorted
    const storiesList = await this.ensureExtracted({ projectTags });

    try {
      const errorEntries = storiesList.filter((entry) => entry.type === 'error');

      if (errorEntries.length)
        throw new MultipleIndexingError(errorEntries.map((entry) => (entry as ErrorEntry).err));

      const duplicateErrors: IndexingError[] = [];
      const indexEntries: StoryIndex['entries'] = {};
      (storiesList as IndexEntry[]).forEach((entry) => {
        try {
          const existing = indexEntries[entry.id];
          if (existing) {
            indexEntries[entry.id] = this.chooseDuplicate(existing, entry);
          } else {
            indexEntries[entry.id] = entry;
          }
        } catch (err) {
          if (err instanceof IndexingError) duplicateErrors.push(err);
        }
      });
      if (duplicateErrors.length) throw new MultipleIndexingError(duplicateErrors);

      const sorted = await this.sortStories(
        indexEntries,
        previewCode && getStorySortParameter(previewCode)
      );

      this.lastIndex = {
        v: 5,
        entries: sorted,
      };

      return this.lastIndex;
    } catch (err) {
      this.lastError = err == null || err instanceof Error ? err : undefined;
      invariant(this.lastError);
      logger.warn(`🚨 ${this.lastError.toString()}`);
      throw this.lastError;
    }
  }

  invalidateAll() {
    this.specifierToCache.forEach((cache) => {
      Object.keys(cache).forEach((key) => {
        cache[key] = false;
      });
    });
    this.lastIndex = null;
    this.lastError = null;
  }

  invalidate(specifier: NormalizedStoriesSpecifier, importPath: Path, removed: boolean) {
    const absolutePath = slash(path.resolve(this.options.workingDir, importPath));
    const cache = this.specifierToCache.get(specifier);
    invariant(
      cache,
      `specifier does not have a matching cache entry in specifierToCache: ${JSON.stringify(
        specifier
      )}`
    );
    const cacheEntry = cache[absolutePath];
    if (cacheEntry && cacheEntry.type === 'stories') {
      const { dependents } = cacheEntry;

      const invalidated = new Set();
      // the dependent can be in ANY cache, so we loop over all of them
      this.specifierToCache.forEach((otherCache) => {
        dependents.forEach((dep) => {
          if (otherCache[dep]) {
            invalidated.add(dep);

            otherCache[dep] = false;
          }
        });
      });
    }

    if (removed) {
      if (cacheEntry && cacheEntry.type === 'docs') {
        const absoluteImports = cacheEntry.storiesImports.map((p) =>
          path.resolve(this.options.workingDir, p)
        );
        const dependencies = this.findDependencies(absoluteImports);
        dependencies.forEach((dep) =>
          dep.dependents.splice(dep.dependents.indexOf(absolutePath), 1)
        );
      }
      delete cache[absolutePath];
    } else {
      cache[absolutePath] = false;
    }
    this.lastIndex = null;
    this.lastError = null;
  }

  async getPreviewCode() {
    const previewFile = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts']
      .map((ext) => path.join(this.options.configDir, `preview.${ext}`))
      .find((fname) => fs.existsSync(fname));

    return previewFile && (await fs.readFile(previewFile, 'utf-8')).toString();
  }

  getProjectTags(previewCode?: string) {
    let projectTags = [];
    const defaultTags = ['dev', 'test'];
    const extraTags = this.options.docs.autodocs === true ? [AUTODOCS_TAG] : [];
    if (previewCode) {
      try {
        const projectAnnotations = loadConfig(previewCode).parse();
        projectTags = projectAnnotations.getFieldValue(['tags']) ?? [];
      } catch (err) {
        once.warn(dedent`
          Unable to parse tags from project configuration. If defined, tags should be specified inline, e.g.
      
          export default {
            tags: ['foo'],
          }
      
          ---
      
          Received:
      
          ${previewCode}
        `);
      }
    }
    return [...defaultTags, ...projectTags, ...extraTags];
  }

  // Get the story file names in "imported order"
  storyFileNames() {
    return Array.from(this.specifierToCache.values()).flatMap((r) => Object.keys(r));
  }
}
