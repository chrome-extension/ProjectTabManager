/*
Copyright 2020 Eiji Kitamura

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Author: Eiji Kitamura (agektmr@gmail.com)
*/

import { Config } from './Config';
import { ProjectManager } from './ProjectManager';
import { SessionManager } from './SessionManager';
import { BookmarkManager } from './BookmarkManager';
import { Util } from './Util';

let projectManager: ProjectManager;

chrome.runtime.onInstalled.addListener(details => {
  // Pop up history page only if the version changes in major (ex 2.0.0) or minor (ex 2.1.0).
  // Trivial change (ex 2.1.1) won't popu up.
  if (details.reason === 'update' &&
      chrome.runtime.getManifest().version.match(/0$/)) {
    chrome.tabs.create({url: chrome.extension.getURL('/CHANGELOG.html')});

  // Pop up help page on first installation
  } else if (details.reason === 'install') {
    chrome.tabs.create({url: chrome.extension.getURL('/README.html')});
  }
});

(async () => {
  const config = new Config();
  await config.init();
  Util.configure(config);
  BookmarkManager.configure(config);
  const sessionManager = new SessionManager(config);
  await sessionManager.resumeSessions()
  projectManager = new ProjectManager(config, sessionManager);
  await projectManager.update();
  chrome.runtime.onMessage.addListener(async (msg, sender, respond) => {
    /**
     * **Commands**
     * update: {
     *   forceReload: boolean
     * }
     * createProject: {
     *   projectId: string
     *   title: string
     * }
     * renameProject: {
     *   projectId: string
     *   title: string
     * }
     * removeProject: {
     *   projectId: string
     * }
     * getActiveProject: {}
     * getConfig: {}
     * setConfig: {
     *   config: SyncConfig
     * }
     * openBookmarkEditWindow: {}
     * openHelp: {}
     */
    const params = msg.filter((key: string) => key != 'command');
    console.log('received command:', msg.command);
    // @ts-ignore
    const result = await ProjectManager.prototype[msg.command].apply(projectManager, params);
    respond(result);
    return true;
  });
})();
