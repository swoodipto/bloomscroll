# ꕤ bloomscroll

**~~doom~~scroll for your digital garden.** i stumbled on a little Obsidian plugin called [Doomscroll](https://github.com/yaroshevych/doomscroll) by @yaroshevych, [on Reddit](https://www.reddit.com/r/ObsidianMD/comments/1w6xf0q/doomscroll_new_plugin_for_rediscovering_and/), and my brain immediately went "didnt I want to do something like this?" - it lived rent-free in my head and never became a real thing.

now that a real instagram engineer already built the engine, i thought why not extend it to polish the experience further and add my own visual and experiencial twist to it.

hence ꕤ bloomscroll was born. its the same brain underneath by @yaroshevych, but with my own take on how it looks and feels, a few extended features, and some coat of polish.

## features

- noice interface, with little paper texture and polished details
- bookmark notes from the scroll feed to get back to later
- switch between list view (as in the original plugin) and "bloomscroll" view that replicates the doomscroll experience
- all features from [the original plugin](https://github.com/yaroshevych/doomscroll#features)

## planned

- curated personal feed based on tags, folders etc.
- visually rich feed based on the type of note
- perhaps more playfulness and delight? idk how yet, but i WANT it.

## installation

1. clone this repository into your vault's `.obsidian/plugins/` directory:
   ```
   git clone https://github.com/swoodipto/bloomscroll .obsidian/plugins/bloomscroll
   ```

2. navigate to the plugin directory and install dependencies:
   ```
   cd .obsidian/plugins/bloomscroll
   npm install
   ```

3. build the plugin:
   ```
   npm run build
   ```

4. enable the plugin in Obsidian settings under **Community plugins**.

## license

MIT