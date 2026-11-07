import contextlib
import io
import json
import types
import unittest
from unittest.mock import patch
from atspi_helper_test import helper, Node


class Accessible(Node):
    def __init__(self, path, name='', children=(), role='entry', description='', states=()):
        super().__init__(path, children)
        self.name, self.description, self.role, self.states = name, description, role, states

    def getRoleName(self):
        return self.role

    def getState(self):
        return types.SimpleNamespace(contains=lambda state: state in self.states)

    def queryComponent(self):
        return types.SimpleNamespace(getExtents=lambda _: types.SimpleNamespace(x=10, y=20, width=80, height=40))


class HelperBehaviorTest(unittest.TestCase):
    def setUp(self):
        self.constants = patch.multiple(helper.pyatspi, DESKTOP_COORDS=0,
            STATE_EDITABLE='editable', STATE_FOCUSABLE='focusable', create=True)
        self.constants.start()
        self.addCleanup(self.constants.stop)

    def command(self, command, app):
        with patch.object(helper, 'get_app', return_value=app), patch.object(helper, 'wait_for_app', return_value=app):
            with patch('sys.stdin', io.StringIO(json.dumps(command))), contextlib.redirect_stdout(io.StringIO()) as output:
                helper.main()
        return json.loads(output.getvalue())

    def test_name_matches_description_and_text(self):
        for kwargs in [dict(name='target'), dict(description='target')]:
            with self.subTest(kwargs=kwargs):
                node = Accessible('/node', **kwargs)
                results = []
                helper.find_nodes(node, 'name', 'target', results)
                self.assertEqual(results, [node])
        node = Accessible('/text')
        node.text = 'target'
        results = []
        helper.find_nodes(node, 'name', 'target', results)
        self.assertEqual(results, [node])

    def test_xpath_exact_and_contains_match_accessible_labels(self):
        node = Accessible('/node', name='save item')
        for selector in ["//*[@name='save item']", "//*[contains(@name,'save')]"]:
            with self.subTest(selector=selector):
                results = []
                helper.find_nodes(node, 'xpath', selector, results)
                self.assertEqual(results, [node])

    def test_xpath_text_field_excludes_noneditable_entries(self):
        entry = Accessible('/editable', states={'editable'})
        root = Accessible('/root', children=[Accessible('/readonly'), entry], role='application')
        results = []
        helper.find_nodes(root, 'xpath', '//text-field', results)
        self.assertEqual(results, [entry])

    def test_lookup_limit_preserves_tree_order(self):
        nodes = [Accessible('/' + str(index), name='target') for index in range(4)]
        root = Accessible('/root', children=nodes)
        results = []
        helper.find_nodes(root, 'name', 'target', results, max_results=2)
        self.assertEqual(results, nodes[:2])

    def test_broken_child_does_not_hide_healthy_siblings(self):
        target = Accessible('/target', name='target')
        root = Accessible('/root', children=[None, target])
        results = []
        helper.find_nodes(root, 'name', 'target', results)
        self.assertEqual(results, [target])

    def test_tree_serialization_keeps_text_bounds_and_children(self):
        child = Accessible('/child', name='child')
        root = Accessible('/root', name='root', children=[child])
        root.text = 'value'
        tree = helper.node_to_dict(root)
        self.assertEqual(tree['name'], 'root')
        self.assertEqual(tree['value'], 'value')
        self.assertEqual(tree['bounds'], dict(x=10, y=20, w=80, h=40))
        self.assertEqual(tree['children'][0]['name'], 'child')
        self.assertIsNone(helper.node_to_dict(root, depth=2, max_depth=1))

    def test_unavailable_application_is_reported_by_lookup(self):
        result = self.command(dict(action='find_elements_once', pid=42, strategy='name', selector='target'), None)
        self.assertEqual(result, dict(ok=False, error='app not found'))

    def test_one_shot_lookup_publishes_bus_identity_and_center(self):
        target = Accessible('/target', name='target')
        result = self.command(dict(action='find_elements_once', pid=42, strategy='name', selector='target'), target)
        self.assertEqual(result['elements'][0]['path'], ':1.1/target')
        self.assertEqual((result['elements'][0]['cx'], result['elements'][0]['cy']), (50, 40))

    def test_click_uses_saved_connection_when_labels_are_duplicated(self):
        first, saved = Accessible('/first', name='button'), Accessible('/saved', name='button')
        app = Accessible('/app', children=[first, saved], role='application')
        with patch.object(helper, 'perform_action', return_value=(True, 'click')) as action:
            result = self.command(dict(action='click_element', pid=42, strategy='name', selector='button', path=':1.1/saved'), app)
        self.assertTrue(result['ok'])
        action.assert_called_once_with(saved)

    def test_missing_click_identity_never_acts_on_replacement(self):
        replacement = Accessible('/other', name='button')
        with patch.object(helper, 'perform_action') as action:
            result = self.command(dict(action='click_element', pid=42, strategy='name', selector='button', path=':1.1/gone'), replacement)
        self.assertTrue(result['stale'])
        action.assert_not_called()

    def test_preferred_click_action_wins_over_unrelated_first_action(self):
        node = Accessible('/button')
        invoked = []
        node.queryAction = lambda: types.SimpleNamespace(nActions=2,
            getName=lambda index: ['menu', 'click'][index], doAction=lambda index: invoked.append(index) or True)
        self.assertEqual(helper.perform_action(node), (True, 'click'))
        self.assertEqual(invoked, [1])

    def test_unavailable_action_reports_failure(self):
        self.assertEqual(helper.perform_action(Accessible('/node')), (False, None))

    def test_live_geometry_reports_visibility_and_enabled_state(self):
        target = Accessible('/node', states={'showing', 'enabled'})
        result = self.command(dict(action='element_geometry', pid=42, path=':1.1/node'), target)
        self.assertTrue(result['visible'])
        self.assertTrue(result['enabled'])
        self.assertEqual(result['rect'], dict(x=10, y=20, width=80, height=40))

    def test_stable_editable_text_failure_is_not_misreported_as_stale(self):
        target = Accessible('/node')
        target.queryEditableText = lambda: (_ for _ in ()).throw(RuntimeError('read only'))
        result = self.command(dict(action='set_text', pid=42, path=':1.1/node', text='requested'), target)
        self.assertFalse(result['ok'])
        self.assertFalse(result['stale'])
        self.assertEqual(result['error'], 'read only')

    def test_text_information_reads_current_value_and_attributes(self):
        target = Accessible('/node', name='Message', states={'enabled'})
        target.text = 'changed text'
        result = self.command(dict(action='element_info', pid=42, path=':1.1/node'), target)
        self.assertEqual(result['text'], 'changed text')
        self.assertEqual(result['attributes']['name'], 'Message')
        self.assertEqual(result['attributes']['value'], 'changed text')
        self.assertTrue(result['attributes']['enabled'])

    def test_text_information_uses_name_when_text_interface_is_unavailable(self):
        target = Accessible('/node', name='Apply')
        target.queryText = lambda: (_ for _ in ()).throw(NotImplementedError())
        result = self.command(dict(action='element_info', pid=42, path=':1.1/node'), target)
        self.assertEqual(result['text'], 'Apply')
        self.assertIsNone(result['attributes']['value'])

    def test_text_information_rejects_missing_identity(self):
        result = self.command(dict(action='element_info', pid=42, path=':1.1/missing'), Accessible('/other'))
        self.assertTrue(result['stale'])

    def test_app_wait_stops_at_deadline(self):
        with patch.object(helper, 'get_app', return_value=None), patch.object(helper.time, 'time', side_effect=[0, 0, 2]):
            with patch.object(helper.time, 'sleep'):
                self.assertIsNone(helper.wait_for_app(42, timeout=1))

    def test_element_wait_rechecks_tree_until_target_appears(self):
        target = Accessible('/node', name='target')
        with patch.object(helper, 'get_app', side_effect=[None, target]), patch.object(helper.time, 'sleep'):
            self.assertEqual(helper.wait_for_elements(42, 'name', 'target'), [target])


if __name__ == '__main__':
    unittest.main()
