// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gtk = imports.gi.Gtk;
const Meta = imports.gi.Meta;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const Lang = imports.lang;
const St = imports.gi.St;
const Shell = imports.gi.Shell;
const Gdk = imports.gi.Gdk;

const Background = imports.ui.background;
const Dash = imports.ui.dash;
const DND = imports.ui.dnd;
const LayoutManager = imports.ui.layout;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const OverviewControls = imports.ui.overviewControls;
const Panel = imports.ui.panel;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;
const ViewSelector = imports.ui.viewSelector;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;

// Time for initial animation going into Overview mode
const ANIMATION_TIME = 0.25;

// Must be less than ANIMATION_TIME, since we switch to
// or from the overview completely after ANIMATION_TIME,
// and don't want the shading animation to get cut off
const SHADE_ANIMATION_TIME = .20;

const DND_WINDOW_SWITCH_TIMEOUT = 1250;

const OVERVIEW_ACTIVATION_TIMEOUT = 0.5;

const ShellInfo = new Lang.Class({
    Name: 'ShellInfo',

    _init: function() {
        this._source = null;
        this._undoCallback = null;
    },

    _onUndoClicked: function() {
        if (this._undoCallback)
            this._undoCallback();
        this._undoCallback = null;

        if (this._source)
            this._source.destroy();
    },

    setMessage: function(text, options) {
        options = Params.parse(options, { undoCallback: null,
                                          forFeedback: false
                                        });

        let undoCallback = options.undoCallback;
        let forFeedback = options.forFeedback;

        if (this._source == null) {
            this._source = new MessageTray.SystemNotificationSource();
            this._source.connect('destroy', Lang.bind(this,
                function() {
                    this._source = null;
                }));
            Main.messageTray.add(this._source);
        }

        let notification = null;
        if (this._source.notifications.length == 0) {
            notification = new MessageTray.Notification(this._source, text, null);
            notification.setTransient(true);
            notification.setForFeedback(forFeedback);
        } else {
            notification = this._source.notifications[0];
            notification.update(text, null, { clear: true });
        }

        this._undoCallback = undoCallback;
        if (undoCallback) {
            notification.addButton('system-undo', _("Undo"));
            notification.connect('action-invoked', Lang.bind(this, this._onUndoClicked));
        }

        this._source.notify(notification);
    }
});

const Overview = new Lang.Class({
    Name: 'Overview',

    _init: function() {
        this._overviewCreated = false;
        this._initCalled = false;

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
    },

    _createOverview: function() {
        if (this._overviewCreated)
            return;

        if (this.isDummy)
            return;

        this._overviewCreated = true;

        // The main Background actors are inside global.window_group which are
        // hidden when displaying the overview, so we create a new
        // one. Instances of this class share a single CoglTexture behind the
        // scenes which allows us to show the background with different
        // rendering options without duplicating the texture data.
        let monitor = Main.layoutManager.primaryMonitor;

        this._desktopFade = new St.Bin();
        global.overlay_group.add_actor(this._desktopFade);

        let layout = new Clutter.BinLayout();
        this._stack = new Clutter.Actor({ layout_manager: layout });
        this._stack.add_constraint(new LayoutManager.MonitorConstraint({ primary: true }));

        /* Translators: This is the main view to select
           activities. See also note for "Activities" string. */
        this._overview = new St.BoxLayout({ name: 'overview',
                                            accessible_name: _("Overview"),
                                            reactive: true,
                                            vertical: true,
                                            x_expand: true,
                                            y_expand: true });
        this._overview._delegate = this;

        this._groupStack = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                           x_expand: true, y_expand: true,
                                           clip_to_allocation: true });
        this._group = new St.BoxLayout({ name: 'overview-group',
                                         reactive: true,
                                         x_expand: true, y_expand: true });
        this._groupStack.add_actor(this._group);

        this._backgroundGroup = new Meta.BackgroundGroup();
        global.overlay_group.add_child(this._backgroundGroup);
        this._backgroundGroup.hide();
        this._bgManagers = [];

        this._activationTime = 0;

        this.visible = false;           // animating to overview, in overview, animating out
        this._shown = false;            // show() and not hide()
        this._modal = false;            // have a modal grab
        this.animationInProgress = false;
        this.visibleTarget = false;

        // During transitions, we raise this to the top to avoid having the overview
        // area be reactive; it causes too many issues such as double clicks on
        // Dash elements, or mouseover handlers in the workspaces.
        this._coverPane = new Clutter.Rectangle({ opacity: 0,
                                                  reactive: true });
        this._overview.add_actor(this._coverPane);
        this._coverPane.connect('event', Lang.bind(this, function (actor, event) { return true; }));

        this._stack.hide();
        this._stack.add_actor(this._overview);
        global.overlay_group.add_actor(this._stack);

        this._coverPane.hide();

        // XDND
        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };

        Main.xdndHandler.connect('drag-begin', Lang.bind(this, this._onDragBegin));
        Main.xdndHandler.connect('drag-end', Lang.bind(this, this._onDragEnd));

        global.screen.connect('restacked', Lang.bind(this, this._onRestacked));
        this._group.connect('scroll-event', Lang.bind(this, this._onScrollEvent));

        this._windowSwitchTimeoutId = 0;
        this._windowSwitchTimestamp = 0;
        this._lastActiveWorkspaceIndex = -1;
        this._lastHoveredWindow = null;
        this._needsFakePointerEvent = false;

        if (this._initCalled)
            this.init();
    },

    _updateBackgrounds: function() {
        for (let i = 0; i < this._bgManagers.length; i++)
            this._bgManagers[i].destroy();

        this._bgManagers = [];

        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            // Note: do not set the vignette effect on the background;
            // we always want to display the background without modification.
            let bgManager = new Background.BackgroundManager({ container: this._backgroundGroup,
                                                               monitorIndex: i });
            this._bgManagers.push(bgManager);
        }
    },

    _sessionUpdated: function() {
        this.isDummy = !Main.sessionMode.hasOverview;
        this._createOverview();
    },

    // The members we construct that are implemented in JS might
    // want to access the overview as Main.overview to connect
    // signal handlers and so forth. So we create them after
    // construction in this init() method.
    init: function() {
        this._initCalled = true;

        if (this.isDummy)
            return;

        this._shellInfo = new ShellInfo();

        // Add a clone of the panel to the overview so spacing and such is
        // automatic
        this._topGhost = new St.Bin({ child: new Clutter.Clone({ source: Main.panel.actor }),
                                      reactive: false,
                                      opacity: 0 });

        this._overview.add_actor(this._topGhost);

        this._bottomGhost = new St.Bin({ child: new Clutter.Clone({ source: Main.panel.actor }),
                                      reactive: false,
                                      opacity: 0 });

        this._searchEntry = new St.Entry({ name: 'searchEntry',
                                           /* Translators: this is the text displayed
                                              in the search entry when no search is
                                              active; it should not exceed ~30
                                              characters. */
                                           hint_text: _("Type to search…"),
                                           track_hover: true,
                                           can_focus: true });
        this._searchEntryBin = new St.Bin({ child: this._searchEntry,
                                            x_align: St.Align.MIDDLE });

        // Create controls
        this._dash = new Dash.Dash();
        this._viewSelector = new ViewSelector.ViewSelector(this._searchEntry,
                                                           this._dash.showAppsButton);
        this._thumbnailsBox = new WorkspaceThumbnail.ThumbnailsBox();
        this._controls = new OverviewControls.ControlsManager(this._dash,
                                                              this._thumbnailsBox,
                                                              this._viewSelector);

        this._controls.dashActor.x_align = Clutter.ActorAlign.START;
        this._controls.dashActor.y_expand = true;

        // Put the dash in a separate layer to allow content to be centered
        this._groupStack.add_actor(this._controls.dashActor);

        // Pack all the actors into the group
        this._group.add_actor(this._controls.dashSpacer);
        this._group.add(this._viewSelector.actor, { x_fill: true,
                                                    expand: true });
        this._group.add_actor(this._controls.thumbnailsActor);

        // Add our same-line elements after the search entry
        this._overview.add(this._groupStack, { y_fill: true, expand: true });

        // Add the search bar below the view selector and the panel
        // ghost to give some spacing
        this._overview.add_actor(this._searchEntryBin);
        this._overview.add_actor(this._bottomGhost);

        this._stack.add_actor(this._controls.indicatorActor);

        // TODO - recalculate everything when desktop size changes
        this.dashIconSize = this._dash.iconSize;
        this._dash.connect('icon-size-changed',
                           Lang.bind(this, function() {
                               this.dashIconSize = this._dash.iconSize;
                           }));

        Main.layoutManager.connect('monitors-changed', Lang.bind(this, this._relayout));
        this._relayout();
    },

    //
    // options:
    //  - undoCallback (function): the callback to be called if undo support is needed
    //  - forFeedback (boolean): whether the message is for direct feedback of a user action
    //
    setMessage: function(text, options) {
        if (this.isDummy)
            return;

        this._shellInfo.setMessage(text, options);
    },

    _onDragBegin: function() {
        this._inXdndDrag = true;

        DND.addDragMonitor(this._dragMonitor);
        // Remember the workspace we started from
        this._lastActiveWorkspaceIndex = global.screen.get_active_workspace_index();
    },

    _onDragEnd: function(time) {
        this._inXdndDrag = false;

        // In case the drag was canceled while in the overview
        // we have to go back to where we started and hide
        // the overview
        if (this._shown) {
            global.screen.get_workspace_by_index(this._lastActiveWorkspaceIndex).activate(time);
            this.hide();
        }
        this._resetWindowSwitchTimeout();
        this._lastHoveredWindow = null;
        DND.removeDragMonitor(this._dragMonitor);
        this.endItemDrag();
    },

    _resetWindowSwitchTimeout: function() {
        if (this._windowSwitchTimeoutId != 0) {
            Mainloop.source_remove(this._windowSwitchTimeoutId);
            this._windowSwitchTimeoutId = 0;
            this._needsFakePointerEvent = false;
        }
    },

    _fakePointerEvent: function() {
        let display = Gdk.Display.get_default();
        let deviceManager = display.get_device_manager();
        let pointer = deviceManager.get_client_pointer();
        let [screen, pointerX, pointerY] = pointer.get_position();

        pointer.warp(screen, pointerX, pointerY);
    },

    _onDragMotion: function(dragEvent) {
        let targetIsWindow = dragEvent.targetActor &&
                             dragEvent.targetActor._delegate &&
                             dragEvent.targetActor._delegate.metaWindow &&
                             !(dragEvent.targetActor._delegate instanceof WorkspaceThumbnail.WindowClone);

        this._windowSwitchTimestamp = global.get_current_time();

        if (targetIsWindow &&
            dragEvent.targetActor._delegate.metaWindow == this._lastHoveredWindow)
            return DND.DragMotionResult.CONTINUE;

        this._lastHoveredWindow = null;

        this._resetWindowSwitchTimeout();

        if (targetIsWindow) {
            this._lastHoveredWindow = dragEvent.targetActor._delegate.metaWindow;
            this._windowSwitchTimeoutId = Mainloop.timeout_add(DND_WINDOW_SWITCH_TIMEOUT,
                                            Lang.bind(this, function() {
                                                this._needsFakePointerEvent = true;
                                                Main.activateWindow(dragEvent.targetActor._delegate.metaWindow,
                                                                    this._windowSwitchTimestamp);
                                                this.hide();
                                                this._lastHoveredWindow = null;
                                            }));
        }

        return DND.DragMotionResult.CONTINUE;
    },

    _onScrollEvent: function(actor, event) {
        this.emit('scroll-event', event);
    },

    addAction: function(action) {
        if (this.isDummy)
            return;

        this._overview.add_action(action);
    },

    _getDesktopClone: function() {
        let windows = global.get_window_actors().filter(function(w) {
            return w.meta_window.get_window_type() == Meta.WindowType.DESKTOP;
        });
        if (windows.length == 0)
            return null;

        let window = windows[0];
        let clone = new Clutter.Clone({ source: window.get_texture(),
                                        x: window.x, y: window.y });
        clone.source.connect('destroy', Lang.bind(this, function() {
            clone.destroy();
        }));
        return clone;
    },

    _relayout: function () {
        // To avoid updating the position and size of the workspaces
        // we just hide the overview. The positions will be updated
        // when it is next shown.
        this.hide();

        let workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);

        this._coverPane.set_position(0, workArea.y);
        this._coverPane.set_size(workArea.width, workArea.height);

        this._updateBackgrounds();
    },

    _onRestacked: function() {
        let stack = global.get_window_actors();
        let stackIndices = {};

        for (let i = 0; i < stack.length; i++) {
            // Use the stable sequence for an integer to use as a hash key
            stackIndices[stack[i].get_meta_window().get_stable_sequence()] = i;
        }

        this.emit('windows-restacked', stackIndices);
    },

    //// Public methods ////

    beginItemDrag: function(source) {
        this.emit('item-drag-begin', source);
    },

    cancelledItemDrag: function(source) {
        this.emit('item-drag-cancelled', source);
    },

    endItemDrag: function(source) {
        this.emit('item-drag-end', source);
    },

    beginWindowDrag: function(source) {
        this.emit('window-drag-begin');
    },

    cancelledWindowDrag: function(source) {
        this.emit('window-drag-cancelled');
    },

    endWindowDrag: function(source) {
        this.emit('window-drag-end');
    },

    // show:
    //
    // Animates the overview visible and grabs mouse and keyboard input
    show : function() {
        if (this.isDummy)
            return;
        if (this._shown)
            return;
        this._shown = true;

        if (!this._syncInputMode())
            return;

        this._animateVisible();
    },

    showApps : function() {
        this.emit('show-apps-request');
    },

    fadeInDesktop: function() {
            this._desktopFade.opacity = 0;
            this._desktopFade.show();
            Tweener.addTween(this._desktopFade,
                             { opacity: 255,
                               time: ANIMATION_TIME,
                               transition: 'easeOutQuad' });
    },

    fadeOutDesktop: function() {
        if (!this._desktopFade.child)
            this._desktopFade.child = this._getDesktopClone();

        this._desktopFade.opacity = 255;
        this._desktopFade.show();
        Tweener.addTween(this._desktopFade,
                         { opacity: 0,
                           time: ANIMATION_TIME,
                           transition: 'easeOutQuad'
                         });
    },

    _animateVisible: function() {
        if (this.visible || this.animationInProgress)
            return;

        this.visible = true;
        this.animationInProgress = true;
        this.visibleTarget = true;
        this._activationTime = Date.now() / 1000;

        // All the the actors in the window group are completely obscured,
        // hiding the group holding them while the Overview is displayed greatly
        // increases performance of the Overview especially when there are many
        // windows visible.
        //
        // If we switched to displaying the actors in the Overview rather than
        // clones of them, this would obviously no longer be necessary.
        //
        // Disable unredirection while in the overview
        Meta.disable_unredirect_for_screen(global.screen);
        this._stack.show();
        this._backgroundGroup.show();
        this._viewSelector.show();

        this._stack.opacity = 0;
        Tweener.addTween(this._stack,
                         { opacity: 255,
                           transition: 'easeOutQuad',
                           time: ANIMATION_TIME,
                           onComplete: this._showDone,
                           onCompleteScope: this
                         });

        this._coverPane.raise_top();
        this._coverPane.show();
        this.emit('showing');
    },

    // hide:
    //
    // Reverses the effect of show()
    hide: function() {
        if (this.isDummy)
            return;

        if (!this._shown)
            return;

        let event = Clutter.get_current_event();
        if (event) {
            let type = event.type();
            let button = (type == Clutter.EventType.BUTTON_PRESS ||
                          type == Clutter.EventType.BUTTON_RELEASE);
            let ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) != 0;
            if (button && ctrl)
                return;
        }

        this._animateNotVisible();

        this._shown = false;
        this._syncInputMode();
    },

    hideOrShowApps: function() {
        if (!this._initCalled) {
            return;
        }

        let visibleWindows = Main.workspaceMonitor.visibleWindows;
        if (visibleWindows == 0) {
            this.showApps();
        } else {
            this.hide();
        }
    },

    toggleByKey: function() {
        if (this._viewSelector.getActivePage() != ViewSelector.ViewPage.APPS) {
            this.toggle();
        }
    },

    toggle: function() {
        if (this.isDummy)
            return;

        if (this.visible)
            this.hideOrShowApps();
        else
            this.show();
    },

    // Checks if the Activities button is currently sensitive to
    // clicks. The first call to this function within the
    // OVERVIEW_ACTIVATION_TIMEOUT time of the hot corner being
    // triggered will return false. This avoids opening and closing
    // the overview if the user both triggered the hot corner and
    // clicked the Activities button.
    shouldToggleByCornerOrButton: function() {
        if (this.animationInProgress)
            return false;
        if (this._activationTime == 0 || Date.now() / 1000 - this._activationTime > OVERVIEW_ACTIVATION_TIMEOUT)
            return true;
        return false;
    },

    //// Private methods ////

    _syncInputMode: function() {
        // We delay input mode changes during animation so that when removing the
        // overview we don't have a problem with the release of a press/release
        // going to an application.
        if (this.animationInProgress)
            return true;

        if (this._shown) {
            let shouldBeModal = !this._inXdndDrag;
            if (shouldBeModal) {
                if (!this._modal) {
                    if (Main.pushModal(this._overview,
                                       { keybindingMode: Shell.KeyBindingMode.OVERVIEW })) {
                        this._modal = true;
                    } else {
                        this.hide();
                        return false;
                    }
                }
            } else {
                global.stage_input_mode = Shell.StageInputMode.FULLSCREEN;
            }
        } else {
            if (this._modal) {
                Main.popModal(this._overview);
                this._modal = false;
            }
            else if (global.stage_input_mode == Shell.StageInputMode.FULLSCREEN)
                global.stage_input_mode = Shell.StageInputMode.NORMAL;
        }
        return true;
    },

    _animateNotVisible: function() {
        if (!this.visible || this.animationInProgress)
            return;

        this.animationInProgress = true;
        this.visibleTarget = false;

        this._viewSelector.zoomFromOverview();

        // Make other elements fade out.
        Tweener.addTween(this._stack,
                         { opacity: 0,
                           transition: 'easeOutQuad',
                           time: ANIMATION_TIME,
                           onComplete: this._hideDone,
                           onCompleteScope: this
                         });

        this._coverPane.raise_top();
        this._coverPane.show();
        this.emit('hiding');
    },

    _showDone: function() {
        this.animationInProgress = false;
        this._desktopFade.hide();
        this._coverPane.hide();

        this.emit('shown');
        // Handle any calls to hide* while we were showing
        if (!this._shown)
            this._animateNotVisible();

        this._syncInputMode();
        global.sync_pointer();
    },

    _hideDone: function() {
        // Re-enable unredirection
        Meta.enable_unredirect_for_screen(global.screen);

        this._viewSelector.hide();
        this._desktopFade.hide();
        this._backgroundGroup.hide();
        this._stack.hide();

        this.visible = false;
        this.animationInProgress = false;

        this._coverPane.hide();

        this.emit('hidden');
        // Handle any calls to show* while we were hiding
        if (this._shown)
            this._animateVisible();

        this._syncInputMode();

        // Fake a pointer event if requested
        if (this._needsFakePointerEvent) {
            this._fakePointerEvent();
            this._needsFakePointerEvent = false;
        }
    }
});
Signals.addSignalMethods(Overview.prototype);
