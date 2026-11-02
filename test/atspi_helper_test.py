import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest

sys.dont_write_bytecode = True
sys.modules['pyatspi'] = types.SimpleNamespace(STATE_DEFUNCT='defunct', STATE_ENABLED='enabled', STATE_SHOWING='showing')
spec = importlib.util.spec_from_file_location(
    'helper', Path(__file__).parent.parent / 'lib' / 'atspi_helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Node:
    def __init__(self, path, children=(), defunct=False):
        self.path = path
        self.app = types.SimpleNamespace(bus_name=':1.1')
        self.children = children
        self.childCount = len(children)
        self.defunct = defunct
        self.text = ''
        self.writes = []

    def getChildAtIndex(self, index):
        return self.children[index]

    def __iter__(self):
        return iter(self.children)

    def getState(self):
        return types.SimpleNamespace(contains=lambda state: self.defunct)

    def queryEditableText(self):
        return self

    def setTextContents(self, text):
        self.writes.append(text)
        self.text = text

    def queryText(self):
        return self

    def getText(self, start, end):
        return self.text


class SetTextTest(unittest.TestCase):
    def run_command(self, children, path=':1.1/saved'):
        helper.wait_for_app = lambda *args: Node('/app', children)
        helper.wait_for_elements = lambda *args: self.fail('Must not re-find by selector')
        command = dict(action='set_text', pid=1, path=path, index=0,
                       selector='duplicate', text='requested')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            with unittest.mock.patch.object(sys, 'stdin', io.StringIO(json.dumps(command))):
                helper.main()
        return json.loads(output.getvalue())

    def test_reordered_duplicate_uses_saved_path(self):
        other, saved = Node('/other'), Node('/saved')
        self.assertTrue(self.run_command([other, saved])['ok'])
        self.assertEqual(saved.writes, ['requested'])
        self.assertEqual(other.writes, [])

    def test_missing_target_never_writes_replacement(self):
        replacement = Node('/replacement')
        self.assertTrue(self.run_command([replacement])['stale'])
        self.assertEqual(replacement.writes, [])

    def test_defunct_target_is_stale(self):
        saved = Node('/saved', defunct=True)
        self.assertTrue(self.run_command([saved])['stale'])
        self.assertEqual(saved.writes, [])

    def test_disappearance_during_write_is_stale(self):
        saved = Node('/saved')

        def disappear(text):
            saved.defunct = True
            raise RuntimeError('Object disappeared')

        saved.setTextContents = disappear
        self.assertTrue(self.run_command([saved])['stale'])

    def test_missing_path_never_uses_index(self):
        saved = Node('/saved')
        self.assertTrue(self.run_command([saved], path=None)['stale'])
        self.assertEqual(saved.writes, [])


class ElementGeometryTest(unittest.TestCase):
    def test_nonvisual_object_has_no_actionable_bounds(self):
        node = Node('/node')

        def no_component():
            raise NotImplementedError()

        node.queryComponent = no_component
        command = dict(action='element_geometry', pid=1, path=':1.1/node')
        with unittest.mock.patch.object(helper, 'get_app', return_value=node):
            with unittest.mock.patch.object(sys, 'stdin', io.StringIO(json.dumps(command))):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    helper.main()
        result = json.loads(output.getvalue())
        self.assertTrue(result['ok'])
        self.assertFalse(result['visible'])
        self.assertEqual(result['rect'], dict(x=0, y=0, width=0, height=0))


class MergedLabelsTest(unittest.TestCase):
    def test_labels_match_whole_parts_only(self):
        self.assertTrue(helper.matches_label('room, message, 3', '3'))
        self.assertTrue(helper.matches_label('room, message, 3', 'room'))
        self.assertFalse(helper.matches_label('room, message, 13', '3'))


class ApplicationProvidersTest(unittest.TestCase):
    def test_xprop_parent_and_process_are_parsed_together(self):
        outputs = [
            '_NET_CLIENT_LIST(WINDOW): window id # 0x10, 0x20, 0x30',
            '_NET_WM_PID(CARDINAL) = 42\nWM_TRANSIENT_FOR: not found.',
            '_NET_WM_PID(CARDINAL) = 7\nWM_TRANSIENT_FOR(WINDOW): window id # 0x10',
            '_NET_WM_PID: not found.\nWM_TRANSIENT_FOR(WINDOW): window id # 0x10',
        ]
        with unittest.mock.patch.object(helper.subprocess, 'run',
                side_effect=[types.SimpleNamespace(stdout=value) for value in outputs]):
            self.assertEqual(helper.read_windows(), [(16, 42, None), (32, 7, 16)])

    def test_owned_portal_dialog_preserves_bus_identity(self):
        native, dialog = Node('/native'), Node('/dialog')
        portal = Node('/portal', [dialog])
        native.get_process_id = lambda: 42
        portal.get_process_id = lambda: 7
        dialog.app.bus_name = ':1.9'
        dialog.getState = lambda: types.SimpleNamespace(contains=lambda state: state == 'showing')
        with unittest.mock.patch.object(helper.pyatspi, 'Registry',
                types.SimpleNamespace(getDesktop=lambda _: [native, portal]), create=True):
            with unittest.mock.patch.object(helper, 'owned_dialog_processes', return_value={7}):
                group = helper.get_app(42)
        self.assertEqual(group.children, [native, dialog])
        self.assertIs(helper.find_by_path(group, ':1.9/dialog'), dialog)

    def test_unrelated_and_ambiguous_portals_are_excluded(self):
        for windows in [
            [(10, 42, None), (20, 7, None)],
            [(10, 42, None), (20, 7, 10), (21, 7, 999)],
            [(10, 42, None), (20, 7, 999)],
        ]:
            with self.subTest(windows=windows):
                with unittest.mock.patch.object(helper, 'read_windows', return_value=windows):
                    self.assertEqual(helper.owned_dialog_processes(42), set())

    def test_native_transient_parent_establishes_portal_ownership(self):
        with unittest.mock.patch.object(helper, 'read_windows',
                return_value=[(10, 42, None), (20, 7, 10), (30, 8, None)]):
            self.assertEqual(helper.owned_dialog_processes(42), {7})

    def test_disappearing_window_does_not_expose_foreign_process(self):
        with unittest.mock.patch.object(helper, 'read_windows', side_effect=OSError('gone')):
            self.assertEqual(helper.owned_dialog_processes(42), set())

    def test_process_providers_preserve_bus_identity(self):
        gtk = Node('/shared')
        native = Node('/shared')
        native.app.bus_name = ':1.2'
        group = helper.ApplicationGroup([gtk, native])
        self.assertIs(helper.find_by_path(group, ':1.2/shared'), native)
        self.assertIs(helper.find_by_path(group, ':1.1/shared'), gtk)
        self.assertIsNone(helper.find_by_path(group, ':1.3/shared'))

    def test_all_owned_providers_are_grouped(self):
        gtk, native, foreign = Node('/gtk'), Node('/native'), Node('/foreign')
        gtk.get_process_id = native.get_process_id = lambda: 42
        foreign.get_process_id = lambda: 7
        with unittest.mock.patch.object(helper.pyatspi, 'Registry',
                types.SimpleNamespace(getDesktop=lambda _: [gtk, foreign, native]), create=True):
            group = helper.get_app(42)
        self.assertEqual(group.children, [gtk, native])


if __name__ == '__main__':
    import unittest.mock
    unittest.main()
