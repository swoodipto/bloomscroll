import {
  ItemView,
  Component,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
  TFile,
  setIcon,
} from 'obsidian';
import BloomscrollPlugin from './main';
import { preparePreviewMarkdown, prepareRenderedPreview } from './extract';
import { NotePreview, toNotePreview } from './types';
import { selectBatch } from './selector';
import { recordView } from './history';

export const VIEW_TYPE_BLOOMSCROLL = 'bloomscroll-view';
// The view type is persisted in the workspace layout. Tabs saved before the
// Doomscroll -> Bloomscroll rename still carry the old type, so it stays
// registered and open tabs survive the upgrade.
export const VIEW_TYPE_LEGACY = 'doomscroll-view';
const HISTORY_SAVE_DELAY_MS = 2_000;
const MAX_BATCH_HISTORY = 20;
const MAX_RENDERED_SNIPPET_CACHE_ENTRIES = 100;
// Pointer drift above this (px) between down and up is a swipe, not a tap.
const TAP_SLOP_PX = 10;
// A card must be mostly on screen before it counts as viewed. In a
// full-viewport feed the old 0.1 threshold fired while a card was barely
// peeking in, marking notes read that were never actually looked at.
const FEED_VIEW_THRESHOLD = 0.6;
const LIST_VIEW_THRESHOLD = 0.1;

interface AppWithSettings {
  setting: {
    open(): void;
    openTabById(id: string): void;
  };
}

// The bookmarks plugin is a core *internal* plugin: it is absent from
// obsidian.d.ts, can be disabled by the user, and its API is not guaranteed
// stable. Everything below is shape-checked before being called.
interface BookmarkItem {
  type: string;
  path?: string;
}

interface BookmarksPluginInstance {
  addItem(item: BookmarkItem): void;
  removeItem(item: BookmarkItem): void;
  getBookmarks(): BookmarkItem[];
}

interface AppWithInternalPlugins {
  internalPlugins?: {
    getEnabledPluginById?(id: string): unknown;
  };
}

interface BloomscrollViewState {
  batchPaths: string[];
  batchHistoryPaths: string[][];
  batchHistoryCursor: number;
  scrollTop: number;
  // Feed mode restores by index: a pixel offset is wrong after a resize or
  // rotation, since every card is exactly one viewport tall.
  cardIndex: number;
}

export class BloomscrollView extends ItemView {
  plugin: BloomscrollPlugin;
  containerEl: HTMLElement;
  hasRendered: boolean = false;
  currentBatch: NotePreview[] = [];
  imageObserver: IntersectionObserver | null = null;
  cardObserver: IntersectionObserver | null = null;
  viewedPathsInBatch: Set<string> = new Set();
  batchHistory: NotePreview[][] = [];
  batchHistoryCursor: number = -1;
  backButton: HTMLButtonElement | null = null;
  bookmarkButton: HTMLButtonElement | null = null;
  private refreshStatusEl: HTMLElement | null = null;
  private isRefreshing = false;
  private pendingSettingsRefresh = false;
  private freshIndexLoaded = false;
  private batchSettingsKey: string | null = null;
  private historySaveTimer: number | null = null;
  private historySavePending = false;
  private restoredScrollTop = 0;
  private renderedSnippetCache = new Map<string, HTMLElement>();
  private renderedSimplifiedView: boolean | null = null;
  private progressEl: HTMLElement | null = null;
  private currentCardIndex = 0;
  private activeCardFrame: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BloomscrollPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerEl = this.contentEl;
  }

  getViewType(): string {
    return VIEW_TYPE_BLOOMSCROLL;
  }

  getDisplayText(): string {
    return 'Bloomscroll';
  }

  getIcon(): string {
    return 'gallery-vertical';
  }

  getState(): Record<string, unknown> {
    const body = this.containerEl.querySelector('.bloomscroll-body');
    const scrollTop =
      body instanceof HTMLElement ? body.scrollTop : this.restoredScrollTop;

    return {
      batchPaths: this.currentBatch.map((preview) => preview.path),
      batchHistoryPaths: this.batchHistory.map((batch) =>
        batch.map((preview) => preview.path)
      ),
      batchHistoryCursor: this.batchHistoryCursor,
      scrollTop,
      cardIndex: this.currentCardIndex,
    } satisfies BloomscrollViewState;
  }

  async setState(state: unknown): Promise<void> {
    // The first index refresh is authoritative for this view session. Ignore
    // a late workspace restore so it cannot put an old batch back on screen.
    if (this.freshIndexLoaded) return;

    const restored = parseViewState(state);
    if (!restored) return;

    this.currentBatch = this.resolvePreviewPaths(restored.batchPaths);
    this.batchHistory = restored.batchHistoryPaths
      .map((paths) => this.resolvePreviewPaths(paths))
      .filter((batch) => batch.length > 0)
      .slice(0, MAX_BATCH_HISTORY);
    this.batchHistoryCursor = Math.min(
      restored.batchHistoryCursor,
      this.batchHistory.length - 1
    );
    this.restoredScrollTop = restored.scrollTop;
    this.currentCardIndex = restored.cardIndex;

    if (this.hasRendered) {
      this.renderBatch();
      this.restoreScrollPosition();
    }
  }

  async onOpen(): Promise<void> {
    this.registerFeedKeys();
    await this.render();
  }

  private registerFeedKeys(): void {
    // Scope is torn down with the view, so these never leak into the rest of
    // Obsidian. Each moves exactly one card, matching the snap step.
    const step = (delta: number): boolean => {
      if (!this.isFeedMode()) return true; // let the pane scroll normally
      const body = this.containerEl.querySelector('.bloomscroll-body');
      if (!(body instanceof HTMLElement) || body.clientHeight <= 0) return true;
      body.scrollBy({ top: delta * body.clientHeight, behavior: 'smooth' });
      return false;
    };

    const scope = this.scope;
    if (!scope) return;

    scope.register([], 'ArrowDown', () => step(1));
    scope.register([], 'ArrowUp', () => step(-1));
    scope.register([], 'PageDown', () => step(1));
    scope.register([], 'PageUp', () => step(-1));
    scope.register([], ' ', () => step(1));
    scope.register(['Shift'], ' ', () => step(-1));
  }

  async refreshForCurrentSettings(): Promise<void> {
    if (this.isRefreshing) {
      this.pendingSettingsRefresh = true;
      return;
    }

    this.setRefreshing(true);
    let indexRefreshed = false;
    let refreshFailed = false;
    try {
      indexRefreshed = await this.plugin.indexer.refreshIfStale();
      if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
        indexRefreshed =
          (await this.plugin.indexer.refreshIfStale()) || indexRefreshed;
      }
    } catch (error) {
      console.error('Error refreshing vault index:', error);
      refreshFailed = true;
    } finally {
      this.setRefreshing(false);
    }

    const settingsChanged =
      this.batchSettingsKey !== this.getBatchSettingsKey();
    const previewModeChanged =
      this.renderedSimplifiedView !== this.isSimplifiedView();
    if (!refreshFailed && (indexRefreshed || settingsChanged || previewModeChanged)) {
      if (indexRefreshed || settingsChanged) {
        this.currentBatch = [];
      }
      if (settingsChanged) {
        this.batchHistory = [];
        this.batchHistoryCursor = -1;
      } else if (indexRefreshed) {
        this.revalidateBatchHistory();
      } else if (previewModeChanged) {
        this.renderedSnippetCache.clear();
      }

      if (this.hasRendered) {
        this.renderBatch();
        this.containerEl.querySelector('.bloomscroll-body')?.scrollTo({ top: 0 });
      }
    }

    if (this.pendingSettingsRefresh) {
      this.pendingSettingsRefresh = false;
      await this.refreshForCurrentSettings();
    }
  }

  private async render(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass('bloomscroll-view-container');
    this.applyFeedModeClass();

    // Header row
    const header = this.containerEl.createDiv('bloomscroll-header');

    // Header is a three-slot row: progress (left), title (centre), controls
    // (right). The leading and trailing slots share a width so the title lands
    // on the true centre rather than the midpoint of the leftover space.
    const leading = header.createDiv('bloomscroll-header-slot');
    this.progressEl = leading.createDiv('bloomscroll-progress');
    this.progressEl.setAttribute('aria-live', 'polite');

    const title = header.createEl('h2');
    title.textContent = 'ꕤ bloomscroll';
    title.className = 'bloomscroll-title';

    this.refreshStatusEl = leading.createDiv('bloomscroll-refresh-status');
    this.refreshStatusEl.setAttribute('aria-live', 'polite');
    const controls = header.createDiv('bloomscroll-controls bloomscroll-header-slot');

    // Reshuffle button (refresh icon)
    const reshuffleBtn = controls.createEl('button');
    reshuffleBtn.className = 'bloomscroll-reshuffle-btn';
    reshuffleBtn.setAttribute('aria-label', 'Reshuffle');
    setIcon(reshuffleBtn, 'refresh-cw');
    reshuffleBtn.addEventListener('click', () => {
      void this.showNewBatch();
    });

    // Previous batch button
    this.backButton = controls.createEl('button');
    this.backButton.className = 'bloomscroll-back-btn';
    this.backButton.setAttribute('aria-label', 'Previous card set');
    setIcon(this.backButton, 'arrow-left');
    this.backButton.addEventListener('click', () => {
      void this.showPreviousBatch();
    });
    this.updateBackButton();

    // Bookmark button — sits between back and reshuffle in the floating cluster.
    this.bookmarkButton = controls.createEl('button');
    this.bookmarkButton.className = 'bloomscroll-bookmark-btn';
    this.bookmarkButton.setAttribute('aria-label', 'Bookmark this note');
    setIcon(this.bookmarkButton, 'bookmark');
    this.bookmarkButton.addEventListener('click', () => {
      this.toggleBookmarkForActiveCard();
    });
    this.updateBookmarkButton();

    // Settings button
    const settingsBtn = controls.createEl('button');
    settingsBtn.className = 'bloomscroll-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Settings');
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      const { setting } = this.plugin.app as unknown as AppWithSettings;
      setting.open();
      // Read the id from the manifest rather than hardcoding it — the two must
      // match exactly, and a literal here silently stops opening the tab if the
      // plugin id ever changes.
      setting.openTabById(this.plugin.manifest.id);
    });

    // Body - scrollable container
    const bodyContainer = this.containerEl.createDiv('bloomscroll-body');
    bodyContainer.addEventListener(
      'scroll',
      () => {
        this.restoredScrollTop = bodyContainer.scrollTop;
        this.scheduleActiveCardUpdate(bodyContainer);
      },
      { passive: true }
    );

    // Refresh on every plugin session so a persisted index cannot outlive the
    // filters that were active when it was created. The indexer also detects
    // filter changes made while the plugin is running.
    const needsInitialIndex = Object.keys(this.plugin.data.previews).length === 0;
    const loadingEl = needsInitialIndex
      ? bodyContainer.createDiv('bloomscroll-loading')
      : null;
    if (loadingEl) {
      loadingEl.textContent = 'Indexing your vault…';
    }

    let indexRefreshed = false;
    let indexRefreshSucceeded = false;
    this.setRefreshing(true);
    try {
      indexRefreshed = await this.plugin.indexer.refreshIfStale(
        (done, total) => {
          if (loadingEl) {
            loadingEl.textContent = `Indexed ${done}/${total}`;
          }
        },
        needsInitialIndex
      );
      indexRefreshSucceeded = true;
      if (indexRefreshed) {
        await this.plugin.saveSettings();
      }
    } catch (error) {
      console.error('Error indexing vault:', error);
      if (loadingEl) {
        loadingEl.textContent = 'Error indexing vault';
      }
    } finally {
      this.setRefreshing(false);
    }

    // A restored batch was built from the previous session's index and may
    // contain notes excluded by the current settings.
    if (indexRefreshSucceeded) {
      this.freshIndexLoaded = true;
      this.currentBatch = [];
      this.batchHistory = [];
      this.batchHistoryCursor = -1;
      this.batchSettingsKey = null;
    }
    loadingEl?.remove();

    // Render batch
    this.hasRendered = true;
    this.renderBatchIntoContainer(bodyContainer);
    this.restoreScrollPosition();
  }

  private resolvePreviewPaths(paths: readonly string[]): NotePreview[] {
    return paths.flatMap((path) => {
      const stored = this.plugin.data.previews[path];
      return stored ? [toNotePreview(path, stored)] : [];
    });
  }

  private restoreScrollPosition(): void {
    const scrollTop = this.restoredScrollTop;
    const cardIndex = this.currentCardIndex;
    const feedMode = this.isFeedMode();
    const restore = (): void => {
      const body = this.containerEl.querySelector('.bloomscroll-body');
      if (body instanceof HTMLElement) {
        // Each feed card is exactly one viewport tall, so the index multiplied
        // by the current height survives resize and rotation.
        body.scrollTop =
          feedMode && body.clientHeight > 0
            ? cardIndex * body.clientHeight
            : scrollTop;
      }
    };

    restore();
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    window.setTimeout(restore, 100);
  }

  private renderBatchIntoContainer(
    container: HTMLElement,
    previousOrder?: readonly string[]
  ): void {
    // Get fresh batch if not already loaded
    if (this.currentBatch.length === 0) {
      const candidates = Object.entries(this.plugin.data.previews)
        .map(([path, stored]) => toNotePreview(path, stored))
        .filter(
          (preview) =>
            this.plugin.data.settings.includeMediaOnlyNotes ||
            !isMediaOnlyPreview(preview)
        );
      this.currentBatch = selectBatch(
        candidates,
        this.plugin.data.history,
        this.plugin.data.settings.batchSize,
        Date.now()
      );
      this.batchSettingsKey = this.getBatchSettingsKey();
      if (
        previousOrder &&
        this.currentBatch.length > 1 &&
        hasSameOrder(this.currentBatch, previousOrder)
      ) {
        [this.currentBatch[0], this.currentBatch[1]] = [
          this.currentBatch[1]!,
          this.currentBatch[0]!,
        ];
      }
      this.batchHistory.unshift(this.currentBatch);
      this.batchHistory.length = Math.min(
        this.batchHistory.length,
        MAX_BATCH_HISTORY
      );
      this.batchHistoryCursor = 0;
    }

    this.renderedSimplifiedView = this.isSimplifiedView();
    this.updateBackButton();

    // Stop observing cards from the previous batch before replacing them.
    this.cardObserver?.disconnect();
    this.viewedPathsInBatch.clear();

    this.cardObserver = new IntersectionObserver(
      (entries) => {
        let historyChanged = false;

        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const card = entry.target as HTMLElement;
          const path = card.dataset.path;
          const preview = this.currentBatch.find(
            (candidate) => candidate.path === path
          );
          const snippetEl = card.querySelector('.bloomscroll-card-snippet');
          if (preview && snippetEl instanceof HTMLElement) {
            void this.renderSnippet(preview, snippetEl);
          }

          if (path && !this.viewedPathsInBatch.has(path)) {
            this.viewedPathsInBatch.add(path);
            this.plugin.data.history = recordView(
              this.plugin.data.history,
              path,
              Date.now()
            );
            historyChanged = true;
          }
          this.cardObserver?.unobserve(card);
        }

        if (historyChanged) {
          this.scheduleHistorySave();
        }
      },
      {
        root: container,
        threshold: this.isFeedMode()
          ? FEED_VIEW_THRESHOLD
          : LIST_VIEW_THRESHOLD,
      }
    );

    // Clear previous content
    container.empty();

    // Render cards
    for (const preview of this.currentBatch) {
      const card = this.renderCard(container, preview);
      this.cardObserver.observe(card);
    }

    // End-of-feed panel. In feed mode this is a full-height snap page of its
    // own, so reaching the end is a deliberate stop rather than a stray scroll.
    const reshuffleSection = container.createDiv(
      'bloomscroll-reshuffle-section'
    );

    if (this.isFeedMode()) {
      const endTitle = reshuffleSection.createEl('h3');
      endTitle.className = 'bloomscroll-feed-end-title';
      endTitle.textContent = "You're all caught up";

      const endDesc = reshuffleSection.createDiv('bloomscroll-feed-end-desc');
      const count = this.currentBatch.length;
      endDesc.textContent = `${count} ${count === 1 ? 'note' : 'notes'} in this set`;
    }

    const reshuffleBtn = reshuffleSection.createEl('button');
    reshuffleBtn.className = 'bloomscroll-reshuffle-end-btn';
    const label = this.isFeedMode() ? 'Refresh' : 'Reshuffle';
    reshuffleBtn.textContent = label;
    reshuffleBtn.dataset.defaultLabel = label;
    reshuffleBtn.addEventListener('click', () => {
      void this.showNewBatch();
    });

    this.updateProgress();
  }

  private async showNewBatch(): Promise<void> {
    if (this.isRefreshing) return;

    const previousOrder = this.currentBatch.map((preview) => preview.path);
    this.setRefreshing(true);

    try {
      let indexRefreshed = await this.plugin.indexer.refreshIfStale();
      // Settings may have changed while the first rebuild was in progress.
      // Run the indexer again for the final settings before selecting a batch.
      if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
        indexRefreshed =
          (await this.plugin.indexer.refreshIfStale()) || indexRefreshed;
      }

      const settingsChanged =
        this.batchSettingsKey !== this.getBatchSettingsKey();
      this.currentBatch = [];

      if (settingsChanged) {
        this.batchHistory = [];
        this.batchHistoryCursor = -1;
      } else if (indexRefreshed) {
        this.revalidateBatchHistory();
      }

      this.renderBatch(
        settingsChanged || indexRefreshed ? undefined : previousOrder
      );
      this.resetToFirstCard();
    } catch (error) {
      console.error('Error refreshing vault index:', error);
    } finally {
      this.setRefreshing(false);
      if (this.pendingSettingsRefresh) {
        this.pendingSettingsRefresh = false;
        await this.refreshForCurrentSettings();
      }
    }
  }

  private async showPreviousBatch(): Promise<void> {
    if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
      await this.refreshForCurrentSettings();
      return;
    }

    const previousCursor = this.batchHistoryCursor + 1;
    const previousBatch = this.batchHistory[previousCursor];
    if (!previousBatch) return;

    this.batchHistoryCursor = previousCursor;
    this.currentBatch = previousBatch;
    this.renderBatch();
    this.resetToFirstCard();
  }

  private resetToFirstCard(): void {
    this.currentCardIndex = 0;
    this.restoredScrollTop = 0;
    const body = this.containerEl.querySelector('.bloomscroll-body');
    if (body instanceof HTMLElement) {
      // 'instant' — a smooth scroll back through a whole batch would be a long
      // animation past cards the user has already dismissed.
      body.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
    this.updateProgress();
    this.updateBookmarkButton();
  }

  private updateBackButton(): void {
    if (this.backButton) {
      this.backButton.disabled =
        this.batchHistoryCursor < 0 ||
        this.batchHistoryCursor >= this.batchHistory.length - 1;
    }
  }

  private renderBatch(previousOrder?: readonly string[]): void {
    const body = this.containerEl.querySelector('.bloomscroll-body');
    if (body) {
      this.renderBatchIntoContainer(body as HTMLElement, previousOrder);
    }
  }

  private revalidateBatchHistory(): void {
    const previousCursor = this.batchHistoryCursor;
    const retained: Array<{ oldIndex: number; batch: NotePreview[] }> = [];

    this.batchHistory.forEach((batch, oldIndex) => {
      const nextBatch = this.resolvePreviewPaths(
        batch.map((preview) => preview.path)
      );
      if (nextBatch.length > 0) {
        retained.push({ oldIndex, batch: nextBatch });
      }
    });

    this.batchHistory = retained.map(({ batch }) => batch);
    const retainedCursor = retained.findIndex(
      ({ oldIndex }) => oldIndex === previousCursor
    );
    this.batchHistoryCursor =
      retainedCursor >= 0
        ? retainedCursor
        : Math.min(previousCursor, this.batchHistory.length - 1);
  }

  private setRefreshing(refreshing: boolean): void {
    this.isRefreshing = refreshing;
    if (this.refreshStatusEl) {
      this.refreshStatusEl.textContent = refreshing ? 'Indexing…' : '';
    }

    const buttons = this.containerEl.querySelectorAll<HTMLButtonElement>(
      '.bloomscroll-reshuffle-btn, .bloomscroll-reshuffle-end-btn'
    );
    buttons.forEach((button) => {
      button.disabled = refreshing;
      if (button.classList.contains('bloomscroll-reshuffle-end-btn')) {
        const defaultLabel = button.dataset.defaultLabel ?? 'Reshuffle';
        button.textContent = refreshing ? 'Indexing…' : defaultLabel;
      }
    });
  }

  private getBatchSettingsKey(): string {
    const { simplifiedView: _simplifiedView, ...batchSettings } =
      this.plugin.data.settings;
    return JSON.stringify(batchSettings);
  }

  private applyFeedModeClass(): void {
    this.containerEl.toggleClass('bloomscroll-feed-mode', this.isFeedMode());
  }

  // Scroll fires far more often than the index can change, so collapse bursts
  // into one read per frame and skip the work when the card hasn't changed.
  private scheduleActiveCardUpdate(container: HTMLElement): void {
    if (this.activeCardFrame !== null) return;
    this.activeCardFrame = window.requestAnimationFrame(() => {
      this.activeCardFrame = null;
      this.updateActiveCard(container);
    });
  }

  private updateActiveCard(container: HTMLElement): void {
    const cardHeight = container.clientHeight;
    if (cardHeight <= 0) return;

    const index = Math.round(container.scrollTop / cardHeight);
    if (index === this.currentCardIndex) return;

    this.currentCardIndex = index;
    this.updateProgress();
    this.updateBookmarkButton();
    this.prefetchAroundActiveCard();
  }

  // Render the next card's snippet before it scrolls into view, so the feed
  // never shows "Loading preview…" mid-swipe.
  private prefetchAroundActiveCard(): void {
    if (!this.isFeedMode()) return;

    const next = this.currentBatch[this.currentCardIndex + 1];
    if (!next) return;

    const card = this.containerEl.querySelector(
      `.bloomscroll-card[data-path="${CSS.escape(next.path)}"]`
    );
    if (!(card instanceof HTMLElement)) return;

    const snippetEl = card.querySelector('.bloomscroll-card-snippet');
    if (snippetEl instanceof HTMLElement) {
      void this.renderSnippet(next, snippetEl);
    }
  }

  private updateProgress(): void {
    if (!this.progressEl) return;

    const total = this.currentBatch.length;
    if (!this.isFeedMode() || total === 0) {
      this.progressEl.textContent = '';
      return;
    }

    // The end panel sits one past the last card; clamp so it reads as complete.
    const position = Math.min(this.currentCardIndex + 1, total);
    this.progressEl.textContent = `${position} / ${total}`;
  }

  private getBookmarksPlugin(): BookmarksPluginInstance | null {
    const app = this.plugin.app as unknown as AppWithInternalPlugins;
    const plugin = app.internalPlugins?.getEnabledPluginById?.('bookmarks');
    if (!isRecord(plugin)) return null;

    // Disabled, missing, or a future rename all land here rather than throwing.
    const instance = plugin as unknown as Partial<BookmarksPluginInstance>;
    if (
      typeof instance.addItem !== 'function' ||
      typeof instance.removeItem !== 'function' ||
      typeof instance.getBookmarks !== 'function'
    ) {
      return null;
    }

    return instance as BookmarksPluginInstance;
  }

  // The card the user is actually looking at. In list mode there is no single
  // active card, so this is meaningful only in feed mode.
  private getActivePreview(): NotePreview | null {
    return this.currentBatch[this.currentCardIndex] ?? null;
  }

  private findBookmark(
    bookmarks: BookmarksPluginInstance,
    path: string
  ): BookmarkItem | null {
    try {
      const items = bookmarks.getBookmarks();
      if (!Array.isArray(items)) return null;
      return (
        items.find(
          (item) =>
            isRecord(item) && item.type === 'file' && item.path === path
        ) ?? null
      );
    } catch (error) {
      console.error('Error reading bookmarks:', error);
      return null;
    }
  }

  private toggleBookmarkForActiveCard(): void {
    const preview = this.getActivePreview();
    if (!preview) return;

    const bookmarks = this.getBookmarksPlugin();
    if (!bookmarks) {
      new Notice('The Bookmarks core plugin is not enabled.');
      return;
    }

    try {
      const existing = this.findBookmark(bookmarks, preview.path);
      if (existing) {
        bookmarks.removeItem(existing);
        new Notice(`Removed bookmark: ${preview.title}`);
      } else {
        bookmarks.addItem({ type: 'file', path: preview.path });
        new Notice(`Bookmarked: ${preview.title}`);
      }
    } catch (error) {
      console.error('Error toggling bookmark:', error);
      new Notice('Could not update bookmarks.');
    }

    this.updateBookmarkButton();
  }

  private updateBookmarkButton(): void {
    const button = this.bookmarkButton;
    if (!button) return;

    // Only meaningful for a single active card, i.e. feed mode.
    if (!this.isFeedMode()) {
      button.hide();
      return;
    }
    button.show();

    const preview = this.getActivePreview();
    const bookmarks = preview ? this.getBookmarksPlugin() : null;
    const bookmarked =
      preview && bookmarks
        ? this.findBookmark(bookmarks, preview.path) !== null
        : false;

    button.disabled = !preview;
    button.toggleClass('is-bookmarked', bookmarked);
    // A filled icon reads as "saved" at a glance; the label carries the action.
    setIcon(button, bookmarked ? 'bookmark-check' : 'bookmark');
    button.setAttribute(
      'aria-label',
      bookmarked ? 'Remove bookmark' : 'Bookmark this note'
    );
    button.setAttribute('aria-pressed', String(bookmarked));
  }

  private isFeedMode(): boolean {
    // Treat missing values from pre-setting data.json files as the default.
    return this.plugin.data.settings.feedMode !== 'list';
  }

  private isSimplifiedView(): boolean {
    // Treat missing values from pre-setting data.json files as the default.
    return this.plugin.data.settings.simplifiedView !== false;
  }

  private setSnippetContent(
    snippetEl: HTMLElement,
    renderedRoot: HTMLElement,
    simplified: boolean
  ): void {
    snippetEl.classList.toggle('bloomscroll-card-snippet-simple', simplified);
    snippetEl.classList.toggle('bloomscroll-card-snippet-markdown', !simplified);
    snippetEl.classList.toggle('markdown-rendered', !simplified);

    const clone = renderedRoot.cloneNode(true) as HTMLElement;
    if (clone.childNodes.length === 0) {
      snippetEl.textContent = '(no preview text)';
      return;
    }
    snippetEl.replaceChildren(...Array.from(clone.childNodes));
  }

  private cacheRenderedSnippet(key: string, renderedRoot: HTMLElement): void {
    // Map insertion order gives us a small LRU cache without retaining every
    // file ever visited during a long-lived Bloomscroll session.
    this.renderedSnippetCache.delete(key);
    this.renderedSnippetCache.set(key, renderedRoot);
    while (this.renderedSnippetCache.size > MAX_RENDERED_SNIPPET_CACHE_ENTRIES) {
      const oldestKey = this.renderedSnippetCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.renderedSnippetCache.delete(oldestKey);
    }
  }

  private renderCard(
    container: HTMLElement,
    preview: NotePreview
  ): HTMLElement {
    const card = container.createDiv('bloomscroll-card');
    card.dataset.path = preview.path;

    // Feed mode constrains the reading column on wide windows; list mode uses
    // the card itself, so the wrapper is transparent to the existing layout.
    const inner = card.createDiv('bloomscroll-card-inner');

    // Title + date row
    const titleRow = inner.createDiv('bloomscroll-card-titlerow');

    const titleEl = titleRow.createEl('h3');
    titleEl.className = 'bloomscroll-card-title';
    titleEl.textContent = preview.title;

    const dateEl = titleRow.createDiv('bloomscroll-card-date');
    const date = new Date(preview.mtime);
    dateEl.textContent = date.toLocaleDateString();

    // Image (lazy loaded)
    if (preview.imagePath) {
      const imageContainer = inner.createDiv(
        'bloomscroll-card-image-container'
      );

      const img = imageContainer.createEl('img');
      img.className = 'bloomscroll-card-image';
      img.dataset.src = preview.imagePath;
      img.dataset.notePath = preview.path;
      img.alt = preview.title;

      // Setup lazy loading via IntersectionObserver
      this.setupImageLazyLoad(img);
    }

    // Snippet is rendered on demand from a bounded Markdown fragment.
    const snippetEl = inner.createDiv('bloomscroll-card-snippet');
    snippetEl.textContent = 'Loading preview…';

    // Click handler. In feed mode a tap that drifts is a swipe, not a click —
    // opening the note then would fight the gesture.
    let pointerDownX = 0;
    let pointerDownY = 0;
    card.addEventListener('pointerdown', (event) => {
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
    });
    card.addEventListener('click', (event) => {
      if (this.isFeedMode()) {
        const dx = Math.abs(event.clientX - pointerDownX);
        const dy = Math.abs(event.clientY - pointerDownY);
        if (dx > TAP_SLOP_PX || dy > TAP_SLOP_PX) return;
      }
      void this.renderSnippet(preview, snippetEl);
      void this.openPreview(preview);
    });

    return card;
  }

  private async renderSnippet(
    preview: NotePreview,
    snippetEl: HTMLElement
  ): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);
    if (!(file instanceof TFile)) {
      snippetEl.textContent = '(no preview text)';
      return;
    }

    const simplified = this.isSimplifiedView();
    const cacheKey = `${simplified ? 'simplified' : 'markdown'}:${file.path}:${file.stat.mtime}`;
    const cached = this.renderedSnippetCache.get(cacheKey);
    if (cached !== undefined) {
      this.cacheRenderedSnippet(cacheKey, cached);
      this.setSnippetContent(snippetEl, cached, simplified);
      return;
    }

    try {
      const content = await this.plugin.app.vault.cachedRead(file);
      const markdown = preparePreviewMarkdown(content);
      const rendered = document.createElement('div');
      const renderComponent = new Component();
      renderComponent.load();
      let prepared: HTMLElement;
      try {
        await MarkdownRenderer.renderMarkdown(
          markdown,
          rendered,
          file.path,
          renderComponent
        );

        prepared = prepareRenderedPreview(rendered, simplified);
      } finally {
        renderComponent.unload();
      }
      this.cacheRenderedSnippet(cacheKey, prepared);
      if (snippetEl.isConnected) {
        this.setSnippetContent(snippetEl, prepared, simplified);
      }
    } catch (error) {
      console.error(`Error rendering preview for ${file.path}:`, error);
      if (snippetEl.isConnected) {
        snippetEl.textContent = preview.snippet ?? '(no preview text)';
      }
    }
  }

  private async openPreview(preview: NotePreview): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);

    if (file instanceof TFile) {
      // A very quick tap can happen before IntersectionObserver fires.
      if (!this.viewedPathsInBatch.has(preview.path)) {
        this.viewedPathsInBatch.add(preview.path);
        this.plugin.data.history = recordView(
          this.plugin.data.history,
          preview.path,
          Date.now()
        );
        this.scheduleHistorySave();
      }

      const behavior = this.plugin.data.settings.openNoteBehavior;
      const leaf =
        behavior === 'reuse'
          ? this.leaf
          : this.plugin.app.workspace.getLeaf(behavior);
      await leaf.openFile(file);
    }
  }

  private setupImageLazyLoad(img: HTMLImageElement): void {
    if (!this.imageObserver) {
      this.imageObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const imgEl = entry.target as HTMLImageElement;
              const src = imgEl.dataset.src;
              const notePath = imgEl.dataset.notePath;

              if (src && notePath) {
                const file = this.plugin.app.vault.getAbstractFileByPath(
                  notePath
                );

                let resolvedSrc: string | null = null;
                if (file instanceof TFile) {
                  resolvedSrc = this.plugin.indexer.resolveImageSrc(
                    src,
                    file
                  );
                }

                if (resolvedSrc) {
                  imgEl.src = resolvedSrc;
                } else {
                  // Couldn't resolve — hide the container instead of showing a broken icon
                  imgEl.closest('.bloomscroll-card-image-container')?.remove();
                }
              }

              if (this.imageObserver) {
                this.imageObserver.unobserve(imgEl);
              }
            }
          });
        },
        { rootMargin: '100px' }
      );
    }

    this.imageObserver.observe(img);
  }

  private scheduleHistorySave(): void {
    this.historySavePending = true;
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
    }
    this.historySaveTimer = window.setTimeout(() => {
      this.historySaveTimer = null;
      void this.flushHistorySave();
    }, HISTORY_SAVE_DELAY_MS);
  }

  private async flushHistorySave(): Promise<void> {
    if (!this.historySavePending) return;
    this.historySavePending = false;
    await this.plugin.saveSettings();
  }

  async onClose(): Promise<void> {
    if (this.cardObserver) {
      this.cardObserver.disconnect();
      this.cardObserver = null;
    }
    if (this.imageObserver) {
      this.imageObserver.disconnect();
      this.imageObserver = null;
    }
    this.renderedSnippetCache.clear();
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    await this.flushHistorySave();
  }
}

function hasSameOrder(
  batch: readonly NotePreview[],
  paths: readonly string[]
): boolean {
  return (
    batch.length === paths.length &&
    batch.every((preview, index) => preview.path === paths[index])
  );
}

function isMediaOnlyPreview(preview: NotePreview): boolean {
  if (preview.mediaOnly) return true;

  // Older cached previews predate the explicit mediaOnly flag.
  return (
    (Boolean(preview.imagePath) && preview.snippet === '(no preview text)') ||
    /^📎 .+ attached$/.test(preview.snippet ?? '')
  );
}

function parseViewState(state: unknown): BloomscrollViewState | null {
  if (!isRecord(state)) return null;

  const batchPaths = stringArray(state.batchPaths);
  const rawHistory = state.batchHistoryPaths;
  if (!batchPaths || !Array.isArray(rawHistory)) return null;

  const batchHistoryPaths: string[][] = [];
  for (const paths of rawHistory) {
    const parsed = stringArray(paths);
    if (!parsed) return null;
    batchHistoryPaths.push(parsed);
  }

  const cursor = state.batchHistoryCursor;
  const scrollTop = state.scrollTop;
  const cardIndex = state.cardIndex;
  return {
    batchPaths,
    batchHistoryPaths,
    batchHistoryCursor:
      typeof cursor === 'number' && Number.isInteger(cursor) ? cursor : 0,
    scrollTop:
      typeof scrollTop === 'number' && Number.isFinite(scrollTop)
        ? Math.max(0, scrollTop)
        : 0,
    // Absent in state saved before feed mode existed.
    cardIndex:
      typeof cardIndex === 'number' && Number.isInteger(cardIndex)
        ? Math.max(0, cardIndex)
        : 0,
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
