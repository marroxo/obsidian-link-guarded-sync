# Link Guarded Sync

Experimental, manual Obsidian synchronization for a specific private Link WebDAV service. Version 0.1.0 uses a fixed service URL; it is not a general-purpose WebDAV client. It has not been tested in Obsidian on iPhone. Use a separate test vault and retain backups before relying on it.

## Install with BRAT

1. Install and enable the Obsidian community plugin **BRAT**.
2. Run **BRAT: Add a beta plugin for testing** and enter `marroxo/obsidian-link-guarded-sync`.
3. Enable **Link Guarded Sync** under Community plugins.

The initial sync requires an empty vault. Enter the Link service credentials in plugin settings, then use **Sync now**. Sync is manual. New notes can upload and unchanged local Markdown files can receive server updates. Divergent edits require review; deletions are not propagated. Binary changes may require separate review.

The password and retained conflict snapshots are stored in plaintext in the vault's plugin settings (`data.json`), not in a device keychain. Other sync providers or device backups may copy these settings. The Link server excludes its configuration directory. Do not share the settings file.

This plugin is not listed in the Obsidian community directory. BRAT and its release are not evidence of iPhone compatibility or production readiness.
