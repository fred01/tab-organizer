// Listen for clicks on the extension icon
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await organizeTabs();
  } catch (error) {
    console.error('Error organizing tabs:', error);
  }
});

const GITHUB_PR_PATH = /^(\/[^/]+\/[^/]+\/pull\/\d+)(?:\/.*)?$/;
const YOUTRACK_ISSUE_PATH = /^(\/issue\/[A-Za-z][A-Za-z0-9]*-\d+)(?:\/.*)?$/;

// Primer's StateLabel statuses of the PR header that mean the PR is done.
const FINISHED_PR_STATUSES = new Set(['pullMerged', 'pullClosed']);
const PAGE_CHECK_CONCURRENCY = 4;
const PAGE_LOAD_TIMEOUT_MS = 30000;

async function organizeTabs() {
  // Get all tabs in the current window
  const tabs = await chrome.tabs.query({ currentWindow: true });

  // Step 1: Close duplicate tabs (keep only one tab per URL)
  await closeDuplicateTabs(tabs);

  // Step 2: Close merged/closed PRs and resolved YouTrack issues. Runs after
  // dedup so that each page is loaded and checked only once.
  await closeFinishedTabs(await chrome.tabs.query({ currentWindow: true }));

  // Step 3: Get updated tabs list after closing tabs
  const remainingTabs = await chrome.tabs.query({ currentWindow: true });

  // Step 4: Group tabs by hostname
  await groupTabsByHostname(remainingTabs);
}

// 'pr' for a GitHub pull request, 'issue' for a YouTrack issue, otherwise null.
function trackedPageKind(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    return null;
  }
  if (url.hostname === 'github.com' && GITHUB_PR_PATH.test(url.pathname)) {
    return 'pr';
  }
  if (url.hostname === 'youtrack.jetbrains.com' && YOUTRACK_ISSUE_PATH.test(url.pathname)) {
    return 'issue';
  }
  return null;
}

async function closeFinishedTabs(tabs) {
  const candidates = tabs.filter(tab => trackedPageKind(tab.url));
  const finished = [];
  await forEachLimited(candidates, PAGE_CHECK_CONCURRENCY, async (tab) => {
    try {
      if (await isFinished(tab)) {
        finished.push(tab.id);
      }
    } catch (error) {
      // A tab that can't be read (closed meanwhile, error page) is kept.
      console.warn(`Could not check ${tab.url}:`, error);
    }
  });
  if (finished.length > 0) {
    await chrome.tabs.remove(finished);
  }
}

async function isFinished(tab) {
  const kind = trackedPageKind(tab.url);
  // Discarded tabs and tabs not restored since the browser started have no page
  // to read, so they are loaded first.
  const reload = tab.discarded || tab.status === 'unloaded';
  const loaded = waitForTabComplete(tab.id, !reload);
  if (reload) {
    await chrome.tabs.reload(tab.id);
  }
  await loaded;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readPageState,
    args: [kind],
  });
  return kind === 'pr' ? FINISHED_PR_STATUSES.has(result) : result === 'resolved';
}

function waitForTabComplete(tabId, acceptCurrent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('page load timed out'));
    }, PAGE_LOAD_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    function onUpdated(updatedId, changeInfo) {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        done();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    if (!acceptCurrent) {
      return;
    }
    // The tab may have finished loading before the listener was attached.
    chrome.tabs.get(tabId).then(t => {
      if (t.status === 'complete') {
        done();
      }
    }, reject);
  });
}

// Injected into the page. Both sites render client-side, so 'complete' can come
// before the marker exists; poll for it. Returns null when it never appears.
function readPageState(kind) {
  return new Promise(resolve => {
    const deadline = Date.now() + 10000;
    const check = () => {
      let state = null;
      if (kind === 'pr') {
        // The first StateLabel on a PR page is the header's.
        const label = document.querySelector('[data-component="StateLabel"][data-status]');
        state = label ? label.dataset.status : null;
      } else {
        // Resolved issues get a summaryResolved__<hash> class, which is what greys the title.
        const summary = document.querySelector('h1[data-test="ticket-summary"]');
        if (summary) {
          state = [...summary.classList].some(c => c.startsWith('summaryResolved')) ? 'resolved' : 'unresolved';
        }
      }
      if (state || Date.now() > deadline) {
        resolve(state);
      } else {
        setTimeout(check, 250);
      }
    };
    check();
  });
}

async function forEachLimited(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await fn(queue.shift());
    }
  });
  await Promise.all(workers);
}

// Normalize a URL so that different views of the same resource collapse to one
// canonical form. GitHub PR subpages (/pull/62/files, /commits, ...) and
// YouTrack issue slugs (/issue/ORCA-455/Some-Title) all map to the bare URL.
function canonicalizeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    return rawUrl;
  }

  // github.com/<owner>/<repo>/pull/<n>[/changes|/files|/commits|...] -> .../pull/<n>
  if (url.hostname === 'github.com') {
    const match = url.pathname.match(GITHUB_PR_PATH);
    if (match) {
      return url.origin + match[1];
    }
  }

  // youtrack.jetbrains.com/issue/<ID>[/slug...] -> .../issue/<ID>
  if (url.hostname === 'youtrack.jetbrains.com') {
    const match = url.pathname.match(YOUTRACK_ISSUE_PATH);
    if (match) {
      return url.origin + match[1];
    }
  }

  return rawUrl;
}

async function closeDuplicateTabs(tabs) {
  // Group tabs by their canonical URL
  const urlMap = new Map();
  for (const tab of tabs) {
    const key = canonicalizeUrl(tab.url);
    if (!urlMap.has(key)) {
      urlMap.set(key, []);
    }
    urlMap.get(key).push(tab);
  }

  // For each canonical URL with duplicates, keep one winner and close the rest.
  // The winner is the tab already sitting on the canonical URL (e.g. .../pull/62),
  // otherwise the leftmost tab.
  const tabsToClose = [];
  for (const [canonicalUrl, tabsWithUrl] of urlMap.entries()) {
    if (tabsWithUrl.length > 1) {
      tabsWithUrl.sort((a, b) => a.index - b.index);
      const winner = tabsWithUrl.find(t => t.url === canonicalUrl) || tabsWithUrl[0];
      for (const tab of tabsWithUrl) {
        if (tab.id !== winner.id) {
          tabsToClose.push(tab.id);
        }
      }
    }
  }

  // Close duplicate tabs
  if (tabsToClose.length > 0) {
    await chrome.tabs.remove(tabsToClose);
  }
}

async function groupTabsByHostname(tabs) {
  // Create a map to group tabs by hostname
  const hostnameMap = new Map();
  
  // Group tabs by hostname
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url);
      const hostname = url.hostname;
      
      if (!hostnameMap.has(hostname)) {
        hostnameMap.set(hostname, []);
      }
      hostnameMap.get(hostname).push(tab);
    } catch (error) {
      // Skip invalid URLs (like chrome://, about:, etc.)
      continue;
    }
  }
  
  // Find the leftmost tab for each hostname
  const hostnamePositions = new Map();
  for (const [hostname, tabsInHostname] of hostnameMap.entries()) {
    const minIndex = Math.min(...tabsInHostname.map(t => t.index));
    hostnamePositions.set(hostname, minIndex);
  }
  
  // Sort hostnames by their leftmost tab position
  const sortedHostnames = Array.from(hostnameMap.keys()).sort((a, b) => {
    return hostnamePositions.get(a) - hostnamePositions.get(b);
  });
  
  // Move tabs to group them by hostname
  let targetIndex = 0;
  for (const hostname of sortedHostnames) {
    const tabsInHostname = hostnameMap.get(hostname);
    
    // Sort tabs within the same hostname by their original index
    tabsInHostname.sort((a, b) => a.index - b.index);
    
    // Move each tab to its new position
    for (const tab of tabsInHostname) {
      await chrome.tabs.move(tab.id, { index: targetIndex });
      targetIndex++;
    }
  }
}
