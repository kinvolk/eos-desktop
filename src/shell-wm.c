/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "shell-wm.h"
#include "shell-global.h"
#include "shell-marshal.h"

struct _ShellWM {
  GObject parent;

  MutterPlugin *plugin;
  GList *switch_workspace_actors;
};

/* Signals */
enum
{
#ifdef NOT_YET
  MINIMIZE,
  KILL_MINIMIZE,
  MAXIMIZE,
  KILL_MAXIMIZE,
  UNMAXIMIZE,
  KILL_UNMAXIMIZE,
  MAP,
  KILL_MAP,
  DESTROY,
  KILL_DESTROY,
#endif
  SWITCH_WORKSPACE,
  KILL_SWITCH_WORKSPACE,

  LAST_SIGNAL
};

G_DEFINE_TYPE(ShellWM, shell_wm, G_TYPE_OBJECT);

static void shell_wm_set_switch_workspace_actors (ShellWM *wm,
                                                  GList   *actors);

static guint shell_wm_signals [LAST_SIGNAL] = { 0 };

static void
shell_wm_init (ShellWM *wm)
{
}

static void
shell_wm_finalize (GObject *object)
{
  ShellWM *wm = SHELL_WM (object);

  shell_wm_set_switch_workspace_actors (wm, NULL);

  G_OBJECT_CLASS (shell_wm_parent_class)->finalize (object);
}

static void
shell_wm_class_init (ShellWMClass *klass)
{
  GObjectClass *gobject_class = G_OBJECT_CLASS (klass);

  gobject_class->finalize = shell_wm_finalize;

  shell_wm_signals[SWITCH_WORKSPACE] =
    g_signal_new ("switch-workspace",
		  G_TYPE_FROM_CLASS (klass),
		  G_SIGNAL_RUN_LAST,
		  0,
		  NULL, NULL,
		  _shell_marshal_VOID__INT_INT_INT,
		  G_TYPE_NONE, 3,
                  G_TYPE_INT, G_TYPE_INT, G_TYPE_INT);
  shell_wm_signals[KILL_SWITCH_WORKSPACE] =
    g_signal_new ("kill-switch-workspace",
		  G_TYPE_FROM_CLASS (klass),
		  G_SIGNAL_RUN_LAST,
		  0,
		  NULL, NULL,
		  g_cclosure_marshal_VOID__VOID,
		  G_TYPE_NONE, 0);
}

void
_shell_wm_switch_workspace (ShellWM      *wm,
                            const GList **actors,
                            gint          from,
                            gint          to,
                            MetaMotionDirection direction)
{
  shell_wm_set_switch_workspace_actors (wm, (GList *)*actors);
  g_signal_emit (wm, shell_wm_signals[SWITCH_WORKSPACE], 0,
                 from, to, direction);
}

/**
 * shell_wm_get_switch_workspace_actors:
 * @wm: the #ShellWM
 *
 * A workaround for a missing feature in gobject-introspection. Returns
 * the list of windows involved in a switch-workspace operation (which
 * cannot be passed directly to the signal handler because there's no
 * way to annotate the element-type of a signal parameter.)
 *
 * Return value: (element-type MutterWindow) (transfer full): the list
 * of windows
 **/
GList *
shell_wm_get_switch_workspace_actors (ShellWM *wm)
{
  GList *l;

  for (l = wm->switch_workspace_actors; l; l = l->next)
    g_object_ref (l->data);
  return g_list_copy (wm->switch_workspace_actors);
}

static void
shell_wm_set_switch_workspace_actors (ShellWM *wm, GList *actors)
{
  const GList *l;

  for (l = wm->switch_workspace_actors; l; l = l->next)
    g_object_unref (l->data);
  g_list_free (wm->switch_workspace_actors);
  wm->switch_workspace_actors = g_list_copy (actors);
  for (l = wm->switch_workspace_actors; l; l = l->next)
    g_object_ref (l->data);
}

/**
 * shell_wm_completed_switch_workspace:
 * @wm: the ShellWM
 *
 * The plugin must call this when it has finished switching the
 * workspace.
 **/
void
shell_wm_completed_switch_workspace (ShellWM *wm)
{
  g_return_if_fail (wm->switch_workspace_actors != NULL);

  /* mutter_plugin_effect_completed() requires us to pass a window,
   * though it doesn't matter *which* window in this case.
   */
  mutter_plugin_effect_completed (wm->plugin,
                                  wm->switch_workspace_actors->data,
                                  MUTTER_PLUGIN_SWITCH_WORKSPACE);
  shell_wm_set_switch_workspace_actors (wm, NULL);
}


void
_shell_wm_kill_effect (ShellWM      *wm,
                       MutterWindow *actor,
                       gulong        events)
{
#ifdef NOT_YET
  if (events & MUTTER_PLUGIN_MINIMIZE)
    g_signal_emit (wm, shell_wm_signals[KILL_MINIMIZE], 0);
  if (events & MUTTER_PLUGIN_MAXIMIZE)
    g_signal_emit (wm, shell_wm_signals[KILL_MAXIMIZE], 0);
  if (events & MUTTER_PLUGIN_UNMAXIMIZE)
    g_signal_emit (wm, shell_wm_signals[KILL_UNMAXIMIZE], 0);
  if (events & MUTTER_PLUGIN_MAP)
    g_signal_emit (wm, shell_wm_signals[KILL_MAP], 0);
  if (events & MUTTER_PLUGIN_DESTROY)
    g_signal_emit (wm, shell_wm_signals[KILL_DESTROY], 0);
#endif
  if (events & MUTTER_PLUGIN_SWITCH_WORKSPACE)
    g_signal_emit (wm, shell_wm_signals[KILL_SWITCH_WORKSPACE], 0);
}


/**
 * shell_wm_new:
 * @plugin: the #MutterPlugin
 *
 * Creates a new window management interface by hooking into @plugin.
 *
 * Return value: the new window-management interface
 **/
ShellWM *
shell_wm_new (MutterPlugin *plugin)
{
  ShellWM *wm;

  wm = g_object_new (SHELL_TYPE_WM, NULL);
  wm->plugin = plugin;

  return wm;
}
