// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;

const Main = imports.ui.main;

const AppFavorites = new Lang.Class({
    Name: 'AppFavorites',

    _init: function(settingsKey, showNotifications) {
        this._favorites = {};
        this._settingsKey = settingsKey;
        this._showNotifications = showNotifications;
        global.settings.connect('changed::' + settingsKey, Lang.bind(this, this._onFavsChanged));
        Shell.AppSystem.get_default().connect('installed-changed', Lang.bind(this, this._onFavsChanged));
        this._reload();
    },

    _onFavsChanged: function() {
        this._reload();
        this.emit('changed');
    },

    _reload: function() {
        let ids = global.settings.get_strv(this._settingsKey);
        let appSys = Shell.AppSystem.get_default();
        let apps = ids.map(function (id) {
                // Some older versions of eos-theme incorrectly added
                // eos-app-*.desktop to the dash favorites.
                // Make sure to strip those.
                if (id.startsWith('eos-app-'))
                    return id.slice('eos-app-'.length);
                else
                    return id;
            }).map(function (id) {
                return appSys.lookup_alias(id);
            }).filter(function (app) {
                return app != null;
            });
        this._favorites = {};
        for (let i = 0; i < apps.length; i++) {
            let app = apps[i];
            this._favorites[app.get_id()] = app;
        }
    },

    _getIds: function() {
        let ret = [];
        for (let id in this._favorites)
            ret.push(id);
        return ret;
    },

    getFavoriteMap: function() {
        return this._favorites;
    },

    getFavorites: function() {
        let ret = [];
        for (let id in this._favorites)
            ret.push(this._favorites[id]);
        return ret;
    },

    isFavorite: function(appId) {
        return appId in this._favorites;
    },

    _addFavorite: function(appId, pos) {
        if (appId in this._favorites)
            return false;

        let app = Shell.AppSystem.get_default().lookup_alias(appId);
        if (!app)
            return false;

        let ids = this._getIds();
        if (pos == -1) {
            ids.push(app.get_id());
        }
        else {
            // If the appId is an alias, replace it with the actual
            // app id
            if (appId != app.get_id()) {
                ids.splice(pos, 0, appId);
            }
            else {
                ids.splice(pos, 0, app.get_id());
            }
        }

        global.settings.set_strv(this._settingsKey, ids);
        this._favorites[app.get_id()] = app;
        return true;
    },

    addFavoriteAtPos: function(appId, pos) {
        if (!this._addFavorite(appId, pos))
            return;

        if (!this._showNotifications)
            return;

        let app = Shell.AppSystem.get_default().lookup_alias(appId);

        Main.overview.setMessage(_("%s has been added to your favorites.").format(app.get_name()),
                                 { forFeedback: true,
                                   undoCallback: Lang.bind(this, function () {
                                                               this._removeFavorite(app.get_id());
                                                           })
                                 });
    },

    addFavorite: function(appId) {
        this.addFavoriteAtPos(appId, -1);
    },

    moveFavoriteToPos: function(appId, pos) {
        this._removeFavorite(appId);
        this._addFavorite(appId, pos);
    },

    _removeFavorite: function(appId) {
        if (!appId in this._favorites)
            return false;

        let ids = this._getIds().filter(function (id) { return id != appId; });
        global.settings.set_strv(this._settingsKey, ids);
        return true;
    },

    removeFavorite: function(appId) {
        let ids = this._getIds();
        let pos = ids.indexOf(appId);

        let app = this._favorites[appId];
        if (!app || !this._removeFavorite(appId))
            return;

        if (!this._showNotifications)
            return;

        Main.overview.setMessage(_("%s has been removed from your favorites.").format(app.get_name()),
                                 { forFeedback: true,
                                   undoCallback: Lang.bind(this, function () {
                                                               this._addFavorite(appId, pos);
                                                           })
                                 });
    }
});
Signals.addSignalMethods(AppFavorites.prototype);

var dashFavoritesInstance = null;
function getAppFavorites() {
    if (dashFavoritesInstance == null)
        dashFavoritesInstance = new AppFavorites('favorite-apps', true);
    return dashFavoritesInstance;
}

var taskbarFavoritesInstance = null;
function getTaskbarFavorites() {
    if (taskbarFavoritesInstance == null)
        taskbarFavoritesInstance = new AppFavorites('taskbar-pins', false);
    return taskbarFavoritesInstance;
}
