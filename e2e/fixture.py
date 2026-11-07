import os
import sys
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

if sys.argv[1:] != ['argument with spaces'] or os.environ.get('FIXTURE_VALUE') != 'present':
    raise RuntimeError('Launch arguments/environment were not preserved')
if os.getcwd() != os.path.dirname(os.path.abspath(__file__)):
    raise RuntimeError('Application working directory was not preserved')

window = Gtk.Window(title='Driver E2E Fixture')
window.set_default_size(640, 480)
window.connect('destroy', Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name('Message')
box.pack_start(entry, False, False, 0)
result = Gtk.Label(label='Result: initial')
button = Gtk.Button(label='Apply')
button.connect('clicked', lambda _: result.set_text('Result: ' + entry.get_text()))
box.pack_start(button, False, False, 0)
box.pack_start(result, False, False, 0)
box.pack_start(Gtk.Label(label='PID ' + str(os.getpid())), False, False, 0)
target = Gtk.Button(label='Transient target')
box.pack_start(target, False, False, 0)
remove = Gtk.Button(label='Remove target')
remove.connect('clicked', lambda _: target.destroy())
box.pack_start(remove, False, False, 0)

def show_dialog(_):
    dialog = Gtk.Dialog(title='Fixture dialog', transient_for=window, modal=True)
    dialog.add_button('Close', Gtk.ResponseType.CLOSE)
    dialog.connect('response', lambda child, response: child.destroy())
    dialog.show_all()

show = Gtk.Button(label='Show dialog')
show.connect('clicked', show_dialog)
box.pack_start(show, False, False, 0)
window.show_all()
Gtk.main()
