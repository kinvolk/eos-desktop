// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Atk = imports.gi.Atk;

const AppFavorites = imports.ui.appFavorites;
const BoxPointer = imports.ui.boxpointer;
const ButtonConstants = imports.ui.buttonConstants;
const DND = imports.ui.dnd;
const IconGrid = imports.ui.iconGrid;
const IconGridLayout = imports.ui.iconGridLayout;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const OverviewControls = imports.ui.overviewControls;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const Workspace = imports.ui.workspace;
const Params = imports.misc.params;
const Util = imports.misc.util;

const MAX_APPLICATION_WORK_MILLIS = 75;
const MENU_POPUP_TIMEOUT = 600;
const MAX_COLUMNS = 7;

const INACTIVE_GRID_OPACITY = 77;
const FOLDER_SUBICON_FRACTION = .4;

const EndlessApplicationView = new Lang.Class({
    Name: 'EndlessApplicationView',
    Abstract: true,

    _init: function() {
        this._grid = new IconGrid.IconGrid({ xAlign: St.Align.MIDDLE,
                                             columnLimit: MAX_COLUMNS });

        // Standard hack for ClutterBinLayout
        this._grid.actor.x_expand = true;

        this._items = {};
        this._allItems = [];
    },

    removeAll: function() {
        this._grid.removeAll();
        this._items = {};
        this._allItems = [];
    },

    _getItemId: function(item) {
        return item.get_id();
    },

    _createItemIcon: function(item) {
        throw new Error('Not implemented');
    },

    _addItem: function(item) {
        let id = this._getItemId(item);
        if (this._items[id] !== undefined) {
            return null;
        }

        let itemIcon = this._createItemIcon(item);
        this._allItems.push(item);
        this._items[id] = itemIcon;

        return itemIcon;
    },

    _removeItem: function(item) {
        let id = this._getItemId(item);
        if (this._items[id] === undefined) {
            return;
        }

        delete this._items[id];

        let idx = this._allItems.indexOf(item);
        if (idx != -1) {
            this._allItems.splice(idx, 1);
        }
    },

    _showItem: function(item) {
        let id = this._getItemId(item);
        if (this._items[id] === undefined) {
            return;
        }

        this._items[id].actor.show();
    },

    loadGrid: function() {
        for (let i = 0; i < this._allItems.length; i++) {
            let id = this._getItemId(this._allItems[i]);
            if (!id) {
                continue;
            }

            this._grid.addItem(this._items[id].actor);
        }
    }
});

const FolderView = new Lang.Class({
    Name: 'FolderView',
    Extends: EndlessApplicationView,

    _init: function() {
        this.parent();
        this.actor = this._grid.actor;
    },

    _createItemIcon: function(item) {
        return new AppIcon(item);
    },

    addApp: function(app) {
        this._addItem(app);
    },

    createFolderIcon: function(size) {
        let icon = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                   style_class: 'app-folder-icon',
                                   width: size, height: size });
        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);

        let aligns = [ Clutter.ActorAlign.START, Clutter.ActorAlign.END ];
        for (let i = 0; i < Math.min(this._allItems.length, 4); i++) {
            let texture = this._allItems[i].create_icon_texture(subSize);
            let bin = new St.Bin({ child: texture,
                                   x_expand: true, y_expand: true });
            bin.set_x_align(aligns[i % 2]);
            bin.set_y_align(aligns[Math.floor(i / 2)]);
            icon.add_actor(bin);
        }

        return icon;
    }
});

const AllViewLayout = new Lang.Class({
    Name: 'AllViewLayout',
    Extends: Clutter.BinLayout,

    vfunc_get_preferred_height: function(container, forWidth) {
        let minBottom = 0;
        let naturalBottom = 0;

        for (let child = container.get_first_child();
             child;
             child = child.get_next_sibling()) {

            if (!child.visible) {
                continue;
            }

            let childY = child.y;
            let [childMin, childNatural] = child.get_preferred_height(forWidth);

            if (childMin + childY > minBottom) {
                minBottom = childMin + childY;
            }

            if (childNatural + childY > naturalBottom) {
                naturalBottom = childNatural + childY;
            }
        }
        return [minBottom, naturalBottom];
    }
});

const AllView = new Lang.Class({
    Name: 'AllView',
    Extends: EndlessApplicationView,

    _init: function() {
        this.parent();

        let box = new St.BoxLayout({ vertical: true });
        this._stack = new St.Widget({ layout_manager: new AllViewLayout() });
        this._stack.add_actor(this._grid.actor);
        this._eventBlocker = new St.Widget({ x_expand: true, y_expand: true });
        this._stack.add_actor(this._eventBlocker);
        box.add(this._stack, { y_align: St.Align.START, expand: true });

        this.actor = new St.ScrollView({ x_fill: true,
                                         y_fill: false,
                                         y_align: St.Align.START,
                                         x_expand: true,
                                         y_expand: true,
                                         overlay_scrollbars: true,
                                         style_class: 'all-apps vfade' });
        this.actor._delegate = this;

        this.actor.add_actor(box);
        this.actor.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        let action = new Clutter.PanAction({ interpolate: true });
        action.connect('pan', Lang.bind(this, this._onPan));
        this.actor.add_action(action);

        Main.overview.connect('item-drag-begin', Lang.bind(this, this._onDragBegin));
        Main.overview.connect('item-drag-end', Lang.bind(this, this._onDragEnd));
        Main.overview.connect('item-drag-cancelled', Lang.bind(this, this._onDragCancelled));

        this._clickAction = new Clutter.ClickAction();
        this._clickAction.connect('clicked', Lang.bind(this, function() {
            if (!this._currentPopup) {
                return;
            }

            let [x, y] = this._clickAction.get_coords();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            if (!this._currentPopup.actor.contains(actor)) {
                this._currentPopup.popdown();
            }

        }));
        this._eventBlocker.add_action(this._clickAction);
    },

    _onPan: function(action) {
        this._clickAction.release();

        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this.actor.vscroll.adjustment;
        adjustment.value -= (dy / this.actor.height) * adjustment.page_size;
        return false;
    },

    _onDragBegin: function(overview, source) {
        this._dragItem = source;
        this._originalIdx = this._grid.indexOf(source.actor);

        this._insertIdx = -1;
        source.actor.hide();

        this._eventBlocker.hide();

        this._dragCancelled = false;
        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };
        DND.addDragMonitor(this._dragMonitor);
    },

    _onDragEnd: function(overview, source) {
        this._eventBlocker.show();

        if (this._insertActor != null) {
            this._grid.removeItem(this._insertActor);
            this._insertActor = null;
            this._insertIdx = -1;
            this._originalIdx = -1;
            this._dragItem = undefined;
        }

        DND.removeDragMonitor(this._dragMonitor);
    },

    _onDragCancelled: function(overview, source) {
        source.actor.show();
        this._onDragEnd(overview, source);
    },

    _onDragMotion: function(dragEvent) {
        // Ask grid can we drop here
        let [idx, onIcon] = this._grid.canDropAt(dragEvent.x, dragEvent.y,
                                                 this._insertIdx);

        // Take into account hidden icon if present
        if (idx >= this._originalIdx) {
            idx += 1;
        }

        // If we are not over our last hovered icon, remove its hover state
        if (this._onIconIdx != null && idx != this._onIconIdx){
            this._setHoverStateOf(this._onIconIdx, false)
        }

        this._onIcon = onIcon;
        this._onIconIdx = idx;

        if (onIcon || idx == -1) {
            this._setHoverStateOf(this._onIconIdx, true);

            if (this._insertIdx != -1) {
                this._grid.removeItem(this._insertActor);
                this._insertIdx = -1;
            }

            return DND.DragMotionResult.CONTINUE;
        }

        if (this._insertIdx == idx) {
            return DND.DragMotionResult.COPY_DROP;
        }

        if (this._insertActor != null) {
            this._grid.removeItem(this._insertActor);
        }

        this._insertIdx = idx;
        this._insertActor = new St.Button({ style_class: 'app-well-insert-icon',
                                            can_focus: false,
                                            x_fill: true,
                                            y_fill: true });
        this._grid.addItem(this._insertActor, idx);

        return DND.DragMotionResult.COPY_DROP;
    },

    _setHoverStateOf: function(item, state){
        let item = this._allItems[this._onIconIdx];

        // If the item cannot be found, ignore it
        if(item != null){
            this._items[this._getItemId(item)].actor.set_hover(state);
        }
    },

    acceptDrop: function(source, actor, x, y, time) {
        let originalId = this._getItemId(this._allItems[this._originalIdx]);
        if (this._onIcon) {
            // Find out what icon the drop is under
            let id = this._getItemId(this._allItems[this._onIconIdx]);
            if (!id) {
                source.actor.show();
                return true;
            }

            let dropIcon = this._items[id];
            if (!(dropIcon instanceof FolderIcon)) {
                source.actor.show();
                return true;
            }

            let newFolder = dropIcon._dir.get_name();
            IconGridLayout.layout.repositionIcon("", originalId,
                                                 this._insertIdx,
                                                 newFolder);
            return true;
        } else {
            if (this._insertIdx == -1) {
                source.actor.show();
                return false;
            } else {
                IconGridLayout.layout.repositionIcon("", originalId,
                                                     this._insertIdx, "");
                return true;
            }
        }
    },

    _createItemIcon: function(item) {
        if (item instanceof Shell.App) {
            return new AppIcon(item);
        } else {
            return new FolderIcon(item, this);
        }
    },

    loadGrid: function() {
        this.parent();

        this._grid.addItem((new AppStoreIcon()).actor);
    },

    addApp: function(app) {
        let appIcon = this._addItem(app);
        if (appIcon)
            appIcon.actor.connect('key-focus-in',
                                  Lang.bind(this, this._ensureIconVisible));
    },

    addFolder: function(dir) {
        let folderIcon = this._addItem(dir);
        if (folderIcon)
            folderIcon.actor.connect('key-focus-in',
                                     Lang.bind(this, this._ensureIconVisible));
    },

    addFolderPopup: function(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', Lang.bind(this,
            function(popup, isOpen) {
                this._eventBlocker.reactive = isOpen;
                this._currentPopup = isOpen ? popup : null;
                this._updateIconOpacities(isOpen);
                if (isOpen)
                    this._ensureIconVisible(popup.actor);
                this._grid.actor.queue_relayout();
            }));
    },

    _ensureIconVisible: function(icon) {
        Util.ensureActorVisibleInScrollView(this.actor, icon);
    },

    _updateIconOpacities: function(folderOpen) {
        for (let id in this._items) {
            if (folderOpen && !this._items[id].actor.checked)
                this._items[id].actor.opacity = INACTIVE_GRID_OPACITY;
            else
                this._items[id].actor.opacity = 255;
        }
    }
});

const FrequentView = new Lang.Class({
    Name: 'FrequentView',

    _init: function() {
        this._grid = new IconGrid.IconGrid({ xAlign: St.Align.MIDDLE,
                                             fillParent: true,
                                             columnLimit: MAX_COLUMNS });
        this.actor = new St.Widget({ style_class: 'frequent-apps',
                                     x_expand: true, y_expand: true });
        this.actor.add_actor(this._grid.actor);

        this._usage = Shell.AppUsage.get_default();
    },

    removeAll: function() {
        this._grid.removeAll();
    },

    loadApps: function() {
        let mostUsed = this._usage.get_most_used ("");
        for (let i = 0; i < mostUsed.length; i++) {
            let appIcon = new AppIcon(mostUsed[i]);
            this._grid.addItem(appIcon.actor, -1);
        }
    }
});

const Views = {
    FREQUENT: 0,
    ALL: 1
};

const AppDisplay = new Lang.Class({
    Name: 'AppDisplay',

    _init: function() {
        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connect('installed-changed', Lang.bind(this, function() {
            Main.queueDeferredWork(this._allAppsWorkId);
        }));
        Main.overview.connect('showing', Lang.bind(this, function() {
            Main.queueDeferredWork(this._frequentAppsWorkId);
        }));
        global.settings.connect('changed::app-folder-categories', Lang.bind(this, function() {
            Main.queueDeferredWork(this._allAppsWorkId);
        }));

        IconGridLayout.layout.connect('changed', Lang.bind(this, function() {
            Main.queueDeferredWork(this._allAppsWorkId);
        }));

        this._views = [];

        let view, button;
        view = new FrequentView();
        button = new St.Button({ label: _("Frequent"),
                                 style_class: 'app-view-control',
                                 can_focus: true,
                                 x_expand: true });
        this._views[Views.FREQUENT] = { 'view': view, 'control': button };

        view = new AllView();
        button = new St.Button({ label: _("All"),
                                 style_class: 'app-view-control',
                                 can_focus: true,
                                 x_expand: true });
        this._views[Views.ALL] = { 'view': view, 'control': button };

        this.actor = new St.BoxLayout({ style_class: 'app-display',
                                        vertical: true,
                                        x_expand: true, y_expand: true });

        this._viewStack = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                          x_expand: true, y_expand: true });
        this.actor.add(this._viewStack, { expand: true });

        for (let i = 0; i < this._views.length; i++) {
            this._viewStack.add_actor(this._views[i].view.actor);

            let viewIndex = i;
            this._views[i].control.connect('clicked', Lang.bind(this,
                function(actor) {
                    this._showView(viewIndex);
                }));
        }

        // Default to all apps rather than frequently used
        this._showView(Views.ALL);

        // We need a dummy actor to catch the keyboard focus if the
        // user Ctrl-Alt-Tabs here before the deferred work creates
        // our real contents
        this._focusDummy = new St.Bin({ can_focus: true });
        this._viewStack.add_actor(this._focusDummy);

        this._allAppsWorkId = Main.initializeDeferredWork(this.actor, Lang.bind(this, this._redisplayAllApps));
        this._frequentAppsWorkId = Main.initializeDeferredWork(this.actor, Lang.bind(this, this._redisplayFrequentApps));
    },

    _showView: function(activeIndex) {
        for (let i = 0; i < this._views.length; i++) {
            let actor = this._views[i].view.actor;
            let params = { time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                           opacity: (i == activeIndex) ? 255 : 0 };
            if (i == activeIndex)
                actor.visible = true;
            else
                params.onComplete = function() { actor.hide(); };
            Tweener.addTween(actor, params);

            if (i == activeIndex)
                this._views[i].control.add_style_pseudo_class('checked');
            else
                this._views[i].control.remove_style_pseudo_class('checked');
        }
    },

    _redisplay: function() {
        this._redisplayFrequentApps();
        this._redisplayAllApps();
    },

    _redisplayFrequentApps: function() {
        let view = this._views[Views.FREQUENT].view;

        view.removeAll();
        view.loadApps();
    },

    _redisplayAllApps: function() {
        let view = this._views[Views.ALL].view;
        view.removeAll();

        let topLevelIcons = IconGridLayout.layout.getIcons();

        for (let i = 0; i < topLevelIcons.length; i++) {
            let itemId = topLevelIcons[i];

            if (IconGridLayout.layout.iconIsFolder(itemId)) {
                view.addFolder({
                    get_id: function() { return itemId; },
                    get_name: function() { return itemId; },
                });
            } else {
                let app = this._appSystem.lookup_app(itemId);
                if (app) {
                    view.addApp(app);
                }
            }
        }
        view.loadGrid();

        if (this._focusDummy) {
            let focused = this._focusDummy.has_key_focus();
            this._focusDummy.destroy();
            this._focusDummy = null;
            if (focused)
                this.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
        }
    }
});

const AppSearchProvider = new Lang.Class({
    Name: 'AppSearchProvider',

    _init: function() {
        this._appSys = Shell.AppSystem.get_default();
        this.id = 'applications';
    },

    getResultMetas: function(apps, callback) {
        let metas = [];
        for (let i = 0; i < apps.length; i++) {
            let app = apps[i];
            metas.push({ 'id': app,
                         'name': app.get_name(),
                         'createIcon': function(size) {
                             return app.create_icon_texture(size);
                         }
                       });
        }
        callback(metas);
    },

    getInitialResultSet: function(terms) {
        this.searchSystem.pushResults(this, this._appSys.initial_search(terms));
    },

    getSubsearchResultSet: function(previousResults, terms) {
        this.searchSystem.pushResults(this, this._appSys.subsearch(previousResults, terms));
    },

    activateResult: function(app) {
        let event = Clutter.get_current_event();
        let modifiers = event ? event.get_state() : 0;
        let openNewWindow = modifiers & Clutter.ModifierType.CONTROL_MASK;

        if (openNewWindow)
            app.open_new_window(-1);
        else
            app.activate();
    },

    dragActivateResult: function(id, params) {
        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        let app = this._appSys.lookup_app(id);
        app.open_new_window(workspace);
    },

    createResultActor: function (resultMeta, terms) {
        let app = resultMeta['id'];
        let icon = new AppIcon(app);
        return icon.actor;
    }
});

const FolderIcon = new Lang.Class({
    Name: 'FolderIcon',

    _init: function(dir, parentView) {
        this._dir = dir;
        this._parentView = parentView;

        this.actor = new St.Button({ style_class: 'app-well-app app-folder',
                                     button_mask: St.ButtonMask.ONE,
                                     toggle_mode: true,
                                     can_focus: true,
                                     x_fill: true,
                                     y_fill: true });
        this.actor._delegate = this;

        let label = this._dir.get_name();
        this.icon = new IconGrid.BaseIcon(label,
                                          { createIcon: Lang.bind(this, this._createIcon) });
        this.actor.set_child(this.icon.actor);
        this.actor.label_actor = this.icon.label;

        this.view = new FolderView();
        this.view.actor.reactive = false;
        this._loadCategory(dir, this.view);
        this.view.loadGrid();

        this.actor.connect('clicked', Lang.bind(this,
            function() {
                this._ensurePopup();
                this._popup.toggle();
            }));
        this.actor.connect('notify::mapped', Lang.bind(this,
            function() {
                if (!this.actor.mapped && this._popup)
                    this._popup.popdown();
            }));
    },

    _loadCategory: function(dir) {
        let appSystem = Shell.AppSystem.get_default();

        let icons = IconGridLayout.layout.getIcons(dir.get_id());
        if (! icons) {
            return;
        }

        for (let i = 0; i < icons.length; i++) {
            let app = appSystem.lookup_app(icons[i]);
            if (app) {
                this.view.addApp(app);
            }
        }
    },

    _createIcon: function(size) {
        return this.view.createFolderIcon(size);
    },

    _ensurePopup: function() {
        if (this._popup)
            return;

        let [sourceX, sourceY] = this.actor.get_transformed_position();
        let [sourceXP, sourceYP] = this._parentView.actor.get_transformed_position();
        let relY = sourceY - sourceYP;
        let spaceTop = relY;
        let spaceBottom = this._parentView.actor.height - (relY + this.actor.height);
        let side = spaceTop > spaceBottom ? St.Side.BOTTOM : St.Side.TOP;

        this._popup = new AppFolderPopup(this, side);
        this._parentView.addFolderPopup(this._popup);
        this._reposition(side, spaceTop, spaceBottom);

        this._popup.connect('open-state-changed', Lang.bind(this,
            function(popup, isOpen) {
                if (!isOpen)
                    this.actor.checked = false;
            }));

        // Glue the popup to the top/bottom of the folder icon
        let constraint;
        if (side == St.Side.TOP) {
            constraint = new Clutter.BindConstraint({ source: this.actor.get_parent().get_parent(),
                                                      coordinate: Clutter.BindCoordinate.Y,
                                                      offset: this.actor.height + this.actor.y });
        } else {
            constraint = new Clutter.BindConstraint({ source: this.actor.get_parent().get_parent(),
                                                      coordinate: Clutter.BindCoordinate.Y,
                                                      offset: -this._popup.actor.height + this.actor.y });
        }
        this._popup.actor.add_constraint(constraint);
    },

    _reposition: function(side, spaceTop, spaceBottom) {
        let [sourceX, sourceY] = this.actor.get_transformed_position();
        let [sourceXP, sourceYP] = this._parentView.actor.get_transformed_position();
        let newPosY = sourceY - sourceYP + this.actor.height;

        let iconGridHeight = this.actor.get_parent().get_parent().height;

        // Reposition the popup to ensure that the content will grow later when
        // using a binding constraint. It takes in account that when this
        // happens, the icon pointed by the popup will be repositioned in more
        // or less in the middle of the screen (icon grid is always centered)
        if ((side == St.Side.TOP && this._popup.actor.height > spaceBottom) ||
            (side == St.Side.BOTTOM && this._popup.actor.height > spaceTop)) {
            this._popup.actor.y = sourceYP + this._popup.actor.height + this.actor.y + this.actor.height + iconGridHeight;
        }

        // If folder icon is not enterily above or below the app folder, move
        // the later so the pointer can point correctly to the icon
        let sourceAllocation = Shell.util_get_transformed_allocation(this._popup.actor);
        let actorLeft = sourceX;
        let actorRight = sourceX + this.actor.width;
        let popupLeft = sourceAllocation.x1;
        let popupRight = sourceAllocation.x2;
        if (actorLeft < popupLeft) {
            this._popup.actor.set_anchor_point(Math.max(0, popupLeft - actorLeft), 0);
        }
        if (actorRight > popupRight) {
            this._popup.actor.set_anchor_point(-Math.max(0, actorRight - popupRight), 0);
        }
    },
});

const AppFolderPopup = new Lang.Class({
    Name: 'AppFolderPopup',

    _init: function(source, side) {
        this._source = source;
        this._view = source.view;
        this._arrowSide = side;

        this._isOpen = false;

        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     visible: true,
                                     // We don't want to expand really, but look
                                     // at the layout manager of our parent...
                                     //
                                     // DOUBLE HACK: if you set one, you automatically
                                     // get the effect for the other direction too, so
                                     // we need to set the y_align
                                     x_expand: true,
                                     y_expand: true,
                                     x_align: Clutter.ActorAlign.CENTER,
                                     y_align: Clutter.ActorAlign.START });
        this._boxPointer = new BoxPointer.BoxPointer(this._arrowSide,
                                                     { style_class: 'app-folder-popup-bin',
                                                       x_fill: true,
                                                       y_fill: true,
                                                       x_align: St.Align.START });

        this._boxPointer.actor.style_class = 'app-folder-popup';
        this.actor.add_actor(this._boxPointer.actor);
        this._boxPointer.bin.set_child(this._view.actor);

        let closeButton = Util.makeCloseButton();
        closeButton.connect('clicked', Lang.bind(this, this.popdown));
        this.actor.add_actor(closeButton);

        this._boxPointer.actor.bind_property('opacity', closeButton, 'opacity',
                                             GObject.BindingFlags.SYNC_CREATE);

        source.actor.connect('destroy', Lang.bind(this,
            function() {
                this.actor.destroy();
            }));
    },

    toggle: function() {
        if (this._isOpen)
            this.popdown();
        else
            this.popup();
    },

    popup: function() {
        if (this._isOpen)
            return;

        this.actor.show();

        this._boxPointer.setArrowActor(this._source.actor);
        this._boxPointer.show(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE);

        this._isOpen = true;
        this.emit('open-state-changed', true);
    },

    popdown: function() {
        if (!this._isOpen)
            return;

        this._boxPointer.hide(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE,
                              Lang.bind(this, function () {
                                  this.actor.hide();
                                  this.emit('open-state-changed', false);
                              }));
        this._isOpen = false;
    }
});
Signals.addSignalMethods(AppFolderPopup.prototype);

const AppIcon = new Lang.Class({
    Name: 'AppIcon',

    _init : function(app, iconParams, params) {
        params = Params.parse(params, { showMenu: true,
                                        isDraggable: true });

        this.app = app;
        this._showMenu = params.showMenu;

        this.actor = new St.Button({ style_class: 'app-well-app',
                                     reactive: true,
                                     button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
                                     can_focus: true,
                                     x_fill: true,
                                     y_fill: true });
        this.actor._delegate = this;

        if (!iconParams)
            iconParams = {};

        iconParams['createIcon'] = Lang.bind(this, this._createIcon);
        this.icon = new IconGrid.BaseIcon(app.get_name(), iconParams);
        this.actor.set_child(this.icon.actor);

        this.actor.label_actor = this.icon.label;

        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('popup-menu', Lang.bind(this, this._onKeyboardPopupMenu));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        if (params.isDraggable) {
            this._draggable = DND.makeDraggable(this.actor);
            this._draggable.connect('drag-begin', Lang.bind(this,
                function () {
                    // Notify view that something is dragging
                    this._removeMenuTimeout();
                    Main.overview.beginItemDrag(this);
                }));
            this._draggable.connect('drag-cancelled', Lang.bind(this,
                function () {
                    Main.overview.cancelledItemDrag(this);
                }));
            this._draggable.connect('drag-end', Lang.bind(this,
                function () {
                    // Are we in the trashcan area?
                    Main.overview.endItemDrag(this);
                }));
        }

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._menuTimeoutId = 0;
        this._stateChangedId = this.app.connect('notify::state',
                                                Lang.bind(this,
                                                          this._onStateChanged));
        this._onStateChanged();
    },

    _onDestroy: function() {
        if (this._stateChangedId > 0) {
            this.app.disconnect(this._stateChangedId);
        }
        this._stateChangedId = 0;
        this._removeMenuTimeout();
    },

    _createIcon: function(iconSize) {
        return this.app.create_icon_texture(iconSize);
    },

    _removeMenuTimeout: function() {
        if (this._menuTimeoutId > 0) {
            Mainloop.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    },

    _onStateChanged: function() {
        if (this.app.state != Shell.AppState.STOPPED) {
            this.actor.add_style_class_name('running');
        } else {
            this.actor.remove_style_class_name('running');
        }
    },

    _onButtonPress: function(actor, event) {
        let button = event.get_button();
        if (button == ButtonConstants.LEFT_MOUSE_BUTTON) {
            this._removeMenuTimeout();
            this._menuTimeoutId = Mainloop.timeout_add(MENU_POPUP_TIMEOUT,
                Lang.bind(this, function() {
                    this.popupMenu();
                }));
        } else if (button == ButtonConstants.RIGHT_MOUSE_BUTTON) {
            this.popupMenu();
            return true;
        }
        return false;
    },

    _onClicked: function(actor, button) {
        this._removeMenuTimeout();

        if (button == ButtonConstants.LEFT_MOUSE_BUTTON) {
            this._onActivate(Clutter.get_current_event());
        } else if (button == ButtonConstants.MIDDLE_MOUSE_BUTTON) {
            // Last workspace is always empty
            let launchWorkspace = global.screen.get_workspace_by_index(global.screen.n_workspaces - 1);
            launchWorkspace.activate(global.get_current_time());
            this.emit('launching');
            this.app.open_new_window(-1);
            Main.overview.hide();
        }
        return false;
    },

    _onKeyboardPopupMenu: function() {
        if (!this._showMenu) {
            return;
        }

        this.popupMenu();
        this._menu.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
    },

    getId: function() {
        return this.app.get_id();
    },

    popupMenu: function() {
        this._removeMenuTimeout();

        if (!this._showMenu) {
            return false;
        }

        this.actor.fake_release();

        if (this._draggable) {
            this._draggable.fakeRelease();
        }

        if (!this._menu) {
            this._menu = new AppIconMenu(this);
            this._menu.connect('activate-window', Lang.bind(this, function (menu, window) {
                this.activateWindow(window);
            }));
            this._menu.connect('open-state-changed', Lang.bind(this, function (menu, isPoppedUp) {
                if (!isPoppedUp) {
                    this._onMenuPoppedDown();
                }
            }));
            Main.overview.connect('hiding', Lang.bind(this, function () { this._menu.close(); }));

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.actor.set_hover(true);
        this._menu.popup();
        this._menuManager.ignoreRelease();

        return false;
    },

    activateWindow: function(metaWindow) {
        if (metaWindow) {
            Main.activateWindow(metaWindow);
        } else {
            Main.overview.hide();
        }
    },

    _onMenuPoppedDown: function() {
        this.actor.sync_hover();
        this.emit('menu-state-changed', false);
    },

    _onActivate: function (event) {
        this.emit('launching');
        let modifiers = event.get_state();

        if (modifiers & Clutter.ModifierType.CONTROL_MASK
            && this.app.state == Shell.AppState.RUNNING) {
            this.app.open_new_window(-1);
        } else {
            this.app.activate();
        }

        Main.overview.hide();
    },

    shellWorkspaceLaunch : function(params) {
        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        this.app.open_new_window(params.workspace);
    },

    getDragActor: function() {
        return this.app.create_icon_texture(Main.overview.dashIconSize);
    },

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource: function() {
        return this.icon.icon;
    },
});
Signals.addSignalMethods(AppIcon.prototype);

// FIXME: this should be removed once we install the app
// store application with its desktop file and everything
const AppStore = new Lang.Class({
    Name: 'AppStore',
    Extends: Shell.App,

    get_name: function() {
        return _("Add");
    },

    get_id: function() {
        return "appstoreid";
    },

    activate: function(){
        Util.spawn(["eos_app_store"]);
    }
});

const AppStoreIcon = new Lang.Class({
    Name: 'AppStoreIcon',
    Extends: AppIcon,

    _init : function() {
        this.parent(new AppStore(),
                    { createIcon: this._createIcon },
                    { showMenu: false,
                      isDraggable: false });

        this.pressed_icon = new IconGrid.BaseIcon(_("Add"),
                                                  { createIcon: this._createPressedIcon });
        this.empty_trash_icon = new IconGrid.BaseIcon(_("Delete"),
                                                      { createIcon: this._createTrashIcon });
        this.full_trash_icon = new IconGrid.BaseIcon(_("Delete"),
                                                     { createIcon: this._createFullTrashIcon });

        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));

        Main.overview.connect('item-drag-begin', Lang.bind(this, this._onDragBegin));
        Main.overview.connect('item-drag-end', Lang.bind(this, this._onDragEnd));
    },

    _createPressedIcon: function(iconSize) {
        // For now, let's use the normal icon for the pressed state,
        // for consistency with the other app selector icons,
        // which just use the wells to represent the pressed state.
        // In the future, we may want to use the 'add_down' icon instead.
        // If so, the return to the normal state after the user
        // moves off the icon to cancel should be made more responsive;
        // the current implementation takes about a second for the change
        // back to the normal icon to occur.
        return new St.Icon({ icon_size: iconSize,
                             icon_name: 'add_normal'});
    },

    _createIcon: function(iconSize) {
        return new St.Icon({ icon_size: iconSize,
                             icon_name: 'add_normal'});
    },

    _createTrashIcon: function(iconSize) {
        return new St.Icon({ icon_size: iconSize,
                             icon_name: 'trash-can_normal'});
    },

    _createFullTrashIcon: function(iconSize) {
        return new St.Icon({ icon_size: iconSize,
                             icon_name: 'trash-can_hover'});
    },

    _onButtonPress: function(actor, event) {
        let button = event.get_button();
        if (button == ButtonConstants.LEFT_MOUSE_BUTTON) {
            this.actor.set_child(this.pressed_icon.actor);
        }
        return false;
    },

    _getAppFromSource: function(source) {
        if (source instanceof AppIcon) {
            return source.app;
        } else {
            return null;
        }
    },

    _onDragBegin: function() {
        this.actor.set_child(this.empty_trash_icon.actor);
        this._dragCancelled = false;
        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };
        DND.addDragMonitor(this._dragMonitor);
    },

    _onDragEnd: function(actor, event) {
        this.actor.set_child(this.icon.actor);
        DND.removeDragMonitor(this._dragMonitor);
    },

    _onDragMotion: function(dragEvent) {
        let app = this._getAppFromSource(dragEvent.source);
        if (app == null) {
            return DND.DragMotionResult.CONTINUE;
        }

        let showAppsHovered = this.actor.contains(dragEvent.targetActor);

        if (showAppsHovered) {
            this.actor.set_child(this.full_trash_icon.actor);
        } else {
            this.actor.set_child(this.empty_trash_icon.actor);
        }

        return DND.DragMotionResult.CONTINUE;
    },

    handleDragOver: function(source, actor, x, y, time) {
        let app = this._getAppFromSource(source);
        if (app == null) {
            return DND.DragMotionResult.NO_DROP;
        }
        let id = app.get_id();
        return DND.DragMotionResult.MOVE_DROP;
    },

    acceptDrop: function(source, actor, x, y, time) {
        let app = source.app;
        if (app == null) {
            return false;
        }

        let id = app.get_id();

        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this,
            function () {
                return false;
            }));

        return true;
    },
});
Signals.addSignalMethods(AppStoreIcon.prototype);

const AppIconMenu = new Lang.Class({
    Name: 'AppIconMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(source) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        this.parent(source.actor, 0.5, side);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;

        this.connect('activate', Lang.bind(this, this._onActivate));

        this.actor.add_style_class_name('app-well-menu');

        // Chain our visibility and lifecycle to that of the source
        source.actor.connect('notify::mapped', Lang.bind(this, function () {
            if (!source.actor.mapped)
                this.close();
        }));
        source.actor.connect('destroy', Lang.bind(this, function () { this.actor.destroy(); }));

        Main.uiGroup.add_actor(this.actor);
    },

    _redisplay: function() {
        this.removeAll();

        let windows = this._source.app.get_windows();

        // Display the app windows menu items and the separator between windows
        // of the current desktop and other windows.
        let activeWorkspace = global.screen.get_active_workspace();
        let separatorShown = windows.length > 0 && windows[0].get_workspace() != activeWorkspace;

        for (let i = 0; i < windows.length; i++) {
            if (!separatorShown && windows[i].get_workspace() != activeWorkspace) {
                this._appendSeparator();
                separatorShown = true;
            }
            let item = this._appendMenuItem(windows[i].title);
            item._window = windows[i];
        }

        if (!this._source.app.is_window_backed()) {
            if (windows.length > 0)
                this._appendSeparator();

            let isFavorite = AppFavorites.getAppFavorites().isFavorite(this._source.app.get_id());

            this._newWindowMenuItem = this._appendMenuItem(_("New Window"));
            this._appendSeparator();

            this._toggleFavoriteMenuItem = this._appendMenuItem(isFavorite ? _("Remove from Favorites")
                                                                : _("Add to Favorites"));
        }
    },

    _appendSeparator: function () {
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);
    },

    _appendMenuItem: function(labelText) {
        // FIXME: app-well-menu-item style
        let item = new PopupMenu.PopupMenuItem(labelText);
        this.addMenuItem(item);
        return item;
    },

    popup: function(activatingButton) {
        this._redisplay();
        this.open();
    },

    _onActivate: function (actor, child) {
        if (child._window) {
            let metaWindow = child._window;
            this.emit('activate-window', metaWindow);
        } else if (child == this._newWindowMenuItem) {
            this._source.app.open_new_window(-1);
            this.emit('activate-window', null);
        } else if (child == this._toggleFavoriteMenuItem) {
            let favs = AppFavorites.getAppFavorites();
            let isFavorite = favs.isFavorite(this._source.app.get_id());
            if (isFavorite)
                favs.removeFavorite(this._source.app.get_id());
            else
                favs.addFavorite(this._source.app.get_id());
        }
        this.close();
    }
});
Signals.addSignalMethods(AppIconMenu.prototype);
