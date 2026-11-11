// The MCP server evaluates chrome.tabs / chrome.tabGroups calls inside this worker over CDP.
// Nothing runs on its own; the listener only keeps the worker instantiable.
chrome.runtime.onInstalled.addListener(() => {});
