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

async function closeDuplicateTabs(tabs) {
  // Create a map to track URLs and their tabs
  const urlMap = new Map();
  
  // Group tabs by URL
  for (const tab of tabs) {
    if (!urlMap.has(tab.url)) {
      urlMap.set(tab.url, []);
    }
    urlMap.get(tab.url).push(tab);
  }
  
  // For each URL with duplicates, close all but the first one
  const tabsToClose = [];
  for (const [url, tabsWithUrl] of urlMap.entries()) {
    if (tabsWithUrl.length > 1) {
      // Keep the first tab, close the rest
      for (let i = 1; i < tabsWithUrl.length; i++) {
        tabsToClose.push(tabsWithUrl[i].id);
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
