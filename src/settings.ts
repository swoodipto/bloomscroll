import {
  App,
  Notice,
  normalizePath,
  PluginSettingTab,
  Setting,
} from 'obsidian';
import * as obsidian from 'obsidian';
import BloomscrollPlugin from './main';
import { PluginSettings } from './types';

const GITHUB_URL = 'https://github.com/yaroshevych/bloomscroll';
const ISSUES_URL = `${GITHUB_URL}/issues`;

// `AbstractInputSuggest` is not exported by the mobile (iOS/Android) builds of
// Obsidian. Referencing it at module scope makes the whole plugin fail to load
// there, so the subclass is created on demand and skipped when unavailable.
type FolderSuggestInstance = { close(): void };

let folderSuggestCtor:
  | (new (app: App, inputEl: HTMLInputElement) => FolderSuggestInstance)
  | null
  | undefined;

function getFolderSuggestCtor() {
  if (folderSuggestCtor !== undefined) return folderSuggestCtor;

  const Base = (
    obsidian as unknown as {
      AbstractInputSuggest?: new (app: App, inputEl: HTMLInputElement) => object;
    }
  ).AbstractInputSuggest;

  if (typeof Base !== 'function') {
    folderSuggestCtor = null;
    return folderSuggestCtor;
  }

  folderSuggestCtor = class FolderSuggest extends (Base as new (
    app: App,
    inputEl: HTMLInputElement
  ) => {
    app: App;
    close(): void;
  }) {
    inputEl: HTMLInputElement;
    private cachedFolders: string[] | null = null;

    constructor(app: App, inputEl: HTMLInputElement) {
      super(app, inputEl);
      this.inputEl = inputEl;
    }

    private getFolders(): string[] {
      if (this.cachedFolders) return this.cachedFolders;

      this.cachedFolders = this.app.vault
        .getAllFolders()
        .map((folder) => folder.path)
        .filter((path) => path.length > 0);
      return this.cachedFolders;
    }

    getSuggestions(inputStr: string): string[] {
      const lowerInput = inputStr.toLowerCase();
      return this.getFolders().filter((path) =>
        path.toLowerCase().includes(lowerInput)
      );
    }

    renderSuggestion(path: string, el: HTMLElement): void {
      el.setText(path);
    }

    selectSuggestion(path: string): void {
      this.inputEl.value = path;
      this.close();
    }
  };

  return folderSuggestCtor;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  batchSize: 20,
  feedMode: 'feed',
  includeMediaOnlyNotes: true,
  simplifiedView: true,
  openNoteBehavior: 'tab',
  excludeFolders: [],
  excludeTags: [],
  excludeGlobs: [],
  frontmatterImageProps: ['cover', 'image', 'banner'],
};

export class BloomscrollSettingTab extends PluginSettingTab {
  plugin: BloomscrollPlugin;

  constructor(app: App, plugin: BloomscrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    configureHeader(new Setting(containerEl));

    new Setting(containerEl)
      .setName('Feed mode')
      .setDesc(
        'Feed shows one note at a time, filling the screen; list scrolls through all cards continuously.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            feed: 'Feed (one at a time)',
            list: 'List (continuous scroll)',
          })
          .setValue(this.plugin.data.settings.feedMode === 'list' ? 'list' : 'feed')
          .onChange(async (value) => {
            if (value !== 'feed' && value !== 'list') return;
            this.plugin.data.settings.feedMode = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Batch size')
      .setDesc('Number of cards to show per reshuffle')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ '10': '10', '20': '20', '50': '50', '100': '100' })
          .setValue(String(this.plugin.data.settings.batchSize))
          .onChange(async (value) => {
            this.plugin.data.settings.batchSize = Number(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Include media-only notes')
      .setDesc('Show notes that contain only images, PDFs, or other attachments')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.includeMediaOnlyNotes)
          .onChange(async (value) => {
            this.plugin.data.settings.includeMediaOnlyNotes = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Simplified view')
      .setDesc(
        'Show concise previews with readable tables, links, and code; turn off for full Markdown formatting.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.simplifiedView !== false)
          .onChange(async (value) => {
            this.plugin.data.settings.simplifiedView = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Open notes in')
      .setDesc('Choose where a card opens')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            tab: 'New tab',
            reuse: 'Reuse current tab',
            window: 'New window',
          })
          .setValue(this.plugin.data.settings.openNoteBehavior)
          .onChange(async (value) => {
            if (value !== 'tab' && value !== 'reuse' && value !== 'window') {
              return;
            }
            this.plugin.data.settings.openNoteBehavior = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Exclude tags')
      .setDesc('Tags to skip without # (one per line)')
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.excludeTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.excludeTags = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Exclude filename patterns')
      .setDesc('Filename patterns to skip (one per line, e.g., _*)')
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.excludeGlobs.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.excludeGlobs = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Frontmatter image properties')
      .setDesc(
        'Property names to check for images in frontmatter (one per line)'
      )
      .addTextArea((text) =>
        text
          .setValue(this.plugin.data.settings.frontmatterImageProps.join('\n'))
          .onChange(async (value) => {
            this.plugin.data.settings.frontmatterImageProps = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl).setName('Excluded folders').setHeading();

    const excludedFoldersList = containerEl.createDiv(
      'bloomscroll-excluded-folders-list'
    );
    this.renderExcludedFolders(excludedFoldersList);

    let folderInputEl: HTMLInputElement;
    new Setting(containerEl)
      .setName('Add excluded folder')
      .setDesc('Folders to exclude from the feed')
      .addText((text) => {
        text.setPlaceholder('4. Archive');
        folderInputEl = text.inputEl;
        const FolderSuggestCtor = getFolderSuggestCtor();
        if (FolderSuggestCtor) {
          new FolderSuggestCtor(this.app, folderInputEl);
        }
      })
      .addButton((button) =>
        button.setButtonText('Add').onClick(async () => {
          const folder = normalizeFolderPath(folderInputEl.value);
          if (!folder || folder === '.') {
            new Notice('Excluded folder path cannot be empty or the vault root');
            return;
          }
          if (this.plugin.data.settings.excludeFolders.includes(folder)) {
            new Notice('That folder is already excluded');
            return;
          }

          this.plugin.data.settings.excludeFolders.push(folder);
          await this.plugin.saveSettingsAndRefreshViews();
          folderInputEl.value = '';
          this.renderExcludedFolders(excludedFoldersList);
        })
      );
  }

  private renderExcludedFolders(container: HTMLElement): void {
    container.empty();

    if (this.plugin.data.settings.excludeFolders.length === 0) {
      container.createDiv({ text: 'No excluded folders' });
      return;
    }

    for (const folder of this.plugin.data.settings.excludeFolders) {
      const row = container.createDiv('bloomscroll-excluded-folder-item');
      row.createSpan({ text: folder });
      row
        .createEl('button', {
          text: '×',
          cls: 'bloomscroll-excluded-folder-remove',
          attr: { 'aria-label': `Remove excluded folder ${folder}` },
        })
        .addEventListener('click', async () => {
          const index = this.plugin.data.settings.excludeFolders.indexOf(folder);
          if (index === -1) return;
          this.plugin.data.settings.excludeFolders.splice(index, 1);
          await this.plugin.saveSettingsAndRefreshViews();
          this.renderExcludedFolders(container);
        });
    }
  }

}

function configureHeader(setting: Setting): void {
  setting
    .setClass('bloomscroll-settings-header')
    .setName('Bloomscroll settings')
    .setHeading()
    .addButton((button) =>
      button.setButtonText('GitHub').onClick(() => {
        window.open(GITHUB_URL, '_blank');
      })
    )
    .addButton((button) =>
      button.setButtonText('Report issue').onClick(() => {
        window.open(ISSUES_URL, '_blank');
      })
    );
}

function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeFolderPath(value: string): string {
  return normalizePath(value.trim()).replace(/\/+$/, '');
}
