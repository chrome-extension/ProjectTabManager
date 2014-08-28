var SessionManager = (function() {
  var config_ = null,
      db      = null;

  /**
   * [getWindowInfo description]
   * @param  {Integer}   winId    [description]
   * @param  {Function} callback [description]
   */
  var getWindowInfo = function(winId, callback) {
    if (winId === chrome.windows.WINDOW_ID_NONE) {
      callback(undefined);
    } else {
      chrome.windows.get(winId, {populate:true}, function(win) {
        if (chrome.runtime.lastError) {
          throw '[SessionManager] window of id '+winId+' not open';
        }
        if (win.type !== "normal") {
          callback(undefined);
        } else {
          callback(win);
        }
      });
    }
  }

  /**
   * Synchronize session status on chrome.storage
   */
  var UpdateManager = {
    queue: [],

    /**
     * [initialize description]
     */
    restoreSessions: function(callback) {
      // restore projects from chrome.storage.local
      chrome.storage.local.get((function(items) {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError.message);
          throw '[UpdateManager] chrome.storage.local.get error'
        } else {
          var sessions = items['sessions'] || items['projects'] || []; // 'projects' is a transitional solution
          if (config_.debug) console.log('[UpdateManager] restoring sessions from storage.', sessions);
          callback(sessions);
        }
      }).bind(this));
    },

    /**
     * Synchronize project status to chrome.storage. Restores when on initialization.
     */
    storeSessions: function() {
      chrome.storage.local.set(sessionManager.export(), function() {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError.message);
        } else {
          if (config.debug) console.log('[UpdateManager] sessions stored.', sessionManager.sessions);
        }
      });
    },

    /**
     * Add sync status to queue so that synchronization only happens when all status is clear.
     * @param {chrome.tabs.Tab} tab
     */
    tabLoading: function(tab) {
      for (var i = 0; i < UpdateManager.queue.length; i++) {
        if (UpdateManager.queue[i].id === tab.id) {
          UpdateManager.queue[i] = tab;
          if (config.debug) console.log('[UpdateManager] tab %o loading. %d in total', tab, UpdateManager.queue.length);
          return;
        }
      }
      UpdateManager.queue.push(tab);
      if (config.debug) console.log('[UpdateManager] added tab %o. %d in total.', tab, UpdateManager.queue.length);
    },

    /**
     * Removes completed sync status and kick start synchronization when all queue's gone.
     * @param {chrome.tabs.Tab} tab
     */
    tabComplete: function(tab) {
      for (var i = 0; i < UpdateManager.queue.length; i++) {
        if (UpdateManager.queue[i].id === tab.id) {
          UpdateManager.queue.splice(i, 1);
          break;
        }
      }
      if (UpdateManager.queue.length === 0) {
        if (config.debug) console.log('[UpdateManager] Queue cleared. Storing session.');
        UpdateManager.storeSessions();
      } else {
        if (config.debug) console.log('[UpdateManager] tab %o sync completed. %o remaining', tab, UpdateManager.queue);
      }
    },
  };

  /**
   *  Tab entity which represents chrome.tabs.Tab
   *  @param {chrome.tabs.Tab} tab
   **/
  var TabEntity = function(tab) {
    var url =         util.unlazify(tab.url),
        domain =      url.replace(/^.*?\/\/(.*?)\/.*$/, "$1");

    this.id =         tab.id;
    // this.index =      tab.index; // TODO: see if `.index` can be deprecated
    this.title =      tab.title;
    this.url =        url;
    this.pinned =     tab.pinned || false;
    this.favIconUrl = tab.favIconUrl || 'http://www.google.com/s2/favicons?domain='+encodeURIComponent(domain);
  };

  /**
   * Window entity which represents chrome.windows.Window
   * @param {chrome.windows.Window} win
   */
  var SessionEntity = function(target) {
    // if target.focused is set, target is chrome.windows.Window object
    if (target.focused !== undefined) {
      this.id     = '-'+target.id; // project id for non-bound session can be anything as long as it's unique.
      this.winId  = target.id;
      this.title  = (new Date()).toLocaleString();

    // if project id is null, this is non-bound session (transitional solution)
    } else if (target.id === null) {
      this.id     = '-'+Math.floor(Math.random() * 100000);
      this.winId  = null;
      this.title  = (new Date()).toLocaleString();

    // otherwise, target is SessionEntity object recovering from previous session
    } else {
      this.id     = target.id;
      this.winId  = null;
      this.title  = target.title;
    }

    this.tabs   = [];
    if (target.tabs) {
      for (var i = 0; i < target.tabs.length; i++) {
        this.addTab(target.tabs[i]);
      }
    }
    if (config_.debug) console.log('[SessionEntity] Created new session entity %o', this);
  };
  SessionEntity.prototype = {
    /**
     * Rename session title
     * @param {String} name
     */
    rename: function(name) {
      this.title = name;
    },

    /**
     * Adds tab entity of given chrome.tabs.Tab
     * @param {chrome.tabs.Tab} tab
     */
    addTab: function(tab) {
      if (tab && !tab.url.match(util.CHROME_EXCEPTION_URL)) {
        // Create new tab entity
        this.tabs.push(new TabEntity(tab));
        this.sortTabs();
      }
    },

    /**
     * Gets tab entity of given tab id
     * @param  {Integer} tabId
     * @return {TabEntity|undefined}
     */
    getTab: function(tabId) {
      for (var i = 0; i < this.tabs.length; i++) {
        if (this.tabs[i].id === tabId) {
          return this.tabs[i];
        }
      }
      return undefined;
    },

    /**
     *  Update TabEntity
     *  @param {chrome.tabs.Tab} tab  Tab object to update
     */
    updateTab: function(tab) {
      if (!tab.url.match(util.CHROME_EXCEPTION_URL)) {
        // Loop through all tabs and look for tab with similar url
        for (var i = 0; i < this.tabs.length; i++) {
          if (this.tabs[i].id === tab.id) {
            // TODO: better logic
            var new_tab = new TabEntity(tab);
            if (config_.debug) console.log('[SessionEntity] updating tab %o to %o', this.tabs[i], new_tab);
            delete this.tabs[i];
            this.tabs[i] = new_tab;
            return;
          }
        }
        this.addTab(tab);
      }
    },

    /**
     *  Removes TabEntity
     *  @param    {Integer} tabId   id of a tab to remove
     *  @returns  {Boolean}
     **/
    removeTab: function(tabId) {
      for (var i = 0; i < this.tabs.length; i++) {
        if (this.tabs[i].id === tabId) {
          if (config_.debug) console.log('[SessionEntity] removed tab %d from session %s', this.tabs[i].id, this.id);
          // Remove TabEntity
          this.tabs.splice(i, 1);
          if (this.tabs.length > 0) {
            this.sortTabs();
          }
          return true;
        }
      }
      return false;
    },

    /**
     *  Sort TabEntity
     *  @returns  void
     **/
    sortTabs: function() {
      // Skip if there's no winId
      if (this.winId === null) return;

      // Sort tab order
      chrome.windows.get(this.winId, {populate:true}, (function onWindowsGet(win) {
        var tmp = [];
        for (var i = 0; i < win.tabs.length; i++) {
          if (win.tabs[i].url.match(util.CHROME_EXCEPTION_URL)) continue;
          var tab = this.getTab(win.tabs[i].id);
          if (tab) {
            // tab.index = win.tabs[i].index;
            tmp.push(tab);
          }
        }
        // Isn't this leaking memory?
        this.tabs = tmp;
      }).bind(this));
      return;
    },

    /**
     * Gets Array of tab entities
     * @return {Array}  Array of TabEntities
     */
    getTabs: function() {
      return this.tabs;
    },

    /**
     * [openSession description]
     * @param  {Function} callback [description]
     */
    openTabs: function(callback) {
      // open first tab with window
      chrome.windows.create({
        url: this.tabs[0].url,
        focused: true
      }, (function(win) {
        this.setWinId(win.id);
        this.tabs[0].id = win.tabs[0].id;
        callback(win);

        // open bookmarks in window
        this.tabs.forEach((function(tab, i) {
          if (!tab || i === 0) return; // skip if undefined or first tab (since it's already opened)
          var url = config_.lazyLoad ? tab.url : util.lazify(tab.url, tab.title, tab.favIconUrl);
          chrome.tabs.create({
            windowId: win.id,
            index:    i,
            url:      url,
            pinned:   tab.pinned,
            active:   false
          }, (function(tab) {
            this.tabs[i].id = tab.id;
          }).bind(this));
        }).bind(this));
      }).bind(this));
    },

    /**
     * Sets project id of this session
     * @param {String} projectId  project id
     */
    setId: function(projectId) {
      this.id = projectId;
      if (config_.debug) console.log('[SessionEntity] assigned project id of', projectId, 'to session', this);
    },

    /**
     * Unsets project id of this session
     */
    unsetId: function() {
      if (config_.debug) console.log('[SessionEntity] removed project id of', this.id, 'from session', this);
      this.id = null;
    },

    /**
     * [setWinId description]
     * @param {Integer} winId
     */
    setWinId: function(winId) {
      this.winId = winId;
      if (config_.debug) console.log('[SessionEntity] assigned window id of', this.winId, 'to session', this);
    },

    /**
     * [unsetWinId description]
     */
    unsetWinId: function() {
      if (config_.debug) console.log('[SessionEntity] removed window id of', this.winId, 'from session', this);
      this.winId = null;
    }
  };

  /**
   * [SessionManager description]
   */
  var SessionManager = function(config, callback) {
    config_         = config;
    db              = new idb(config);
    this.sessions   = [];
    this.activeInfo = {
      id:       null,
      start:    null,
      end:      null,
      tabId:    null,
      windowId: null
    };

    // set initial window id
    chrome.windows.getCurrent({populate:true}, (function(win) {
      // if (win.type === "normal" && win.id !== chrome.windows.WINDOW_ID_NONE) {
        this.activeInfo.tabId    = null;
        this.activeInfo.windowId = win.id;
      // }
    }).bind(this));

    // chrome.tabs.onCreated.addListener(this.oncreated.bind(this));
    chrome.tabs.onUpdated.addListener(this.onupdated.bind(this));
    chrome.tabs.onRemoved.addListener(this.onremoved.bind(this));
    chrome.tabs.onMoved.addListener(this.onmoved.bind(this));
    chrome.tabs.onReplaced.addListener(this.onreplaced.bind(this));
    chrome.tabs.onAttached.addListener(this.onattached.bind(this));
    chrome.tabs.onDetached.addListener(this.ondetached.bind(this));
    chrome.tabs.onActivated.addListener(this.onactivated.bind(this));

    chrome.windows.onCreated.addListener(this.onwindowcreated.bind(this));
    chrome.windows.onFocusChanged.addListener(this.onfocuschanged.bind(this));

    // Recover and set up sessions
    this.recoverSessions(callback);
  };
  SessionManager.prototype = {
    /**
     * Adds Project
     * @param {chrome.tabs.Tab} tab - adds a tab to project
     */
    oncreated: function(tab) {
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onCreated', tab);
      if (!tab.url.match(util.CHROME_EXCEPTION_URL)) {
        var session = this.getSessionFromWinId(tab.windowId);
        if (session) {
          session.updateTab(tab);
        } else {
          // This shouldn't happen. onwindowcreated should catch and create session first.
          getWindowInfo(tab.windowId, (function(win) {
            this.createSession(win);
          }).bind(this));
        }
      }
    },

    /**
     * Updates tab info
     * @param  {Integer}          tabId       first argument of chrome.tabs.onUpdated.addListener
     * @param  {Object}           changeInfo  second argument of chrome.tabs.onUpdated.addListener
     * @param  {chrome.tabs.Tab}  tab         third argument of chrome.tabs.onUpdated.addListener
     */
    onupdated: function(tabId, changeInfo, tab) {
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onUpdated', tabId, changeInfo, tab);
      if (!tab.url.match(util.CHROME_EXCEPTION_URL)) {
        if (tab.status === 'complete') {
          this.oncreated.call(this, tab);
          UpdateManager.tabComplete(tab);
        } else if (tab.status === 'loading') {
          UpdateManager.tabLoading(tab);
        }
      } else {
        var session = this.getSessionFromWinId(tab.windowId);
        if (session) session.removeTab(tabId);
        if (config_.debug) console.log('[SessionManager] removing a tab which transitioned to url starting with "chrome://"');
      }
    },

    /**
     * Removes a tab from project
     * @param  {Integer} tabId        first argument of chrome.tabs.onRemoved.addListener
     * @param  {Object} removeInfo    second argument of chrome.tabs.onRemoved.addListener
     */
    onremoved: function(tabId, removeInfo) {
      var winId = removeInfo.windowId;
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onRemoved', tabId, removeInfo);

      var session = this.getSessionFromWinId(winId);
      // When closing the window, do not remove tab from the session
      if (removeInfo.isWindowClosing) {
        session.unsetWinId();
        if (config_.debug) console.log('[SessionManager] skip removing a tab since the window is closing', winId);
      } else {
        if (session) {
          session.removeTab(tabId);
          if (session.tabs.length === 0) {
            if (config_.debug) console.log('[SessionManager] removing the session %o itself since all tabs are closing', session);
            this.removeSessionFromProjectId(session.id);
          }
          UpdateManager.storeSessions();
        } else {
          if (config_.debug) console.log('[SessionManager] tab %s being removed was not in the session being tracked', tabId);
        }
      }
    },

    /**
     * [onmoved description]
     * @param  {Integer} tabId    [description]
     * @param  {Object} moveInfo [description]
     */
    onmoved: function(tabId, moveInfo) {
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onMoved', tabId, moveInfo);
      var session = this.getSessionFromWinId(moveInfo.windowId);
      if (session) {
        session.sortTabs();
        if (config_.debug) console.log('[SessionManager] moved tab from %d to %d', moveInfo.fromIndex, moveInfo.toIndex);
      }
    },

    /**
     * [onreplaced description]
     * @param  {Integer} addedTabId   [description]
     * @param  {Integer} removedTabId [description]
     */
    onreplaced: function(addedTabId, removedTabId) {
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onReplaced', addedTabId, removedTabId);
      this.removeTab(removedTabId);
    },

    /**
     * [onattached description]
     * @param  {Integer} tabId      [description]
     * @param  {Object} attachInfo [description]
     */
    onattached: function(tabId, attachInfo) {
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onAttached', tabId, attachInfo);
      getWindowInfo(attachInfo.newWindowId, (function(win) {
        if (win === undefined) return;
        var session = this.getSessionFromWinId(attachInfo.newWindowId);
        // If this tab generates new window, it should be a new session
        if (!session) {
          session = new SessionEntity(win);
          this.sessions.push(session);
        }
        chrome.tabs.get(tabId, (function(tab) {
          session.addTab(tab);
          if (config_.debug) console.log('[SessionManager] added tab %d to window', tabId, attachInfo.newWindowId);
        }).bind(this));
      }).bind(this));
    },

    /**
     * [ondetached description]
     * @param  {Integer} tabId      [description]
     * @param  {Object} detachInfo [description]
     */
    ondetached: function(tabId, detachInfo) {
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onDetached', tabId, detachInfo);
      var old_session = this.getSessionFromWinId(detachInfo.oldWindowId);
      if (old_session) {
        old_session.removeTab(tabId);
        if (old_session.tabs.length === 0) {
          this.removeSessionFromWinId(old_session.winId);
        }
        if (config_.debug) console.log('[SessionManager] removed tab %d from window', tabId, detachInfo.oldWindowId);
      }
    },

    /**
     * [onactivated description]
     * @param  {Integer} activeInfo [description]
     */
    onactivated: function(activeInfo) {
      if (config_.debug) console.log('[SessionManager] chrome.tabs.onActivated', activeInfo);
      getWindowInfo(activeInfo.windowId, (function(win) {
        if (win === undefined) return;
        this.activeInfo.tabId    = activeInfo.tabId; // not used
        this.activeInfo.windowId = activeInfo.windowId;
      }).bind(this));
    },

    onwindowcreated: function(win) {
      // ignore windows that are devtools, chrome extension, etc
      if (win.type !== "normal" || win.id === chrome.windows.WINDOW_ID_NONE) return;
      if (config_.debug) console.log('[SessionManager] chrome.windows.onCreated', win);
      this.createSession(win);
      // TODO: compare with previous session and associate if matched
    },

    /**
     * [onfocuschanged description]
     * @param  {Integer} winId [description]
     */
    onfocuschanged: function(winId) {
      if (config_.debug) console.log('[SessionManager] chrome.windows.onFocusChanged', winId);
      // Put in database only if active session exists
      if (this.activeInfo.start !== null) {
        this.activeInfo.end = (new Date()).getTime();
        db.put(db.SUMMARIES, this.activeInfo);
      }

      getWindowInfo(winId, (function(win) {
        // Focus changed to another window
        if (win !== undefined) {
          // Creates new activeInfo
          var session = this.getSessionFromWinId(win.id);
          if (session) {
            this.activeInfo.id        = session.id;
            this.activeInfo.start     = (new Date()).getTime();
            this.activeInfo.end       = null;
            this.activeInfo.windowId  = session.winId;

            // Put in database
            db.put(db.SUMMARIES, this.activeInfo);
          }

        // Focus changed to somewhere else
        } else {
          this.activeInfo.id        = null;
          this.activeInfo.start     = null;
          this.activeInfo.end       = null;
          this.activeInfo.windowId  = winId;
        }
      }).bind(this));
    },

    /**
     * [createSession description]
     * @param  {chrome.windows.Window} win [description]
     * @return {SessionEntity}     [description]
     */
    createSession: function(win) {
      var session = this.getSessionFromWinId(win.id);
      if (session) {
        if (config_.debug) console.log('[SessionManager] session found', session);
        return session;
      } else {
        session = new SessionEntity(win);
        this.sessions.unshift(session);
        if (config_.debug) console.log('[SessionManager] session %o created from %o', session, win);
        return session;
      }
    },

    /**
     * [removeSessionFromProjectId description]
     * @param  {String} projectId [description]
     */
    removeSessionFromProjectId: function(projectId) {
      for (var i = 0; i < this.sessions.length; i++) {
        if (this.sessions[i].id === projectId) {
          this.sessions.splice(i--, 1);
          if (config_.debug) console.log('[SessionManager] removed session of project id:', projectId);
        }
      }
      UpdateManager.storeSessions();
    },

    /**
     * Removes session of given window id
     * @param   {String}    winId
     * @return  {Boolean}
     */
    removeSessionFromWinId: function(winId) {
      for (var i = 0; i < this.sessions.length; i++) {
        if (this.sessions[i].winId === winId) {
          this.sessions.splice(i, 1);
          if (config_.debug) console.log('[SessionManager] removed session of window id:', winId);
          UpdateManager.storeSessions();
          return true;
        }
      }
      return false;
    },

    unsetWinId: function(winId) {
      for (var i = 0; i < this.sessions.length; i++) {
        if (this.sessions[i].winId === winId) {
          this.sessions[i].unsetWinId();
        }
      }
      return;
    },

    /**
     * Returns an array of sessions
     * @return  {Array} sessions
     */
    getSessions: function() {
      return this.sessions;
    },

    /**
     * [getSession description]
     * @param  {String}                  projectId   project id of the session to get
     * @return {SessionEntity|undefined}
     */
    getSessionFromProjectId: function(projectId) {
      if (!projectId) return undefined;
      for (var i = 0; i < this.sessions.length; i++) {
        if (this.sessions[i].id === projectId) {
          return this.sessions[i];
        }
      }
      return undefined;
    },

    /**
     * [getSessionFromWinId description]
     * @param  {Integer} winId [description]
     * @return {[type]}       [description]
     */
    getSessionFromWinId: function(winId) {
      if (!winId) return undefined;
      for (var i = 0; i < this.sessions.length; i++) {
        if (this.sessions[i].winId === winId) {
          return this.sessions[i];
        }
      }
      return undefined;
    },

    /**
     * [getActiveSession description]
     * @return {SessionEntity} [description]
     */
    getActiveSession: function() {
      var winId = this.activeInfo.windowId || null;
      if (winId) {
        var session = this.getSessionFromWinId(winId);
        if (config_.debug) console.log('[SessionManager] Got active session', session);
        return session;
      }
      return undefined;
    },

    /**
     * [getCurrentWindowId description]
     * @return {[type]} [description]
     */
    getCurrentWindowId: function() {
      return this.activeInfo.windowId || null;
    },

    /**
     * Removes tab from session without knowing which session it belongs to.
     * @param  {Integer} tabId  Tab id of which to remove
     * @return {Boolean}       [description]
     */
    removeTab: function(tabId) {
      for (var i = 0; i < this.sessions.length; i++) {
        var session = this.sessions[i];
        for (var j = 0; j < session.tabs.length; j++) {
          if (session.tabs[j].id === tabId) {
            session.removeTab(tabId);
            return true;
          }
        }
      }
      return false;
    },

    /**
     * Exports sessions
     * @return {Object}
     */
    export: function() {
      return {
        sessions: this.getSessions()
      };
    },

    /**
     * Restore session from last one by guessing
     */
    recoverSessions: function(callback) {
      UpdateManager.restoreSessions((function(prev_sessions) {
        chrome.windows.getAll({populate: true}, (function(windows) {
          if (config_.debug) console.log('[SessionManager] restoring session from windows', windows);
          // Loop through all open windows
          Array.prototype.forEach.call(windows, (function(win) {
            if (win.type !== "normal" || win.id === chrome.windows.WINDOW_ID_NONE) return;

            // Create temporary non-bound session
            var session = this.createSession(win);

            // Loop through previous sessions to see if there's identical one
            for (var i = 0; i < prev_sessions.length; i++) {
              var similar = 0,
                  count = 0;
                  prev_session = prev_sessions[i];

              if (config_.debug) console.log('[SessionManager] ***** matching session with window', prev_session);

              // Loop through all tabs in temporary session
              for (var j = 0; j < win.tabs.length; j++) {
                if (win.tabs[j].url.match(util.CHROME_EXCEPTION_URL)) continue;
                count++;
                // Loop through all tabs in previous session
                for (var k = 0; k < prev_session.tabs.length; k++) {
                  // Check if tab url is similar
                  if (util.resembleUrls(prev_session.tabs[k].url, win.tabs[j].url)) {
                    similar++;
                  }
                }
              }
              if (config_.debug) console.log('[SessionManager] %d/%d similar tabs found on win.id: %d and project.id: %s', similar, count, win.id, prev_session.id);

              // similarity threshold is hardcoded as 80%
              if (similar !== 0 && similar/count > 0.8 && prev_session.id !== null) {
                // set project id and title to this session and make it bound session
                session.setId(prev_session.id);
                session.rename(prev_session.title);
                if (config_.debug) console.log('[SessionManager] upgraded session based on previous session', session);
                prev_sessions.splice(i--, 1);
                break;
              }
            }
          }).bind(this));

          // Loop through previous sessions to create unopened sessions
          for (i = 0; i < prev_sessions.length; i++) {
            this.createSession(prev_sessions[i]);
          }
          if (config_.debug) console.log('[SessionManager] re-assigned sessions to windows.', sessionManager.sessions);
          if (typeof callback === 'function') callback();
        }).bind(this));
      }).bind(this));
    },

    /**
     * [getSummary description]
     * @param  {Function} callback [description]
     * @return {[type]}            [description]
     */
    getTimeTable: function(date, callback) {
      var start     = util.getLocalMidnightTime(date);
      var next_day  = start + (60 * 60 * 24 * 1000);
      var end       = (new Date(next_day)).getTime();
      db.getRange(db.SUMMARIES, start, end, (function(table) {
        table.forEach(function(session, i) {
          // If end time not known
          if (session.end === null) {
            // If next session exists
            if (table[i+1]) {
              // Assign start time of next session as end time
              session.end = (new Date(table[i+1].start)).getTime();
              if (config_.debug) console.log('[SessionManager] Assigning session end time as start time of next one', session);
            // If next session doesn't exist, this is the last session
            } else {
              // Simply assign latest possible
              session.end = end > Date.now() ? Date.now() : end;
              if (config_.debug) console.log('[SessionManager] Assigning session end time as latest possible', session);
            }
          }
          table[i] = session;
        });
        callback(table);
      }).bind(this));
    },

    /**
     * [getSummary description]
     * @param  {[type]}   start    [description]
     * @param  {[type]}   end      [description]
     * @param  {Function} callback [description]
     * @return {[type]}            [description]
     */
    getSummary: function(start, end, callback) {
      var start     = (new Date(start)).getTime();
      var next_day  = (new Date(end)).getTime() + (60 * 60 * 24 * 1000);
      var end       = (new Date(next_day)).getTime();
      db.getRange(db.SUMMARIES, start, end, function(summary) {
        var _summary = {};
        summary.forEach(function(session, i) {
          var id = session.id;
          if (!_summary[id]) {
            _summary[id] = {
              duration: 0
            };
          }
          // If end time not known
          if (session.end === null) {
            // If next session exists
            if (summary[i+1]) {
              // Assign start time of next session as end time
              session.end = (new Date(summary[i+1].start)).getTime();
              if (config_.debug) console.log('[SessionManager] Assigning session end time as start time of next one', session);
            // If next session doesn't exist, this is the last session
            } else {
              // Simply remove that last session
              if (config_.debug) console.log('[SessionManager] Removing session since end time is not known', session);
              summary.splice(i, 1);
              return;
            }
          }
          _summary[id].duration += ~~((session.end - session.start) / 1000);
        });
        callback(_summary);
      });
    },

    deleteOldSummary: function() {
      var boundDateOffset = config_.summaryRemains;
      var today = new Date().toDateString();
      var boundDate = (new Date(today)).getTime() - boundDateOffset;
      db.deleteOlder(db.SUMMARIES, boundDate, function() {
        if (config_.debug) console.log('[SessionManager] Old summary record has been deleted in database.');
      });
    }
  };

  return SessionManager;
})();