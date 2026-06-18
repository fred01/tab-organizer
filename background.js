// Listen for clicks on the extension icon
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await organizeTabs();
  } catch (error) {
    console.error('Error organizing tabs:', error);
  }
});

async function organizeTabs() {
  // Get all tabs in the current window
  const tabs = await chrome.tabs.query({ currentWindow: true });
  
  // Step 1: Close duplicate tabs (keep only one tab per URL)
  await closeDuplicateTabs(tabs);
  
  // Step 2: Get updated tabs list after closing duplicates
  const remainingTabs = await chrome.tabs.query({ currentWindow: true });
  
  // Step 3: Group tabs by hostname
  await groupTabsByHostname(remainingTabs);
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
    const match = url.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)(?:\/.*)?$/);
    if (match) {
      return url.origin + match[1];
    }
  }

  // youtrack.jetbrains.com/issue/<ID>[/slug...] -> .../issue/<ID>
  if (url.hostname === 'youtrack.jetbrains.com') {
    const match = url.pathname.match(/^(\/issue\/[A-Za-z][A-Za-z0-9]*-\d+)(?:\/.*)?$/);
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
