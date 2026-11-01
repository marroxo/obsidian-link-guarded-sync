# Link Guarded Sync

Experimental plugin for a specific Link service. Supports the fixed production vault and an isolated test vault. Tested with mocks and a local HTTP fixture, not yet on iPhone.

Select the connection in an empty vault before entering credentials and before first sync. The selection locks once synchronization starts. Sync runs after saved edits in the foreground, when Obsidian opens or returns to the foreground, and can also be started manually. It does not run in the background. Deletions are not propagated. Conflicting edits require review.

Credentials and archived conflict snapshots are stored in plaintext in plugin data.json; device backups or other sync services may copy them. Keep backups and do not share that file.
