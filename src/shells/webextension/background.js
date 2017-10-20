import debugConnection from '../../utils/debugConnection';

/*
 * background.js
 *
 * Runs all the time and serves as a central message hub for panels, contentScript, backend
 */

const orphansByTabId = {};

function getActiveContentWindow(cb) {
  chrome.tabs.query({ active: true, windowType: 'normal', currentWindow: true }, (d) => {
    if (d.length > 0) {
      cb(d[0]);
    }
  });
}

function openWindow(contentTabId) {
  const devtoolWidth = window.screen.availWidth > 1366 ? 400 : 350;
  // Resize main window
  chrome.windows.getCurrent((wind) => {
    if (wind.left + wind.width > window.screen.availWidth - devtoolWidth) {
      const newWidth = Math.min(window.screen.availWidth - devtoolWidth, wind.width);
      chrome.windows.update(wind.id, {
        left: window.screen.availWidth - devtoolWidth - newWidth,
        top: wind.top,
        width: newWidth,
        height: wind.height,
      });
    }
  });
  // Open devtools window
  chrome.windows.create(
    {
      type: 'popup',
      url: chrome.extension.getURL('window.html#window'),
      width: devtoolWidth,
      height: window.screen.availHeight,
      top: 0,
      left: window.screen.availWidth - devtoolWidth,
    },
    (win) => {
      function closeListener(tabId) {
        if (tabId === contentTabId || tabId === win.tabs[0].id) {
          chrome.tabs.onRemoved.removeListener(closeListener);
          chrome.windows.remove(win.id);
        }
      }
      chrome.tabs.onRemoved.addListener(closeListener);
    }
  );
}

function isNumeric(str) {
  return `${+str}` === str;
}

function handleInstallError(tabId, error) {
  if (__DEV__) console.warn(error); // eslint-disable-line no-console
  const orphanDevtools = orphansByTabId[tabId].find(p => !p.contentScript).map(p => p.devtools);
  orphanDevtools.forEach(d => d.postMessage('content-script-installation-error'));
}

function installContentScript(tabId) {
  chrome.tabs.get(+tabId, (tab) => {
    if (chrome.runtime.lastError) {
      handleInstallError(tabId, chrome.runtime.lastError);
    } else if (tab.status === 'complete') {
      chrome.tabs.executeScript(tabId, { file: '/contentScript.js' }, (res) => {
        const err = chrome.runtime.lastError;
        if (err || !res) handleInstallError(tabId, err);
      });
    } else {
      chrome.tabs.onUpdated.addListener(function listener(tid, changeInfo) {
        if (tid !== tabId || changeInfo.status === 'loading') return;
        chrome.tabs.onUpdated.removeListener(listener);
        installContentScript(tabId);
      });
    }
  });
}

function doublePipe(one, two) {
  if (!one.$i) {
    one.$i = Math.random()
      .toString(32)
      .slice(2);
  }
  if (!two.$i) {
    two.$i = Math.random()
      .toString(32)
      .slice(2);
  }

  debugConnection(`BACKGORUND: connect ${one.name} <-> ${two.name} [${one.$i} <-> ${two.$i}]`);

  function lOne(message) {
    debugConnection(`${one.name} -> BACKGORUND -> ${two.name} [${one.$i}-${two.$i}]`, message);
    try {
      two.postMessage(message);
    } catch (e) {
      if (__DEV__) console.error('Unexpected disconnect, error', e); // eslint-disable-line no-console
      shutdown(); // eslint-disable-line no-use-before-define
    }
  }
  function lTwo(message) {
    debugConnection(`${two.name} -> BACKGORUND -> ${one.name} [${two.$i}-${one.$i}]`, message);
    try {
      one.postMessage(message);
    } catch (e) {
      if (__DEV__) console.error('Unexpected disconnect, error', e); // eslint-disable-line no-console
      shutdown(); // eslint-disable-line no-use-before-define
    }
  }
  one.onMessage.addListener(lOne);
  two.onMessage.addListener(lTwo);
  function shutdown() {
    debugConnection(`SHUTDOWN ${one.name} <-> ${two.name} [${one.$i} <-> ${two.$i}]`);
    one.onMessage.removeListener(lOne);
    two.onMessage.removeListener(lTwo);
    one.disconnect();
    two.disconnect();
  }
  one.onDisconnect.addListener(shutdown);
  two.onDisconnect.addListener(shutdown);
}

chrome.contextMenus.onClicked.addListener(({ menuItemId }, contentWindow) => {
  openWindow(contentWindow.id);
});

chrome.commands.onCommand.addListener((shortcut) => {
  if (shortcut === 'open-devtools-window') {
    getActiveContentWindow((contentWindow) => {
      window.contentTabId = contentWindow.id;
      openWindow(contentWindow.id);
    });
  }
});

chrome.browserAction.onClicked.addListener((tab) => {
  window.contentTabId = tab.id;
  openWindow(tab.id);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'mobx-devtools',
    title: 'Open Mobx DevTools',
    contexts: ['all'],
  });
});

chrome.runtime.onConnect.addListener((port) => {
  let tab = null;
  let name = null;
  if (isNumeric(port.name)) {
    tab = port.name;
    name = 'devtools';
    installContentScript(+port.name);
  } else {
    tab = port.sender.tab.id;
    name = 'content-script';
  }

  if (!orphansByTabId[tab]) {
    orphansByTabId[tab] = [];
  }

  if (name === 'content-script') {
    const orphan = orphansByTabId[tab].find(t => t.name === 'devtools');
    if (orphan) {
      doublePipe(orphan.port, port);
      orphansByTabId[tab] = orphansByTabId[tab].filter(t => t !== orphan);
    } else {
      const newOrphan = { name, port };
      orphansByTabId[tab].push(newOrphan);
      port.onDisconnect.addListener(() => {
        if (__DEV__) console.warn('orphan devtools disconnected'); // eslint-disable-line no-console
        orphansByTabId[tab] = orphansByTabId[tab].filter(t => t !== newOrphan);
      });
    }
  } else if (name === 'devtools') {
    const orphan = orphansByTabId[tab].find(t => t.name === 'content-script');
    if (orphan) {
      orphansByTabId[tab] = orphansByTabId[tab].filter(t => t !== orphan);
    } else {
      const newOrphan = { name, port };
      orphansByTabId[tab].push(newOrphan);
      port.onDisconnect.addListener(() => {
        if (__DEV__) console.warn('orphan content-script disconnected'); // eslint-disable-line no-console
        orphansByTabId[tab] = orphansByTabId[tab].filter(t => t !== newOrphan);
      });
    }
  }
});