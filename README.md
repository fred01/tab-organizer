# Tab Organizer

A Chrome extension to organize your tabs efficiently with a single click!

## Features

- **Close Duplicate Tabs**: Automatically closes all tabs with identical URLs, keeping only one instance of each page
- **Close Finished PRs and Issues**: Closes GitHub pull requests that are merged or closed, and YouTrack issues (youtrack.jetbrains.com) that are resolved — the ones with a greyed-out title
- **Group by Hostname**: Groups all tabs from the same website together, starting from the leftmost tab of each hostname

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top-right corner
4. Click "Load unpacked" and select the directory containing this extension
5. The mop icon should now appear in your Chrome toolbar

## Usage

Simply click the mop icon in your Chrome toolbar to organize your tabs. The extension will:

1. First, scan all tabs in the current window and close duplicates (keeping one tab per unique URL)
2. Close merged/closed PRs and resolved YouTrack issues. The state is read from the page itself, with your
   browser session — no tokens. Tabs Chrome has unloaded are reloaded for the check, at most 4 at a time, so a
   window with many such tabs takes a while
3. Then, group remaining tabs by hostname, placing them together starting from the leftmost tab of each domain

## Example

Before organizing:
```
Tab 1: https://github.com/user/repo1
Tab 2: https://stackoverflow.com/question1
Tab 3: https://github.com/user/repo2
Tab 4: https://stackoverflow.com/question1 (duplicate)
Tab 5: https://google.com/search
Tab 6: https://github.com/user/repo3
```

After organizing:
```
Tab 1: https://github.com/user/repo1
Tab 2: https://github.com/user/repo2
Tab 3: https://github.com/user/repo3
Tab 4: https://stackoverflow.com/question1
Tab 5: https://google.com/search
```

## Permissions

This extension requires the `tabs` permission to:
- Query and access tab information (URLs, positions)
- Close duplicate tabs
- Reorder tabs by hostname

and the `scripting` permission with access to `github.com` and `youtrack.jetbrains.com` to read the state of
pull request and issue pages.

## License

MIT
